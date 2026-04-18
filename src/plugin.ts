/**
 * plugin.ts — Signal K plugin entry point for EmpirBus HVAC integration.
 *
 * Lifecycle:
 *   start() kicks off a poll loop: connect → register → two-pass zone cycle →
 *   disconnect → sleep pollIntervalMs → repeat. Re-registering each interval
 *   avoids fighting the MCU's ~2s session timeout and lets us poll as
 *   infrequently as we want. stop() aborts the loop and disconnects.
 *
 * Write support (setpoint / fan speed PUT handlers) is not yet implemented.
 */

import {
  RESPONSE_TIMEOUT_MS,
  YdwgGateway,
  SocketCanTransport,
  HvacSession,
  type CanTransport,
} from './hvac_core';

// ── Signal K surface we use ───────────────────────────────────────────────
interface SignalKApp {
  debug: (msg: string) => void;
  error: (msg: string) => void;
  handleMessage: (pluginId: string, delta: Delta) => void;
  setPluginStatus: (msg: string) => void;
  setPluginError: (msg: string) => void;
}

interface DeltaValue {
  path:  string;
  value: number | string | object | null;
}

interface Delta {
  updates: Array<{
    timestamp?: string;
    values:     DeltaValue[];
  }>;
}

// ── Plugin options (schema below) ─────────────────────────────────────────
interface PluginOptions {
  transport:       'ydwg' | 'socketcan';
  ydwgHost:        string;
  ydwgPort:        number;
  socketcanIface:  string;
  pollIntervalMs:  number;
  mcuSrc:          number;
  mySrc:           number;
}

const PLUGIN_ID = 'signalk-empirbus-hvac';
const CELSIUS_TO_KELVIN = 273.15;

// Convert "Crew Cabin" → "crewCabin" for Signal K path segments.
function zoneSlug(name: string): string {
  const words = name.trim().split(/\s+/);
  return words
    .map((w, i) => i === 0
      ? w.toLowerCase()
      : w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function makeTransport(options: PluginOptions): CanTransport {
  return options.transport === 'socketcan'
    ? new SocketCanTransport(options.socketcanIface)
    : new YdwgGateway({ host: options.ydwgHost, port: options.ydwgPort });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export = function(app: SignalKApp) {
  let abortController: AbortController | null = null;
  let activeSession:   HvacSession | null     = null;

  function publishZone(zoneName: string, zones: Record<string, number>) {
    const slug = zoneSlug(zoneName);
    const values: DeltaValue[] = [];

    if (zones['actual_temp'] !== undefined) {
      values.push({
        path:  `environment.inside.${slug}.temperature`,
        value: zones['actual_temp'] + CELSIUS_TO_KELVIN,
      });
    }
    if (zones['setpoint'] !== undefined) {
      values.push({
        path:  `environment.inside.${slug}.temperature.setpoint`,
        value: zones['setpoint'] + CELSIUS_TO_KELVIN,
      });
    }
    if (zones['fan_speed'] !== undefined) {
      values.push({
        path:  `environment.inside.${slug}.fan.speed`,
        value: zones['fan_speed'],
      });
    }

    if (values.length === 0) return;
    app.handleMessage(PLUGIN_ID, {
      updates: [{
        timestamp: new Date().toISOString(),
        values,
      }],
    });
  }

  async function pollLoop(options: PluginOptions, signal: AbortSignal) {
    // Clamp defensively — missing/zero/negative values from stale saved
    // settings would otherwise spin the loop with no sleep between polls.
    const pollMs = Math.max(20000, options.pollIntervalMs || 600000);

    while (!signal.aborted) {
      const session = new HvacSession({
        transport: makeTransport(options),
        mcuSrc:    options.mcuSrc,
        mySrc:     options.mySrc,
        logger:    (msg) => app.debug(msg),
      });
      activeSession = session;

      try {
        app.setPluginStatus('Connecting to MCU...');
        await session.start();
        if (signal.aborted) break;

        app.setPluginStatus('Polling zones...');
        await session.cycleZones({
          startZone:        0,
          passes:           2,
          overallTimeoutMs: RESPONSE_TIMEOUT_MS,
          signal,
          onZone:           publishZone,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        app.error(`Poll failed: ${msg}`);
      } finally {
        session.stop();
        activeSession = null;
      }

      if (signal.aborted) break;

      const nextAt = new Date(Date.now() + pollMs);
      app.setPluginStatus(`Idle — next poll at ${nextAt.toLocaleTimeString()}`);
      await abortableSleep(pollMs, signal);
    }
    app.setPluginStatus('Stopped');
  }

  return {
    id:          PLUGIN_ID,
    name:        'EmpirBus HVAC',
    description: 'Reads HVAC zone temperatures from an EmpirBus MCU-150 over NMEA 2000.',

    schema: {
      type: 'object',
      required: ['transport'],
      properties: {
        transport: {
          type:        'string',
          title:       'CAN transport',
          enum:        ['ydwg', 'socketcan'],
          default:     'ydwg',
          description: 'ydwg = Yacht Devices YDWG-02 TCP gateway; socketcan = Linux SocketCAN interface',
        },
        ydwgHost: {
          type:    'string',
          title:   'YDWG-02 host',
          default: '192.168.1.1',
        },
        ydwgPort: {
          type:    'number',
          title:   'YDWG-02 TCP port',
          default: 1457,
        },
        socketcanIface: {
          type:    'string',
          title:   'SocketCAN interface name',
          default: 'can0',
        },
        pollIntervalMs: {
          type:        'number',
          title:       'Poll interval (ms)',
          default:     600000,
          minimum:     20000,
          description: 'How often to reconnect and cycle all zones. Each poll takes ~15s of bus activity. Default 600000 = 10 min.',
        },
        mcuSrc: {
          type:        'number',
          title:       'MCU N2K source address',
          default:     3,
          minimum:     0,
          maximum:     251,
          description: 'N2K source address of the EmpirBus MCU-150 on the bus. Default 3 matches the Azimut 60 Fly factory configuration.',
        },
        mySrc: {
          type:        'number',
          title:       'Our N2K source address',
          default:     11,
          minimum:     0,
          maximum:     251,
          description: 'N2K source address this plugin claims for itself on the bus. Must not collide with any other device.',
        },
      },
    },

    start(options: PluginOptions) {
      abortController = new AbortController();
      pollLoop(options, abortController.signal).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        app.error(`Poll loop crashed: ${msg}`);
        app.setPluginError(`Poll loop crashed: ${msg}`);
      });
    },

    stop() {
      abortController?.abort();
      activeSession?.stop();
      activeSession   = null;
      abortController = null;
    },
  };
};
