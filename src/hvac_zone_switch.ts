#!/usr/bin/env ts-node
/**
 * hvac_zone_switch.ts — CLI for polling HVAC zone temperatures from an
 * EmpirBus MCU-150. Thin wrapper around HvacSession in hvac_core.ts;
 * intended for testing and debugging independent of the Signal K plugin.
 *
 * Usage (YDWG-02, default):
 *   YDWG_HOST=192.168.1.x YDWG_PORT=1457 ts-node hvac_zone_switch.ts [zone]
 *
 * Usage (SocketCAN):
 *   SOCKETCAN_IFACE=can0 ts-node hvac_zone_switch.ts [zone]
 *
 * Zone numbers (optional — defaults to 0/Salon as starting zone):
 *   0 = Salon   1 = Helm   2 = Guest   3 = VIP   4 = Owner
 *
 * Set DEBUG=1 to dump every raw CAN frame read/written.
 */

import {
  ZONE_NAMES,
  RESPONSE_TIMEOUT_MS,
  YdwgGateway,
  SocketCanTransport,
  HvacSession,
  type CanTransport,
} from './hvac_core';

const toF = (c: number) => Math.round((c * 9 / 5 + 32) * 10) / 10;

async function main() {
  const zoneArg = parseInt(process.argv[2] ?? '0', 10);
  if (isNaN(zoneArg) || zoneArg < 0 || zoneArg > 4) {
    console.error('Usage: hvac_zone_switch.ts [zone 0-4]');
    ZONE_NAMES.forEach((n, i) => console.error(`  ${i} = ${n}`));
    process.exit(1);
  }

  const startZone = zoneArg;
  console.log(`[*] Starting zone: ${ZONE_NAMES[startZone]} (${startZone})`);

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
    logger: (msg) => console.log(msg),
  });

  await session.start();

  console.log('[*] Collecting thermostat data (cycling all zones, up to 2 passes)...');
  const allZones = await session.cycleZones({
    startZone,
    passes: 2,
    overallTimeoutMs: RESPONSE_TIMEOUT_MS,
    onZone: (zoneName, zones) => {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(zones)) {
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
      ...Array.from({ length: 6 }, (_, i) => i).filter(i => i !== startZone),
    ];
    for (const i of ordered) {
      const zname = ZONE_NAMES[i]!;
      const zdata = allZones[zname];
      if (zdata) {
        const parts: string[] = [];
        if (zdata.actual_temp !== undefined)
          parts.push(`actual_temp=${zdata.actual_temp.toFixed(2)}°C (${toF(zdata.actual_temp).toFixed(0)}°F)`);
        if (zdata.setpoint !== undefined)
          parts.push(`setpoint=${zdata.setpoint.toFixed(2)}°C (${toF(zdata.setpoint).toFixed(0)}°F)`);
        if (zdata.fan_speed !== undefined)
          parts.push(`fan_speed=${zdata.fan_speed / 1000}`);
        console.log(`  ${zname.padEnd(10)} ${parts.join(', ')}`);
      } else {
        console.log(`  ${zname.padEnd(10)} (no data received)`);
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
