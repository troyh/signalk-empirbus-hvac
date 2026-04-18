#!/usr/bin/env ts-node
/**
 * hvac_zone_switch.ts — Poll all HVAC zone temperatures on an Azimut 60 Fly
 * (EmpirBus MCU-150) over either a Yacht Devices YDWG-02 TCP gateway or
 * a Linux SocketCAN interface (e.g. a CAN HAT on a Raspberry Pi).
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
 * Requires: npm install @types/node
 * SocketCAN path additionally requires: npm install socketcan
 * (Linux only — native build via node-gyp; needs libsocketcan-dev.)
 *
 * YDWG-02 RAW protocol (TCP):
 *   Receive: "hh:mm:ss.ddd R CANID BYTE0 BYTE1 ...\r\n"
 *   Send:    "hh:mm:ss.ddd T CANID BYTE0 BYTE1 ...\r\n"
 *   CANID is 8 hex digits including the EFF flag (0x80000000).
 *   Direction R = received from bus, T = transmitted to bus.
 *
 * Protocol summary (reverse-engineered from bus captures):
 *   1. Address claim (PGN 60928) → we appear as N2K device
 *   2. ISO requests for PGNs 126996, 126464, 126998 → MCU grants session
 *   3. Two registration commands (11B b4=0x80, 13B b10=0x03)
 *   4. Wait for MCU state dump + thermostat broadcast (session confirmation)
 *   5. Cycle all 5 zones at 1.5s intervals (session times out at ~2s inactivity)
 *   6. Each zone switch triggers one thermostat broadcast from MCU
 *   7. Two passes to ensure all zones captured
 *
 * Temperature encoding: uint24 LE at entry bytes [6:9], millikelvin
 *   celsius = (rawVal - 273150) / 1000
 *
 * Not all zones include all fields (confirmed from captures):
 *   Salon/Helm: setpoint + actual_temp + fan_speed
 *   VIP:        actual_temp + fan_speed
 *   Guest/Owner: actual_temp only
 */

import * as net from 'net';

// ── Configuration ─────────────────────────────────────────────────────────────
const YDWG_HOST         = process.env.YDWG_HOST ?? '192.168.1.1';
const YDWG_PORT         = parseInt(process.env.YDWG_PORT ?? '1457');

const MY_SRC            = 11;    // Our N2K source address
const MCU_SRC           = 3;     // EmpirBus MCU-150
const BROADCAST         = 255;

const ZONE_ACTIONS      = [0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff];
const ZONE_NAMES        = ['Salon', 'Helm', 'Guest', 'VIP', 'Owner', 'Crew Cabin'];

const DISCOVERY_TIMEOUT_MS  = 2000;
const DUMP_WAIT_MS          = 3000;
const RESPONSE_TIMEOUT_MS   = 20000;
const ZONE_INTERVAL_MS      = 1500;  // Session times out at ~2s inactivity
const INTER_FRAME_MS        = 5;     // Gap between frame sends over TCP
const INTER_SEND_MS         = 100;   // Gap between sends within a burst

const CAN_EFF_FLAG          = 0x80000000;

// Set DEBUG=1 in the environment to dump every raw line read/written on the
// YDWG TCP socket. Useful for diagnosing a non-responsive MCU / filtering gateway.
const DEBUG                 = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// ── Types ─────────────────────────────────────────────────────────────────────
interface CanFrame {
  id:   number;   // 29-bit CAN ID (without EFF flag)
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
  fan_speed?:   number | undefined;
}

// ── Transport abstraction ─────────────────────────────────────────────────────
interface CanTransport {
  connect(): Promise<void>;
  send(frame: CanFrame): void;
  recv(timeoutMs: number): Promise<ParsedFrame | null>;
  disconnect(): void;
}

// ── YDWG-02 TCP gateway ───────────────────────────────────────────────────────
class YdwgGateway implements CanTransport {
  private socket: net.Socket;
  private lineBuffer = '';
  private frameQueue: ParsedFrame[] = [];
  private connected  = false;

  constructor() {
    this.socket = new net.Socket();
    this.socket.setEncoding('ascii');
    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('error', (err) => {
      console.error('[YDWG] TCP error:', err.message);
    });
    this.socket.on('close', () => {
      this.connected = false;
    });
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.connect(YDWG_PORT, YDWG_HOST, () => {
        console.log(`[*] Connected to YDWG-02 at ${YDWG_HOST}:${YDWG_PORT}`);
        this.connected = true;
        resolve();
      });
      this.socket.once('error', reject);
    });
  }

  disconnect() {
    this.socket.destroy();
  }

  private onData(chunk: string) {
    this.lineBuffer += chunk;
    // YDWG-02 uses \r\n line endings
    const lines = this.lineBuffer.split('\r\n');
    this.lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (DEBUG && trimmed.length > 0) console.log(`[RX] ${trimmed}`);
      const frame = this.parseLine(trimmed);
      if (frame) this.frameQueue.push(frame);
    }
  }

  /**
   * Parse a YDWG RAW line:
   *   "hh:mm:ss.ddd R 1DEFFF03 30 99 ..."
   *   "hh:mm:ss.ddd T 1DEFFF03 30 99 ..."
   *
   * We accept both R (received from bus) and T (echo of our transmit).
   * The CANID includes the EFF flag (bit 31).
   */
  private parseLine(line: string): ParsedFrame | null {
    if (!line) return null;
    const parts = line.split(' ');
    // Format: timestamp direction canid [bytes...]
    if (parts.length < 3) return null;
    const direction = parts[1];
    if (direction !== 'R' && direction !== 'T') return null;

    const rawId = parseInt(parts[2]!, 16);
    if (isNaN(rawId)) return null;

    const canId = rawId & ~CAN_EFF_FLAG;
    const bytes = parts.slice(3)
      .map(b => parseInt(b, 16))
      .filter(b => !isNaN(b));
    const data = Buffer.from(bytes);

    const { pgn, src, dst } = parseCanId(canId);
    return { canId, pgn, src, dst, data };
  }

  /**
   * Send one CAN frame to the YDWG-02.
   * Format: "hh:mm:ss.ddd T CANID BYTE0 BYTE1 ...\r\n"
   */
  send(frame: CanFrame) {
    if (!this.connected) return;

    const now  = new Date();
    const hh   = now.getHours().toString().padStart(2, '0');
    const mm   = now.getMinutes().toString().padStart(2, '0');
    const ss   = now.getSeconds().toString().padStart(2, '0');
    const ms   = now.getMilliseconds().toString().padStart(3, '0');
    const ts   = `${hh}:${mm}:${ss}.${ms}`;

    // CANID must include EFF flag in the YDWG format.
    // `>>> 0` forces unsigned 32-bit, otherwise the high EFF bit makes the
    // result a negative number and toString(16) emits "-671100F5".
    const idHex   = ((frame.id | CAN_EFF_FLAG) >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const dataHex = Array.from(frame.data)
      .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ');

    const outLine = `${ts} T ${idHex} ${dataHex}`;
    if (DEBUG) console.log(`[TX] ${outLine}`);
    this.socket.write(`${outLine}\r\n`, 'ascii');
  }

  /** Pop the next received frame, waiting up to timeoutMs. */
  async recv(timeoutMs: number): Promise<ParsedFrame | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.frameQueue.length > 0) return this.frameQueue.shift()!;
      await sleep(1);
    }
    return null;
  }
}

// ── SocketCAN transport ──────────────────────────────────────────────────────
// Linux-only. Loads `socketcan` lazily so this file still imports on macOS.
class SocketCanTransport implements CanTransport {
  private channel: any = null;
  private frameQueue: ParsedFrame[] = [];

  constructor(private readonly iface: string) {}

  async connect(): Promise<void> {
    // @ts-ignore — optional Linux-only native module; not installed on macOS dev hosts
    const mod: any = await import('socketcan');
    const socketcan = mod.default ?? mod;
    this.channel = socketcan.createRawChannel(this.iface, true);
    this.channel.addListener('onMessage', (msg: { id: number; ext?: boolean; data: Buffer }) => {
      const canId = msg.id >>> 0;
      if (DEBUG) {
        const idHex = canId.toString(16).toUpperCase().padStart(8, '0');
        const dataHex = Array.from(msg.data)
          .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
          .join(' ');
        console.log(`[RX] ${idHex} ${dataHex}`);
      }
      const { pgn, src, dst } = parseCanId(canId);
      this.frameQueue.push({ canId, pgn, src, dst, data: msg.data });
    });
    this.channel.start();
    console.log(`[*] Opened SocketCAN interface ${this.iface}`);
  }

  disconnect() {
    if (this.channel) this.channel.stop();
  }

  send(frame: CanFrame) {
    if (!this.channel) return;
    if (DEBUG) {
      const idHex = (frame.id >>> 0).toString(16).toUpperCase().padStart(8, '0');
      const dataHex = Array.from(frame.data)
        .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
        .join(' ');
      console.log(`[TX] ${idHex} ${dataHex}`);
    }
    this.channel.send({ id: frame.id >>> 0, ext: true, data: frame.data });
  }

  async recv(timeoutMs: number): Promise<ParsedFrame | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.frameQueue.length > 0) return this.frameQueue.shift()!;
      await sleep(1);
    }
    return null;
  }
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
    const data = Buffer.alloc(8, 0xff);
    if (frameNum === 0) {
      const chunk = payload.slice(offset, offset + 6);
      data[0] = (seq << 5) | 0x00;
      data[1] = total;
      chunk.copy(data, 2);
      offset += chunk.length;
    } else {
      const chunk = payload.slice(offset, offset + 7);
      data[0] = (seq << 5) | frameNum;
      chunk.copy(data, 1);
      offset += chunk.length;
    }
    frames.push({ id: canId, data });
    frameNum++;
  }
  return frames;
}

// ── Fast-packet reassembler ───────────────────────────────────────────────────
class FastPacketAssembler {
  private bufs: Map<string, { total: number; data: number[] }> = new Map();

  feed(src: number, data: Buffer): Buffer | null {
    if (!data || data.length === 0) return null;
    const frameByte = data[0];
    const seq   = (frameByte! >> 5) & 0x7;
    const frame = frameByte! & 0x1F;
    const key   = `${src}:${seq}`;

    if (frame === 0) {
      const total = data[1]!;
      this.bufs.set(key, { total, data: Array.from(data.slice(2)) });
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

  // 64-bit NAME as two 32-bit halves
  // NAME is a 64-bit LE field; we split into low/high 32-bit words.
  // Bit offsets within the full 64-bit NAME:
  //   unique:   bits 0-20    mfrCode: bits 21-31
  //   devFn:    bits 40-47   devClass: bits 48-54
  //   industry: bits 58-60   self-configurable: bit 61
  const lo = (unique & 0x1FFFFF) | ((mfrCode & 0x7FF) << 21);
  const hi = ((devFn & 0xFF) << 8) | ((devClass & 0x7F) << 16) | ((industry & 0x7) << 26) | (1 << 29);

  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(lo >>> 0, 0);
  payload.writeUInt32LE(hi >>> 0, 4);

  return { id: buildCanId(6, 60928, src, 255), data: payload };
}

function buildPgn59904Request(src: number, dst: number, requestedPgn: number): CanFrame {
  const payload = Buffer.alloc(3);
  payload.writeUIntLE(requestedPgn, 0, 3);
  return { id: buildCanId(6, 59904, src, dst), data: payload };
}

function buildZoneSwitch(
  src: number, dst: number, action: number,
  seq: number, fpSeq = 0, isNew = true
): CanFrame[] {
  const payload = Buffer.from([
    0x30, 0x99,                  // EmpirBus mfr code
    0xff, 0xff,                  // padding
    0x82, 0x1a,                  // command marker
    0x06, 0xfe,
    0xff, 0xff,
    0x02,                        // message type = command
    seq & 0xFF,                  // sequence counter
    0x05,                        // per-controller ID byte. Captured Axioms use 0x05 (src=0x0D)
                                 // or 0x04 (src=0x65); 0x00 is silently dropped by this MCU.
    0x01,
    0x05,
    action & 0xFF,               // zone action
    0x00,
    0x01,
    isNew ? 0x01 : 0x00,        // new=1, repeat=0
  ]);
  return fastPacketFrames(buildCanId(6, 126720, src, dst), payload, fpSeq);
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
  if (payload.length < 14)  return null;
  if (payload[0]  !== 0x30) return null;
  if (payload[1]  !== 0x99) return null;
  if (payload[10] !== 0x01) return null;

  const results: Record<string, number> = {};
  let offset = 13;

  while (offset + 9 < payload.length) {
    if (payload[offset] !== 0x0a) { offset++; continue; }

    const zoneId = payload[offset + 1]!;
    const rawVal =
      payload[offset + 6]! |
      (payload[offset + 7]! << 8) |
      (payload[offset + 8]! << 16);

    const name = ZONE_IDS[zoneId];
    if (name) {
      if (zoneId === 0x1a || zoneId === 0x1b) {
        results[name] = Math.round(((rawVal - 273150) / 1000) * 100) / 100;
      } else if (zoneId === 0x1c || zoneId === 0xa0 || zoneId === 0xa1) {
        results[name] = rawVal;
      } else {
        // Refrigeration temps — millikelvin
        results[name] = Math.round(((rawVal - 273150) / 1000) * 100) / 100;
      }
    }
    offset += 10;
  }
  return Object.keys(results).length > 0 ? results : null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const toF   = (c: number)  => Math.round((c * 9 / 5 + 32) * 10) / 10;

// ── Main ──────────────────────────────────────────────────────────────────────
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
  const gw: CanTransport = socketcanIface
    ? new SocketCanTransport(socketcanIface)
    : new YdwgGateway();
  if (!socketcanIface) console.log(`[*] Gateway: ${YDWG_HOST}:${YDWG_PORT}`);

  const asm = new FastPacketAssembler();
  let cmdSeq = 0x10;

  await gw.connect();

  async function sendFrames(frames: CanFrame[]) {
    for (const f of frames) {
      gw.send(f);
      await sleep(INTER_FRAME_MS);
    }
  }

  async function sendBurst(action: number) {
    await sendFrames(buildZoneSwitch(MY_SRC, MCU_SRC, action, cmdSeq, 0, true));
    cmdSeq = (cmdSeq + 1) & 0xFF;
    await sleep(INTER_SEND_MS);
    await sendFrames(buildZoneSwitch(MY_SRC, MCU_SRC, action, cmdSeq, 0, false));
    cmdSeq = (cmdSeq + 1) & 0xFF;
    await sleep(INTER_SEND_MS);
    await sendFrames(buildZoneSwitch(MY_SRC, MCU_SRC, action, cmdSeq, 0, false));
    cmdSeq = (cmdSeq + 1) & 0xFF;
  }

  // ── Step 1: Address claim ──────────────────────────────────────────────────
  console.log(`[*] Sending PGN 60928 address claim (src=${MY_SRC})`);
  gw.send(buildAddressClaim(MY_SRC));
  await sleep(50);

  // ── Step 2: ISO discovery requests ────────────────────────────────────────
  console.log(`[*] Sending PGN 59904 discovery requests to MCU`);
  gw.send(buildPgn59904Request(MY_SRC, MCU_SRC, 126996));
  await sleep(50);
  gw.send(buildPgn59904Request(MY_SRC, MCU_SRC, 126464));
  await sleep(50);
  gw.send(buildPgn59904Request(MY_SRC, MCU_SRC, 126998));
  await sleep(50);

  // ── Step 3: Wait for PGN 126464 (session grant) ───────────────────────────
  console.log(`[*] Waiting up to ${DISCOVERY_TIMEOUT_MS}ms for MCU PGN 126464...`);
  let got126464 = false;
  const discoveryEnd = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < discoveryEnd) {
    const f = await gw.recv(discoveryEnd - Date.now());
    if (!f) break;
    if (f.src === MCU_SRC && f.pgn === 126464) {
      console.log('    ✓ MCU sent PGN 126464 — session granted');
      got126464 = true;
      break;
    }
  }
  if (!got126464) console.log('    (No PGN 126464 — continuing anyway)');
  await sleep(50);

  // ── Step 4: Session registration commands ─────────────────────────────────
  console.log('[*] Sending session registration commands');
  const regCanId = buildCanId(6, 126720, MY_SRC, MCU_SRC);

  // 11-byte registration (b4=0x80)
  gw.send({ id: regCanId, data: Buffer.from([0x00, 0x0b, 0x30, 0x99, 0xff, 0xff, 0x80, 0x1a]) });
  await sleep(INTER_FRAME_MS);
  gw.send({ id: regCanId, data: Buffer.from([0x01, 0x06, 0xfe, 0xff, 0xff, 0x02, 0xff, 0xff]) });
  await sleep(50);

  // 13-byte registration (b10=0x03)
  const reg2 = Buffer.from([0x30,0x99,0xff,0xff,0x82,0x1a,0x06,0xfe,0xff,0xff,0x03,0x00,0x00]);
  const r2f0 = Buffer.alloc(8, 0xff);
  r2f0[0] = 0x00; r2f0[1] = 0x0d;
  reg2.slice(0, 6).copy(r2f0, 2);
  const r2f1 = Buffer.alloc(8, 0xff);
  r2f1[0] = 0x01;
  reg2.slice(6).copy(r2f1, 1);
  gw.send({ id: regCanId, data: r2f0 });
  await sleep(INTER_FRAME_MS);
  gw.send({ id: regCanId, data: r2f1 });

  // ── Step 5: Wait for state dump + thermostat broadcast ────────────────────
  console.log('[*] Waiting for MCU registration response...');
  let gotTherm = false;
  const dumpEnd = Date.now() + DUMP_WAIT_MS;
  while (Date.now() < dumpEnd) {
    const f = await gw.recv(Math.min(dumpEnd - Date.now(), 50));
    if (!f) continue;
    if (f.src !== MCU_SRC || f.pgn !== 126720) continue;
    const payload = asm.feed(f.src, f.data);
    if (!payload) continue;
    const zones = decodeHvacBroadcast(payload);
    if (zones && ('setpoint' in zones || 'actual_temp' in zones)) {
      console.log('    Registration response received — MCU thermostat session active');
      gotTherm = true;
      break;
    }
  }
  if (!gotTherm) console.log('    (No registration thermostat response — continuing anyway)');

  // ── Step 6: Cycle all zones, two passes ───────────────────────────────────
  console.log('[*] Collecting thermostat data (cycling all zones, up to 2 passes)...');

  const ordered      = [startZone, ...Array.from({length: 6}, (_, i) => i).filter(i => i !== startZone)];
  const twoPassOrder = [...ordered, ...ordered];
  const allZones: Record<string, ZoneData> = {};
  let cycleIdx    = 0;
  let lastSwitch  = 0;
  let currentName = ZONE_NAMES[twoPassOrder[0]!]!;

  console.log(`    [pass 1] Switching to: ${currentName}`);
  await sendBurst(ZONE_ACTIONS[twoPassOrder[0]!]!);
  lastSwitch = Date.now();
  cycleIdx   = 1;

  const collectionEnd = Date.now() + RESPONSE_TIMEOUT_MS;

  while (Date.now() < collectionEnd) {
    // Advance to next zone when interval elapsed
    if (Date.now() - lastSwitch >= ZONE_INTERVAL_MS && cycleIdx < twoPassOrder.length) {
      currentName = ZONE_NAMES[twoPassOrder[cycleIdx]!]!;
      const passNum = cycleIdx < ordered.length ? 1 : 2;
      console.log(`    [pass ${passNum}] Switching to: ${currentName}`);
      await sendBurst(ZONE_ACTIONS[twoPassOrder[cycleIdx]!]!);
      lastSwitch = Date.now();
      cycleIdx++;
    }

    if (Object.keys(allZones).length === ordered.length) break;

    const timeLeft = Math.min(collectionEnd - Date.now(), 50);
    if (timeLeft <= 0) break;

    const f = await gw.recv(timeLeft);
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
      if (parts.length > 0) console.log(`    ★ ${currentName}: ${parts.join(', ')}`);
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
        if (zdata.actual_temp !== undefined)
          parts.push(`actual_temp=${zdata.actual_temp.toFixed(2)}°C (${toF(zdata.actual_temp).toFixed(0)}°F)`);
        if (zdata.setpoint !== undefined)
          parts.push(`setpoint=${zdata.setpoint.toFixed(2)}°C (${toF(zdata.setpoint).toFixed(0)}°F)`);
        if (zdata.fan_speed !== undefined)
          parts.push(`fan_speed=${zdata.fan_speed/1000}`);
        console.log(`  ${zname.padEnd(10)} ${parts.join(', ')}`);
      } else {
        console.log(`  ${zname.padEnd(10)} (no data received)`);
      }
    }
  } else {
    console.log(`    ✗ No thermostat data received within ${RESPONSE_TIMEOUT_MS}ms`);
  }

  gw.disconnect();
  console.log('[*] Done');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});