#!/usr/bin/env ts-node
/**
 * hvac_zone_switch.ts — Poll all HVAC zone temperatures on an Azimut 60 Fly
 * (EmpirBus MCU-150) without requiring the Raymarine Axiom MFD to be active.
 *
 * Usage:
 *   ts-node hvac_zone_switch.ts [zone]
 *   node hvac_zone_switch.js [zone]
 *
 * Zone numbers (optional — defaults to 0/Salon as starting zone):
 *   0 = Salon   1 = Helm   2 = Guest   3 = VIP   4 = Owner
 *
 * Requires: npm install socketcan @types/node
 *
 * Protocol summary (reverse-engineered from bus captures):
 *   1. Address claim (PGN 60928) → Pi appears as N2K device
 *   2. ISO requests for PGNs 126996, 126464, 126998 → MCU grants session
 *   3. Two registration commands (11B b4=0x80, 13B b10=0x03)
 *   4. Wait for MCU state dump + thermostat broadcast (session confirmation)
 *   5. Cycle all 5 zones at 1.5s intervals (session times out at ~2s inactivity)
 *   6. Each zone switch triggers one thermostat broadcast from MCU
 *   7. Two passes to ensure all zones captured
 *
 * Zone data encoding:
 *   Temperature: uint24 LE at entry bytes [6:9], millikelvin
 *                celsius = (rawVal - 273150) / 1000
 *   Fan speed:   uint24 LE at entry bytes [6:9], raw value
 *
 * Not all zones include all fields (confirmed from captures):
 *   Salon/Helm:         setpoint + actual_temp + fan_speed
 *   VIP:                actual_temp + fan_speed (no setpoint)
 *   Guest/Owner:        actual_temp only
 */

import * as can from 'socketcan';

// ── Configuration ─────────────────────────────────────────────────────────────
const CAN_IFACE         = 'can0';
const MY_SRC            = 11;    // Our N2K source address
const MCU_SRC           = 3;     // EmpirBus MCU-150
const BROADCAST         = 255;

const ZONE_ACTIONS      = [0xfa, 0xfb, 0xfc, 0xfd, 0xfe];
const ZONE_NAMES        = ['Salon', 'Helm', 'Guest', 'VIP', 'Owner'];

const DISCOVERY_TIMEOUT_MS  = 2000;
const DUMP_WAIT_MS          = 3000;   // Max wait for registration state dump
const RESPONSE_TIMEOUT_MS   = 20000; // Two passes × 5 zones × 1.5s + buffer
const ZONE_INTERVAL_MS      = 1500;  // Inter-zone gap (session times out at ~2s)
const INTER_FRAME_MS        = 2;     // Gap between CAN frame sends
const INTER_SEND_MS         = 100;   // Gap between zone switch sends within a burst

const CAN_EFF_FLAG          = 0x80000000;

// ── Types ─────────────────────────────────────────────────────────────────────
interface CanFrame {
  id:   number;
  ext:  boolean;
  rtr:  boolean;
  data: Buffer;
}

interface ParsedFrame {
  canId: number;
  pgn:   number;
  src:   number;
  dst:   number;
  data:  Buffer;
}

interface ZoneData {
  setpoint?:    number | undefined;  // °C
  actual_temp?: number | undefined;  // °C
  fan_speed?:   number | undefined;  // raw
}

// ── CAN ID helpers ────────────────────────────────────────────────────────────
function buildCanId(priority: number, pgn: number, src: number, dst?: number): number {
  const pf = (pgn >> 8) & 0xFF;
  if (pf < 0xF0 && dst !== undefined) {
    return (priority << 26) | ((pgn & 0x3FF00) << 8) | (dst << 8) | src;
  } else {
    return (priority << 26) | (pgn << 8) | src;
  }
}

function parseCanId(canId: number): { pgn: number; src: number; dst: number } {
  const src   = canId & 0xFF;
  const ps    = (canId >> 8)  & 0xFF;
  const pf    = (canId >> 16) & 0xFF;
  const dpEdp = (canId >> 24) & 0x3;
  if (pf < 0xF0) {
    return { pgn: (dpEdp << 16) | (pf << 8), src, dst: ps };
  } else {
    return { pgn: (dpEdp << 16) | (pf << 8) | ps, src, dst: BROADCAST };
  }
}

// ── Fast-packet builder ───────────────────────────────────────────────────────
function fastPacketFrames(canId: number, payload: Buffer, seq = 0): CanFrame[] {
  const frames: CanFrame[] = [];
  const total = payload.length;
  let offset = 0;
  let frameNum = 0;

  while (offset < total) {
    let data: Buffer;
    if (frameNum === 0) {
      const chunk = payload.slice(offset, offset + 6);
      data = Buffer.alloc(8, 0xff);
      data[0] = (seq << 5) | 0x00;
      data[1] = total;
      chunk.copy(data, 2);
      offset += chunk.length;
    } else {
      const chunk = payload.slice(offset, offset + 7);
      data = Buffer.alloc(8, 0xff);
      data[0] = (seq << 5) | frameNum;
      chunk.copy(data, 1);
      offset += chunk.length;
    }
    frames.push({ id: canId | CAN_EFF_FLAG, ext: true, rtr: false, data });
    frameNum++;
  }
  return frames;
}

// ── Fast-packet reassembler ───────────────────────────────────────────────────
class FastPacketAssembler {
  private bufs: Map<string, { total: number; data: number[] }> = new Map();

  feed(src: number, data: Buffer): Buffer | null {
    if (!data || data.length === 0) return null;
    const frameByte = data[0]!;
    const seq   = (frameByte >> 5) & 0x7;
    const frame = frameByte & 0x1F;
    const key   = `${src}:${seq}`;

    if (frame === 0) {
      const total = data[1]!;
      const payload = Array.from(data.slice(2));
      this.bufs.set(key, { total, data: payload });
      if (total <= 6) {
        const result = Buffer.from(this.bufs.get(key)!.data.slice(0, total));
        this.bufs.delete(key);
        return result;
      }
    } else {
      const buf = this.bufs.get(key);
      if (buf) {
        buf.data.push(...Array.from(data.slice(1)));
        if (buf.data.length >= buf.total) {
          const result = Buffer.from(buf.data.slice(0, buf.total));
          this.bufs.delete(key);
          return result;
        }
      }
    }
    return null;
  }
}

// ── Packet builders ───────────────────────────────────────────────────────────
function buildAddressClaim(src: number): CanFrame {
  const unique   = 0x1ABCDE;
  const mfrCode  = 0x73B;   // Raymarine
  const devFn    = 2;
  const devClass = 112;
  const industry = 4;

  // Build 64-bit NAME as two 32-bit halves (JS doesn't have native BigInt arithmetic here)
  const lo =
    (unique & 0x1FFFFF) |
    ((mfrCode & 0x7FF) << 21);
  const hi =
    (devFn & 0xFF) |               // bits 40-46 → hi bits 8-14
    ((devClass & 0x7F) << 16) |    // bits 48-54 → hi bits 16-22
    ((industry & 0x7) << 26) |     // bits 58-60 → hi bits 26-28
    (1 << 29);                     // bit 61 (self-configurable) → hi bit 29

  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(lo >>> 0, 0);
  payload.writeUInt32LE(hi >>> 0, 4);

  const canId = buildCanId(6, 60928, src, 255);
  return { id: canId | CAN_EFF_FLAG, ext: true, rtr: false, data: payload };
}

function buildPgn59904Request(src: number, dst: number, requestedPgn: number): CanFrame {
  const payload = Buffer.alloc(3);
  payload.writeUIntLE(requestedPgn, 0, 3);
  const canId = buildCanId(6, 59904, src, dst);
  return { id: canId | CAN_EFF_FLAG, ext: true, rtr: false, data: payload };
}

function buildZoneSwitch(
  src: number, dst: number, action: number,
  seq: number, fpSeq = 0, isNew = true
): CanFrame[] {
  const payload = Buffer.from([
    0x30, 0x99,                   // b[0-1]  EmpirBus mfr code
    0xff, 0xff,                   // b[2-3]  padding
    0x82, 0x1a,                   // b[4-5]  command marker
    0x06, 0xfe,                   // b[6-7]
    0xff, 0xff,                   // b[8-9]
    0x02,                         // b[10]   message type = command
    seq & 0xFF,                   // b[11]   sequence counter
    0x00,                         // b[12]   MUST be 0x00
    0x01,                         // b[13]
    0x05,                         // b[14]
    action & 0xFF,                // b[15]   zone action
    0x00,                         // b[16]
    0x01,                         // b[17]
    isNew ? 0x01 : 0x00,         // b[18]   new=1, repeat=0
  ]);
  const canId = buildCanId(6, 126720, src, dst);
  return fastPacketFrames(canId, payload, fpSeq);
}

// ── HVAC broadcast decoder ────────────────────────────────────────────────────
const ZONE_IDS: Record<number, string> = {
  0x1a: 'setpoint',
  0x1b: 'actual_temp',
  0x1c: 'fan_speed',
  0xa0: 'compressor_rpm',
  0xa1: 'fan_rpm',
  0xa6: 'refrig_temp_1',
  0x57: 'refrig_temp_2',
  0x58: 'refrig_temp_3',
  0xbb: 'refrig_temp_4',
};

function decodeHvacBroadcast(payload: Buffer): Record<string, number> | null {
  if (payload.length < 14)          return null;
  if (payload[0] !== 0x30)          return null;
  if (payload[1] !== 0x99)          return null;
  if (payload[10] !== 0x01)         return null;

  const results: Record<string, number> = {};
  let offset = 13;

  while (offset + 9 < payload.length) {
    if (payload[offset] !== 0x0a) {
      offset++;
      continue;
    }

    const zoneId = payload[offset + 1]!;
    const rawVal =
      payload[offset + 6]! |
      (payload[offset + 7]! << 8) |
      (payload[offset + 8]! << 16);

    const name = ZONE_IDS[zoneId];
    if (name) {
      if (zoneId === 0x1a || zoneId === 0x1b) {
        // millikelvin → °C
        results[name] = Math.round(((rawVal - 273150) / 1000) * 100) / 100;
      } else if (zoneId === 0x1c || zoneId === 0xa0 || zoneId === 0xa1) {
        results[name] = rawVal;
      } else {
        // Refrigeration temps — also millikelvin
        results[name] = Math.round(((rawVal - 273150) / 1000) * 100) / 100;
      }
    }
    offset += 10;
  }
  return Object.keys(results).length > 0 ? results : null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function toF(celsius: number): number {
  return Math.round((celsius * 9 / 5 + 32) * 10) / 10;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const zoneArg = parseInt(process.argv[2] ?? '0', 10);
  if (isNaN(zoneArg) || zoneArg < 0 || zoneArg > 4) {
    console.error('Usage: hvac_zone_switch.ts [zone 0-4]');
    ZONE_NAMES.forEach((name, i) => console.error(`  ${i} = ${name}`));
    process.exit(1);
  }

  const startZone = zoneArg;
  console.log(`[*] Starting zone: ${ZONE_NAMES[startZone]} (${startZone})`);

  // Open raw CAN channel
  const channel = can.createRawChannel(CAN_IFACE, true);

  // Frame queue for async receive
  const frameQueue: ParsedFrame[] = [];
  channel.addListener('onMessage', (msg: { id: number; data: Buffer }) => {
    const rawId = msg.id & ~CAN_EFF_FLAG;
    const { pgn, src, dst } = parseCanId(rawId);
    frameQueue.push({ canId: rawId, pgn, src, dst, data: msg.data });
  });
  channel.start();

  const asm = new FastPacketAssembler();
  let cmdSeq = 0x10;

  // Helper: drain the frame queue and return the next frame within deadline
  async function recvFrame(deadlineMs: number): Promise<ParsedFrame | null> {
    const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
      if (frameQueue.length > 0) return frameQueue.shift()!;
      await sleep(1);
    }
    return null;
  }

  // Helper: send frames with inter-frame gap
  async function sendFrames(frames: CanFrame[]) {
    for (const f of frames) {
      channel.send(f);
      await sleep(INTER_FRAME_MS);
    }
  }

  // Helper: send a 3-burst zone switch (new + 2 repeats)
  async function sendBurst(action: number): Promise<void> {
    const frames1 = buildZoneSwitch(MY_SRC, MCU_SRC, action, cmdSeq, 0, true);
    cmdSeq = (cmdSeq + 1) & 0xFF;
    await sendFrames(frames1);
    await sleep(INTER_SEND_MS);

    const frames2 = buildZoneSwitch(MY_SRC, MCU_SRC, action, cmdSeq, 0, false);
    cmdSeq = (cmdSeq + 1) & 0xFF;
    await sendFrames(frames2);
    await sleep(INTER_SEND_MS);

    const frames3 = buildZoneSwitch(MY_SRC, MCU_SRC, action, cmdSeq, 0, false);
    cmdSeq = (cmdSeq + 1) & 0xFF;
    await sendFrames(frames3);
  }

  // ── Step 1: Address claim ──────────────────────────────────────────────────
  console.log(`[*] Sending PGN 60928 address claim (src=${MY_SRC})`);
  channel.send(buildAddressClaim(MY_SRC));
  await sleep(50);

  // ── Step 2: ISO discovery requests ────────────────────────────────────────
  console.log(`[*] Sending PGN 59904 discovery requests to MCU (src=${MCU_SRC})`);
  channel.send(buildPgn59904Request(MY_SRC, MCU_SRC, 126996));
  await sleep(50);
  channel.send(buildPgn59904Request(MY_SRC, MCU_SRC, 126464));
  await sleep(50);
  channel.send(buildPgn59904Request(MY_SRC, MCU_SRC, 126998));
  await sleep(50);

  // ── Step 3: Wait for PGN 126464 (tx PGN list = session granted) ───────────
  console.log(`[*] Waiting up to ${DISCOVERY_TIMEOUT_MS}ms for MCU PGN 126464...`);
  let got126464 = false;
  const discoveryEnd = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < discoveryEnd) {
    const f = await recvFrame(discoveryEnd - Date.now());
    if (!f) break;
    if (f.src === MCU_SRC && f.pgn === 126464) {
      console.log('    ✓ MCU sent PGN 126464 — session granted');
      got126464 = true;
      break;
    }
  }
  if (!got126464) {
    console.log('    (No PGN 126464 — continuing anyway)');
  }
  await sleep(50);

  // ── Step 4: Session registration commands ─────────────────────────────────
  console.log('[*] Sending session registration commands');
  const regCanId = (buildCanId(6, 126720, MY_SRC, MCU_SRC)) | CAN_EFF_FLAG;

  // 11-byte registration (b4=0x80)
  const reg1f0 = Buffer.from([0x00, 0x0b, 0x30, 0x99, 0xff, 0xff, 0x80, 0x1a]);
  const reg1f1 = Buffer.from([0x01, 0x06, 0xfe, 0xff, 0xff, 0x02, 0xff, 0xff]);
  channel.send({ id: regCanId, ext: true, rtr: false, data: reg1f0 });
  await sleep(INTER_FRAME_MS);
  channel.send({ id: regCanId, ext: true, rtr: false, data: reg1f1 });
  await sleep(50);

  // 13-byte registration (b10=0x03)
  const reg2payload = Buffer.from([0x30,0x99,0xff,0xff,0x82,0x1a,0x06,0xfe,0xff,0xff,0x03,0x00,0x00]);
  const reg2f0 = Buffer.alloc(8, 0xff);
  reg2f0[0] = 0x00; reg2f0[1] = 0x0d;
  reg2payload.slice(0, 6).copy(reg2f0, 2);
  const reg2f1 = Buffer.alloc(8, 0xff);
  reg2f1[0] = 0x01;
  reg2payload.slice(6).copy(reg2f1, 1);
  channel.send({ id: regCanId, ext: true, rtr: false, data: reg2f0 });
  await sleep(INTER_FRAME_MS);
  channel.send({ id: regCanId, ext: true, rtr: false, data: reg2f1 });

  // ── Step 5: Wait for registration state dump + thermostat broadcast ────────
  console.log('[*] Waiting for MCU registration response...');
  let gotThermFromReg = false;
  const dumpEnd = Date.now() + DUMP_WAIT_MS;
  while (Date.now() < dumpEnd) {
    const f = await recvFrame(Math.min(dumpEnd - Date.now(), 50));
    if (!f) continue;
    if (f.src !== MCU_SRC || f.pgn !== 126720) continue;
    const payload = asm.feed(f.src, f.data);
    if (!payload) continue;
    const zones = decodeHvacBroadcast(payload);
    if (zones && ('setpoint' in zones || 'actual_temp' in zones)) {
      console.log('    Registration response received — MCU thermostat session active');
      gotThermFromReg = true;
      break;
    }
  }
  if (!gotThermFromReg) {
    console.log('    (No registration thermostat response — continuing anyway)');
  }

  // ── Step 6: Cycle all zones, two passes ───────────────────────────────────
  console.log('[*] Collecting thermostat data (cycling all zones, up to 2 passes)...');

  const ordered = [startZone, ...Array.from({length: 5}, (_, i) => i).filter(i => i !== startZone)];
  const twoPassOrder = [...ordered, ...ordered];

  const allZones: Record<string, ZoneData> = {};
  let cycleIdx   = 0;
  let lastSwitch = 0;
  let currentName = ZONE_NAMES[twoPassOrder[0]!]!;

  // Send first switch immediately
  console.log(`    [pass 1] Switching to: ${currentName}`);
  await sendBurst(ZONE_ACTIONS[twoPassOrder[0]!]!);
  lastSwitch = Date.now();
  cycleIdx = 1;

  const collectionEnd = Date.now() + RESPONSE_TIMEOUT_MS;

  while (Date.now() < collectionEnd) {
    // Advance to next zone
    if (Date.now() - lastSwitch >= ZONE_INTERVAL_MS && cycleIdx < twoPassOrder.length) {
      currentName = ZONE_NAMES[twoPassOrder[cycleIdx]!]!;
      const passNum = cycleIdx < ordered.length ? 1 : 2;
      console.log(`    [pass ${passNum}] Switching to: ${currentName}`);
      await sendBurst(ZONE_ACTIONS[twoPassOrder[cycleIdx]!]!);
      lastSwitch = Date.now();
      cycleIdx++;
    }

    // Early exit if all zones collected
    if (Object.keys(allZones).length === ordered.length) break;

    // Receive next frame
    const timeLeft = Math.min(collectionEnd - Date.now(), 50);
    if (timeLeft <= 0) break;
    const f = await recvFrame(timeLeft);
    if (!f) continue;
    if (f.src !== MCU_SRC || f.pgn !== 126720) continue;

    const payload = asm.feed(f.src, f.data);
    if (!payload) continue;

    const zones = decodeHvacBroadcast(payload);
    if (!zones) continue;

    const hasThermostat = 'setpoint' in zones || 'actual_temp' in zones;
    const hasHvac       = hasThermostat || 'fan_speed' in zones;

    if (hasHvac) {
      if (hasThermostat) {
        allZones[currentName] = {
          setpoint:    zones['setpoint'],
          actual_temp: zones['actual_temp'],
          fan_speed:   zones['fan_speed'],
        };
      }

      const parts: string[] = [];
      for (const [k, v] of Object.entries(zones)) {
        if (k.startsWith('refrig')) continue;
        if (k === 'setpoint' || k === 'actual_temp') {
          parts.push(`${k}=${v.toFixed(2)}°C (${toF(v)}°F)`);
        } else {
          parts.push(`${k}=${v}`);
        }
      }
      if (parts.length > 0) {
        console.log(`    ★ ${currentName}: ${parts.join(', ')}`);
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('');
  if (Object.keys(allZones).length > 0) {
    console.log('=== Summary: thermostat data collected ===');
    for (const i of ordered) {
      const zname = ZONE_NAMES[i]!;
      const zdata = allZones[zname];
      if (zdata) {
        const parts: string[] = [];
        if (zdata.actual_temp !== undefined) {
          parts.push(`actual_temp=${zdata.actual_temp.toFixed(2)}°C (${toF(zdata.actual_temp)}°F)`);
        }
        if (zdata.setpoint !== undefined) {
          parts.push(`setpoint=${zdata.setpoint.toFixed(2)}°C (${toF(zdata.setpoint)}°F)`);
        }
        if (zdata.fan_speed !== undefined) {
          parts.push(`fan_speed=${zdata.fan_speed}`);
        }
        console.log(`  ${zname.padEnd(10)} ${parts.join(', ')}`);
      } else {
        console.log(`  ${zname.padEnd(10)} (no data received)`);
      }
    }
  } else {
    console.log(`    ✗ No thermostat data received within ${RESPONSE_TIMEOUT_MS}ms`);
  }

  channel.stop();
  console.log('[*] Done');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
