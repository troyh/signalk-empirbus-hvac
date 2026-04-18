/**
 * plugin.ts — Signal K plugin entry point for EmpirBus HVAC integration.
 *
 * Wraps HvacSession (from hvac_core.ts) in the Signal K plugin lifecycle:
 * on start, connect to the CAN bus, register with the MCU, and continuously
 * cycle zones — publishing temperature / setpoint / fan-speed deltas as they
 * arrive. On stop, abort the cycle loop and disconnect.
 *
 * Write support (setpoint / fan speed PUT handlers) is not yet implemented.
 */

import {
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
}

const PLUGIN_ID = 'signalk-empirbus-hvac';

// Convert "Crew Cabin" → "crewCabin" for Signal K path segments.
function zoneSlug(name: string): string {
  const words = name.trim().split(/\s+/);
  return words
    .map((w, i) => i === 0
      ? w.toLowerCase()
      : w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

const CELSIUS_TO_KELVIN = 273.15;

export = function(app: SignalKApp) {
  let session:         HvacSession | null     = null;
  let abortController: AbortController | null = null;

  return {
    id:          PLUGIN_ID,
    name:        'EmpirBus HVAC',
    description: 'Reads HVAC zone temperatures from an EmpirBus MCU-150 over NMEA 2000.',

    schema: {
      type: 'object',
      required: ['transport'],
      properties: {
        transport: {
          type:    'string',
          title:   'CAN transport',
          enum:    ['ydwg', 'socketcan'],
          default: 'ydwg',
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
      },
    },

    async start(options: PluginOptions) {
      const transport: CanTransport = options.transport === 'socketcan'
        ? new SocketCanTransport(options.socketcanIface)
        : new YdwgGateway({ host: options.ydwgHost, port: options.ydwgPort });

      session = new HvacSession({
        transport,
        logger: (msg) => app.debug(msg),
      });

      try {
        app.setPluginStatus('Connecting to MCU...');
        await session.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        app.setPluginError(`Failed to start: ${msg}`);
        session = null;
        return;
      }

      abortController = new AbortController();
      app.setPluginStatus('Connected — cycling zones');

      session.cycleZones({
        startZone: 0,
        signal:    abortController.signal,
        onZone: (zoneName, zones) => {
          const slug   = zoneSlug(zoneName);
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

          if (values.length > 0) {
            app.handleMessage(PLUGIN_ID, {
              updates: [{
                timestamp: new Date().toISOString(),
                values,
              }],
            });
          }
        },
      })
        .then(() => { /* loop exited cleanly (signal aborted) */ })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          app.error(`Cycle loop failed: ${msg}`);
          app.setPluginError(`Cycle loop failed: ${msg}`);
        });
    },

    stop() {
      abortController?.abort();
      session?.stop();
      session         = null;
      abortController = null;
    },
  };
};
