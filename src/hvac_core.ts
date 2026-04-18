/**
 * hvac_core.ts — Core HVAC protocol & session logic for EmpirBus MCU-150.
 *
 * Shared between the CLI (hvac_zone_switch.ts) and the Signal K plugin (plugin.ts).
 *
 * Supports two CAN transports:
 *   - Yacht Devices YDWG-02 TCP gateway (cross-platform)
 *   - Linux SocketCAN (e.g. a CAN HAT on a Raspberry Pi)
 *
 * YDWG-02 RAW protocol (TCP):
 *   Receive: "hh:mm:ss.ddd R CANID BYTE0 BYTE1 ...\r\n"
 *   Send:    "hh:mm:ss.ddd T CANID BYTE0 BYTE1 ...\r\n"
 *   CANID is 8 hex digits including the EFF flag (0x80000000).
 *
 * Protocol summary (reverse-engineered from bus captures):
 *   1. Address claim (PGN 60928) — we impersonate a Raymarine N2K device
 *   2. ISO requests for PGNs 126996, 126464, 126998 — MCU grants session
 *   3. Two registration commands (11B b4=0x80, 13B b10=0x03)
 *   4. Wait for MCU state dump + thermostat broadcast (session confirmation)
 *   5. Cycle zones at ~1.5s intervals (session times out at ~2s inactivity)
 *   6. Each zone switch triggers one thermostat broadcast from MCU
 *
 * Temperature encoding: uint24 LE at entry bytes [6:9], millikelvin.
 *   celsius = (rawVal - 273150) / 1000
 *
 * Not all zones include all fields (confirmed from captures):
 *   Salon/Helm: setpoint + actual_temp + fan_speed
 *   VIP:        actual_temp + fan_speed
 *   Guest/Owner: actual_temp only
 */

import * as net from 'net';

// ── Constants ─────────────────────────────────────────────────────────────
export const MY_SRC     = 11;    // Our N2K source address
export const MCU_SRC    = 3;     // EmpirBus MCU-150
export const BROADCAST  = 255;

export const ZONE_ACTIONS = [0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff];
export const ZONE_NAMES   = ['Salon', 'Helm', 'Guest', 'VIP', 'Owner', 'Crew Cabin'];

export const DISCOVERY_TIMEOUT_MS = 2000;
export const DUMP_WAIT_MS         = 3000;
export const RESPONSE_TIMEOUT_MS  = 20000;
export const ZONE_INTERVAL_MS     = 1500;
export const INTER_FRAME_MS       = 5;
export const INTER_SEND_MS        = 100;

const CAN_EFF_FLAG = 0x80000000;

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// ── Types ─────────────────────────────────────────────────────────────────
export interface CanFrame {
  id:   number;   // 29-bit CAN ID (without EFF flag)
  data: Buffer;
}

export interface ParsedFrame {
  canId: number;
  pgn:   number;
  src:   number;
  dst:   number;
  data:  Buffer;
}

export interface ZoneData {
  setpoint?:    number | undefined;  // °C
  actual_temp?: number | undefined;  // °C
  fan_speed?:   number | undefined;
}

export interface CanTransport {
  connect(): Promise<void>;
  send(frame: CanFrame): void;
  recv(timeoutMs: number): Promise<ParsedFrame | null>;
  disconnect(): void;
}

// ── Utilities ─────────────────────────────────────────────────────────────
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── CAN ID helpers ────────────────────────────────────────────────────────
export function buildCanId(priority: number, pgn: number, src: number, dst?: number): number {
  const pf = (pgn >> 8) & 0xFF;
  if (pf < 0xF0 && dst !== undefined) {
    return (priority << 26) | ((pgn & 0x3FF00) << 8) | (dst << 8) | src;
  } else {
    return (priority << 26) | (pgn << 8) | src;
  }
}

export function parseCanId(canId: number): { pgn: number; src: number; dst: number } {
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

// ── Fast-packet builder ───────────────────────────────────────────────────
export function fastPacketFrames(canId: number, payload: Buffer, seq = 0): CanFrame[] {
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

// ── Fast-packet reassembler ───────────────────────────────────────────────
export class FastPacketAssembler {
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

// ── YDWG-02 TCP gateway ───────────────────────────────────────────────────
export interface YdwgGatewayOptions {
  host?: string;
  port?: number;
}

export class YdwgGateway implements CanTransport {
  readonly host: string;
  readonly port: number;

  private socket: net.Socket;
  private lineBuffer = '';
  private frameQueue: ParsedFrame[] = [];
  private connected  = false;

  constructor(opts: YdwgGatewayOptions = {}) {
    this.host = opts.host ?? process.env.YDWG_HOST ?? '192.168.1.1';
    this.port = opts.port ?? parseInt(process.env.YDWG_PORT ?? '1457');

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
      this.socket.connect(this.port, this.host, () => {
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

  send(frame: CanFrame) {
    if (!this.connected) return;

    const now  = new Date();
    const hh   = now.getHours().toString().padStart(2, '0');
    const mm   = now.getMinutes().toString().padStart(2, '0');
    const ss   = now.getSeconds().toString().padStart(2, '0');
    const ms   = now.getMilliseconds().toString().padStart(3, '0');
    const ts   = `${hh}:${mm}:${ss}.${ms}`;

    // `>>> 0` forces unsigned 32-bit — otherwise the high EFF bit flips the
    // result negative and toString(16) emits "-671100F5".
    const idHex   = ((frame.id | CAN_EFF_FLAG) >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const dataHex = Array.from(frame.data)
      .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ');

    const outLine = `${ts} T ${idHex} ${dataHex}`;
    if (DEBUG) console.log(`[TX] ${outLine}`);
    this.socket.write(`${outLine}\r\n`, 'ascii');
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

// ── SocketCAN transport ───────────────────────────────────────────────────
// Linux-only. Loads `socketcan` lazily so this file still imports on macOS.
export class SocketCanTransport implements CanTransport {
  private channel: any = null;
  private frameQueue: ParsedFrame[] = [];

  constructor(readonly iface: string) {}

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

// ── Packet builders ───────────────────────────────────────────────────────
export function buildAddressClaim(src: number): CanFrame {
  const unique   = 0x1ABCDE;
  const mfrCode  = 0x73B;   // Raymarine — MCU grants sessions to Axiom-looking devices
  const devFn    = 2;
  const devClass = 112;
  const industry = 4;

  // NAME is a 64-bit LE field, split into low/high 32-bit words:
  //   unique:   bits 0-20     mfrCode:  bits 21-31
  //   devFn:    bits 40-47    devClass: bits 48-54
  //   industry: bits 58-60    self-configurable: bit 61
  const lo = (unique & 0x1FFFFF) | ((mfrCode & 0x7FF) << 21);
  const hi = ((devFn & 0xFF) << 8) | ((devClass & 0x7F) << 16) | ((industry & 0x7) << 26) | (1 << 29);

  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(lo >>> 0, 0);
  payload.writeUInt32LE(hi >>> 0, 4);

  return { id: buildCanId(6, 60928, src, 255), data: payload };
}

export function buildPgn59904Request(src: number, dst: number, requestedPgn: number): CanFrame {
  const payload = Buffer.alloc(3);
  payload.writeUIntLE(requestedPgn, 0, 3);
  return { id: buildCanId(6, 59904, src, dst), data: payload };
}

export function buildZoneSwitch(
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
    isNew ? 0x01 : 0x00,         // new=1, repeat=0
  ]);
  return fastPacketFrames(buildCanId(6, 126720, src, dst), payload, fpSeq);
}

// ── HVAC broadcast decoder ────────────────────────────────────────────────
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

export function decodeHvacBroadcast(payload: Buffer): Record<string, number> | null {
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
        results[name] = Math.round(((rawVal - 273150) / 1000) * 100) / 100;
      }
    }
    offset += 10;
  }
  return Object.keys(results).length > 0 ? results : null;
}

// ── Session ───────────────────────────────────────────────────────────────
export type Logger = (msg: string) => void;

export interface HvacSessionOptions {
  transport: CanTransport;
  mySrc?:    number;
  mcuSrc?:   number;
  logger?:   Logger;
}

export type ZoneUpdateHandler = (zoneName: string, data: Record<string, number>) => void;

export interface CycleOptions {
  /** Zone (0-5) to switch to first — subsequent zones follow in natural order. */
  startZone?: number;
  /** Number of complete passes over all 6 zones. Omit for infinite cycling. */
  passes?: number;
  /** Overall time budget for this cycle call. Omit for no overall timeout. */
  overallTimeoutMs?: number;
  /** Called whenever a thermostat broadcast is decoded for the current zone. */
  onZone?: ZoneUpdateHandler;
  /** Abort signal — cycle exits cleanly when triggered. */
  signal?: AbortSignal;
}

/**
 * Manages an EmpirBus HVAC session: connect, register, cycle zones.
 *
 * Usage:
 *   const session = new HvacSession({ transport });
 *   await session.start();
 *   const zones = await session.cycleZones({ passes: 2 });  // CLI: finite
 *   // OR
 *   await session.cycleZones({ signal: abort.signal, onZone: publish });  // plugin: infinite
 *   session.stop();
 */
export class HvacSession {
  private readonly gw:      CanTransport;
  private readonly asm    = new FastPacketAssembler();
  private readonly mySrc:   number;
  private readonly mcuSrc:  number;
  private readonly log:     Logger;
  private cmdSeq = 0x10;

  constructor(opts: HvacSessionOptions) {
    this.gw     = opts.transport;
    this.mySrc  = opts.mySrc  ?? MY_SRC;
    this.mcuSrc = opts.mcuSrc ?? MCU_SRC;
    this.log    = opts.logger ?? (() => {});
  }

  async start(): Promise<void> {
    await this.gw.connect();
    await this.register();
  }

  stop(): void {
    this.gw.disconnect();
  }

  private async register(): Promise<void> {
    // Step 1: Address claim
    this.log(`[*] Sending PGN 60928 address claim (src=${this.mySrc})`);
    this.gw.send(buildAddressClaim(this.mySrc));
    await sleep(50);

    // Step 2: ISO discovery requests
    this.log('[*] Sending PGN 59904 discovery requests to MCU');
    this.gw.send(buildPgn59904Request(this.mySrc, this.mcuSrc, 126996));
    await sleep(50);
    this.gw.send(buildPgn59904Request(this.mySrc, this.mcuSrc, 126464));
    await sleep(50);
    this.gw.send(buildPgn59904Request(this.mySrc, this.mcuSrc, 126998));
    await sleep(50);

    // Step 3: Wait for PGN 126464 (session grant)
    this.log(`[*] Waiting up to ${DISCOVERY_TIMEOUT_MS}ms for MCU PGN 126464...`);
    let got126464 = false;
    const discoveryEnd = Date.now() + DISCOVERY_TIMEOUT_MS;
    while (Date.now() < discoveryEnd) {
      const f = await this.gw.recv(discoveryEnd - Date.now());
      if (!f) break;
      if (f.src === this.mcuSrc && f.pgn === 126464) {
        this.log('    ✓ MCU sent PGN 126464 — session granted');
        got126464 = true;
        break;
      }
    }
    if (!got126464) this.log('    (No PGN 126464 — continuing anyway)');
    await sleep(50);

    // Step 4: Session registration commands
    this.log('[*] Sending session registration commands');
    const regCanId = buildCanId(6, 126720, this.mySrc, this.mcuSrc);

    // 11-byte registration (b4=0x80)
    this.gw.send({ id: regCanId, data: Buffer.from([0x00, 0x0b, 0x30, 0x99, 0xff, 0xff, 0x80, 0x1a]) });
    await sleep(INTER_FRAME_MS);
    this.gw.send({ id: regCanId, data: Buffer.from([0x01, 0x06, 0xfe, 0xff, 0xff, 0x02, 0xff, 0xff]) });
    await sleep(50);

    // 13-byte registration (b10=0x03)
    const reg2 = Buffer.from([0x30,0x99,0xff,0xff,0x82,0x1a,0x06,0xfe,0xff,0xff,0x03,0x00,0x00]);
    const r2f0 = Buffer.alloc(8, 0xff);
    r2f0[0] = 0x00; r2f0[1] = 0x0d;
    reg2.slice(0, 6).copy(r2f0, 2);
    const r2f1 = Buffer.alloc(8, 0xff);
    r2f1[0] = 0x01;
    reg2.slice(6).copy(r2f1, 1);
    this.gw.send({ id: regCanId, data: r2f0 });
    await sleep(INTER_FRAME_MS);
    this.gw.send({ id: regCanId, data: r2f1 });

    // Step 5: Wait for state dump + thermostat broadcast
    this.log('[*] Waiting for MCU registration response...');
    let gotTherm = false;
    const dumpEnd = Date.now() + DUMP_WAIT_MS;
    while (Date.now() < dumpEnd) {
      const f = await this.gw.recv(Math.min(dumpEnd - Date.now(), 50));
      if (!f) continue;
      if (f.src !== this.mcuSrc || f.pgn !== 126720) continue;
      const payload = this.asm.feed(f.src, f.data);
      if (!payload) continue;
      const zones = decodeHvacBroadcast(payload);
      if (zones && ('setpoint' in zones || 'actual_temp' in zones)) {
        this.log('    Registration response received — MCU thermostat session active');
        gotTherm = true;
        break;
      }
    }
    if (!gotTherm) this.log('    (No registration thermostat response — continuing anyway)');
  }

  private async sendFrames(frames: CanFrame[]): Promise<void> {
    for (const f of frames) {
      this.gw.send(f);
      await sleep(INTER_FRAME_MS);
    }
  }

  private async sendBurst(action: number): Promise<void> {
    await this.sendFrames(buildZoneSwitch(this.mySrc, this.mcuSrc, action, this.cmdSeq, 0, true));
    this.cmdSeq = (this.cmdSeq + 1) & 0xFF;
    await sleep(INTER_SEND_MS);
    await this.sendFrames(buildZoneSwitch(this.mySrc, this.mcuSrc, action, this.cmdSeq, 0, false));
    this.cmdSeq = (this.cmdSeq + 1) & 0xFF;
    await sleep(INTER_SEND_MS);
    await this.sendFrames(buildZoneSwitch(this.mySrc, this.mcuSrc, action, this.cmdSeq, 0, false));
    this.cmdSeq = (this.cmdSeq + 1) & 0xFF;
  }

  /**
   * Cycle through all zones, collecting thermostat data.
   *
   * Exits when any of the following is true:
   *   - signal is aborted
   *   - overallTimeoutMs has elapsed
   *   - passes is set and that many complete passes have finished
   *   - (finite-pass mode only) data has been collected for every zone
   */
  async cycleZones(opts: CycleOptions = {}): Promise<Record<string, ZoneData>> {
    const startZone        = opts.startZone ?? 0;
    const passes           = opts.passes;
    const overallTimeoutMs = opts.overallTimeoutMs;
    const onZone           = opts.onZone;
    const signal           = opts.signal;

    const ordered = [
      startZone,
      ...Array.from({ length: 6 }, (_, i) => i).filter(i => i !== startZone),
    ];
    const allZones: Record<string, ZoneData> = {};

    const overallEnd = overallTimeoutMs !== undefined
      ? Date.now() + overallTimeoutMs
      : Number.POSITIVE_INFINITY;

    let cycleIdx = 0;
    let passNum  = 1;
    let currentName = ZONE_NAMES[ordered[0]!]!;

    this.log(`    [pass ${passNum}] Switching to: ${currentName}`);
    await this.sendBurst(ZONE_ACTIONS[ordered[0]!]!);
    let lastSwitch = Date.now();
    cycleIdx = 1;

    while (!signal?.aborted && Date.now() < overallEnd) {
      // Advance to next zone when interval elapsed
      if (Date.now() - lastSwitch >= ZONE_INTERVAL_MS) {
        if (cycleIdx >= ordered.length) {
          if (passes !== undefined && passNum >= passes) break;
          passNum++;
          cycleIdx = 0;
        }
        currentName = ZONE_NAMES[ordered[cycleIdx]!]!;
        this.log(`    [pass ${passNum}] Switching to: ${currentName}`);
        await this.sendBurst(ZONE_ACTIONS[ordered[cycleIdx]!]!);
        lastSwitch = Date.now();
        cycleIdx++;
      }

      // Finite-pass mode: early exit if every zone has been captured
      if (passes !== undefined && Object.keys(allZones).length === ordered.length) break;

      const timeLeft = Math.min(overallEnd - Date.now(), 50);
      if (timeLeft <= 0) break;

      const f = await this.gw.recv(timeLeft);
      if (!f) continue;
      if (f.src !== this.mcuSrc || f.pgn !== 126720) continue;

      const payload = this.asm.feed(f.src, f.data);
      if (!payload) continue;

      const zones = decodeHvacBroadcast(payload);
      if (!zones) continue;

      const hasThermostat = 'setpoint' in zones || 'actual_temp' in zones;
      const hasHvac       = hasThermostat || 'fan_speed' in zones;
      if (!hasHvac) continue;

      if (hasThermostat) {
        allZones[currentName] = {
          setpoint:    zones['setpoint'],
          actual_temp: zones['actual_temp'],
          fan_speed:   zones['fan_speed'],
        };
      }
      onZone?.(currentName, zones);
    }

    return allZones;
  }
}
