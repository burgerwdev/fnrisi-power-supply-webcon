// In-memory fake DPS-150 used by UI regression tests (?sim=1) and dev without hardware.
// It implements the SerialTransport contract, records every TX frame, and answers the
// way the real device does: push telemetry groups after session-enable, reply to E1 /
// DE / DF / E0 queries and to the FF snapshot request (golden real capture).
import { GROUP, HEADER_RX, HEADER_TX } from '../protocol/const';
import { GOLDEN_FF, hexToBytes } from '../protocol/fixtures';
import type { SerialTransport } from './transport';

function f32(v: number): Uint8Array {
  const b = new ArrayBuffer(4);
  new DataView(b).setFloat32(0, v, true);
  return new Uint8Array(b);
}

function frame(reg: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 5);
  out[0] = HEADER_RX;
  out[1] = GROUP.READ;
  out[2] = reg;
  out[3] = payload.length;
  out.set(payload, 4);
  let chk = (reg + payload.length) & 0xff;
  for (const b of payload) chk = (chk + b) & 0xff;
  out[out.length - 1] = chk;
  return out;
}

export class FakeDps150Transport implements SerialTransport {
  readonly kind = 'fake-dps150';
  readonly baudRate: number;
  onError?: (err: unknown) => void;
  onClose?: (reason: string) => void;
  txFrames: Uint8Array[] = [];
  openCount = 0;
  private handler: ((data: Uint8Array) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = true;
  private vin = 20.06;

  constructor(baudRate = 9600) {
    this.baudRate = baudRate;
  }

  async open(): Promise<void> {
    this.openCount++;
    this.closed = false;
    // schedule telemetry pushing until closed
    this.timer = setInterval(() => this.pushTelemetry(), 600);
  }

  private pushTelemetry(): void {
    if (this.closed) return;
    const chunks: Uint8Array[] = [
      frame(0xc3, concat(f32(0.0), f32(0.0), f32(0.0))), // Vout/Iout/Pout idle
      frame(0xc0, f32(this.vin)),
      frame(0xe2, f32(this.vin - 0.2)),
      frame(0xe3, f32(5.1)),
      frame(0xc4, f32(30.0)),
    ];
    this.emit(chunks);
  }

  private emit(chunks: Uint8Array[]): void {
    for (const c of chunks) this.handler?.(c);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('fake transport closed');
    this.txFrames.push(bytes);
    // respond like the real device
    const reg = bytes[2];
    const group = bytes[1];
    const len = bytes[3];
    const payload = bytes.subarray(4, 4 + len);
    if (group === 0xb1 && reg === 0xc1) this.lastSet = { ...this.lastSet, v: payload.slice() };
    if (group === 0xb1 && reg === 0xc2) this.lastSet = { ...this.lastSet, a: payload.slice() };
    await new Promise((r) => setTimeout(r, 5));
    if (group === GROUP.SESSION) return; // telemetry auto-push after open
    if (group !== GROUP.READ) return;
    switch (reg) {
      case 0xe1:
        this.emit([frame(0xe1, new Uint8Array([1]))]);
        break;
      case 0xde:
        this.emit([frame(0xde, ascii('DPS-150P'))]);
        break;
      case 0xdf:
        this.emit([frame(0xdf, ascii('V1.0'))]);
        break;
      case 0xe0:
        this.emit([frame(0xe0, ascii('V1.6'))]);
        break;
      case 0xff: {
        const snap = GOLDEN_FF.slice();
        // reflect current setpoint bytes written earlier (C1/C2) into offsets 4/8
        const ls = this.lastSet;
        if (ls) {
          snap.set(ls.v ?? new Uint8Array(4), 4);
          snap.set(ls.a ?? new Uint8Array(4), 8);
        }
        this.emit([frame(0xff, snap)]);
        break;
      }
      default:
        break;
    }
  }

  private lastSet: { v?: Uint8Array; a?: Uint8Array } = {};

  setDataHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onClose?.('fake closed');
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

export function parseTx(bytes: Uint8Array): { group: number; reg: number; len: number; payload: Uint8Array } {
  return { group: bytes[1], reg: bytes[2], len: bytes[3], payload: bytes.subarray(4, 4 + bytes[3]) };
}

export { hexToBytes, HEADER_RX, HEADER_TX };
