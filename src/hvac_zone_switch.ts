#!/usr/bin/env ts-node
/**
 * hvac_zone_switch.ts — CLI for polling HVAC zone temperatures from an
 * EmpirBus MCU-150. Thin wrapper around HvacSession in hvac_core.ts;
 * intended for testing and debugging independent of the Signal K plugin.
 *
 * Usage (YDWG-02, default):
 *   YDWG_HOST=192.168.1.x YDWG_PORT=1457 ts-node hvac_zone_switch.ts [zone] [--mcu=N] [--my-src=N] [--zones=file.json]
 *
 * Usage (SocketCAN):
 *   SOCKETCAN_IFACE=can0 ts-node hvac_zone_switch.ts [zone] [--mcu=N] [--my-src=N] [--zones=file.json]
 *
 * Zone index (optional — defaults to 0 as starting zone). Defaults are the
 * Azimut 60 Fly zones; use --zones to load a different boat's set.
 *
 * --mcu=N / --mcu-src=N: N2K source address of the MCU (default 3).
 * --my-src=N:            N2K source address we claim for ourselves (default 11).
 * --zones=FILE:          JSON file with [{"name": "...", "action": 250}, ...]
 *
 * Set DEBUG=1 to dump every raw CAN frame read/written.
 */

import * as fs from 'fs';
import {
  DEFAULT_ZONES,
  RESPONSE_TIMEOUT_MS,
  YdwgGateway,
  SocketCanTransport,
  HvacSession,
  type CanTransport,
  type Zone,
} from './hvac_core';

const toF = (c: number) => Math.round((c * 9 / 5 + 32) * 10) / 10;

interface ParsedArgs {
  startZone: number;
  mcuSrc:    number;
  mySrc:     number;
  zonesFile: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let mcuSrc    = 3;
  let mySrc     = 11;
  let zonesFile: string | null = null;
  const positional: string[] = [];
  for (const arg of argv) {
    let m;
    if ((m = arg.match(/^--mcu(?:-src)?=(\d+)$/))) { mcuSrc = parseInt(m[1]!, 10); continue; }
    if ((m = arg.match(/^--my-src=(\d+)$/)))       { mySrc  = parseInt(m[1]!, 10); continue; }
    if ((m = arg.match(/^--zones=(.+)$/)))         { zonesFile = m[1]!;            continue; }
    positional.push(arg);
  }
  const startZone = parseInt(positional[0] ?? '0', 10);
  return { startZone, mcuSrc, mySrc, zonesFile };
}

function loadZones(path: string): Zone[] {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${path}: expected a non-empty array of {name, action} objects`);
  }
  for (const z of raw) {
    if (typeof z?.name !== 'string' || typeof z?.action !== 'number') {
      throw new Error(`${path}: each zone must have string "name" and number "action" (got ${JSON.stringify(z)})`);
    }
    if (z.action < 0 || z.action > 255) {
      throw new Error(`${path}: action byte out of range 0-255: ${z.action}`);
    }
  }
  return raw as Zone[];
}

async function main() {
  const { startZone, mcuSrc, mySrc, zonesFile } = parseArgs(process.argv.slice(2));

  const zones: Zone[] = zonesFile ? loadZones(zonesFile) : DEFAULT_ZONES;

  if (isNaN(startZone) || startZone < 0 || startZone >= zones.length) {
    console.error(`Usage: hvac_zone_switch.ts [zone 0-${zones.length - 1}] [--mcu=N] [--my-src=N] [--zones=file.json]`);
    zones.forEach((z, i) => console.error(`  ${i} = ${z.name} (action 0x${z.action.toString(16)})`));
    process.exit(1);
  }
  if (isNaN(mcuSrc) || mcuSrc < 0 || mcuSrc > 251) {
    console.error(`Invalid --mcu value: must be 0-251 (got ${mcuSrc})`);
    process.exit(1);
  }
  if (isNaN(mySrc) || mySrc < 0 || mySrc > 251) {
    console.error(`Invalid --my-src value: must be 0-251 (got ${mySrc})`);
    process.exit(1);
  }

  console.log(`[*] Zones (${zones.length}): ${zones.map(z => z.name).join(', ')}`);
  console.log(`[*] Starting zone: ${zones[startZone]!.name} (${startZone})`);
  console.log(`[*] MCU source address: ${mcuSrc}`);
  console.log(`[*] Our source address: ${mySrc}`);

  const socketcanIface = process.env.SOCKETCAN_IFACE;
  let transport: CanTransport;
  if (socketcanIface) {
    const sc = new SocketCanTransport(socketcanIface);
    transport = sc;
    console.log(`[*] Opening SocketCAN interface ${sc.iface}`);
  } else {
    const gw = new YdwgGateway();
    transport = gw;
    console.log(`[*] Gateway: ${gw.host}:${gw.port}`);
  }

  const session = new HvacSession({
    transport,
    mcuSrc,
    mySrc,
    zones,
    logger: (msg) => console.log(msg),
  });

  await session.start();

  console.log('[*] Collecting thermostat data (cycling all zones, up to 2 passes)...');
  const allZones = await session.cycleZones({
    startZone,
    passes: 2,
    overallTimeoutMs: RESPONSE_TIMEOUT_MS,
    onZone: (zoneName, data) => {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith('refrig')) continue;
        if (k === 'setpoint' || k === 'actual_temp') {
          parts.push(`${k}=${v.toFixed(2)}°C (${toF(v)}°F)`);
        } else {
          parts.push(`${k}=${v}`);
        }
      }
      if (parts.length > 0) console.log(`    ★ ${zoneName}: ${parts.join(', ')}`);
    },
  });

  console.log('');
  if (Object.keys(allZones).length > 0) {
    console.log('=== Summary: thermostat data collected ===');
    const ordered = [
      startZone,
      ...Array.from({ length: zones.length }, (_, i) => i).filter(i => i !== startZone),
    ];
    const pad = Math.max(...zones.map(z => z.name.length));
    for (const i of ordered) {
      const zname = zones[i]!.name;
      const zdata = allZones[zname];
      if (zdata) {
        const parts: string[] = [];
        if (zdata.actual_temp !== undefined)
          parts.push(`actual_temp=${zdata.actual_temp.toFixed(2)}°C (${toF(zdata.actual_temp).toFixed(0)}°F)`);
        if (zdata.setpoint !== undefined)
          parts.push(`setpoint=${zdata.setpoint.toFixed(2)}°C (${toF(zdata.setpoint).toFixed(0)}°F)`);
        if (zdata.fan_speed !== undefined)
          parts.push(`fan_speed=${zdata.fan_speed / 1000}`);
        console.log(`  ${zname.padEnd(pad)} ${parts.join(', ')}`);
      } else {
        console.log(`  ${zname.padEnd(pad)} (no data received)`);
      }
    }
  } else {
    console.log(`    ✗ No thermostat data received within ${RESPONSE_TIMEOUT_MS}ms`);
  }

  session.stop();
  console.log('[*] Done');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
