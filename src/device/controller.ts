// Device controller: owns the serial transport, runs the session/init sequence,
// parses incoming frames into a DeviceState and exposes safe command methods.

import { GROUP, HEADER_RX, HEADER_TX, REG, SNAPSHOT_LEN, baudCode } from '../protocol/const';
import { decodeRx, decodeSnapshot } from '../protocol/decode';
import { encodeFrame, float32Bytes, hex, parseFrame, type Frame } from '../protocol/frame';
import { FrameParser } from '../protocol/parser';
import { emptyDeviceState, type DeviceState } from '../protocol/types';
import type { SerialTransport } from '../serial/transport';
import { t } from '../i18n';

export type LogLevel = 'tx' | 'rx' | 'info' | 'warn' | 'error';
export interface LogEntry {
  t: number;
  level: LogLevel;
  text: string;
  frame?: Uint8Array;
}

export interface DeviceEvents {
  state: (s: DeviceState) => void;
  log: (e: LogEntry) => void;
  error: (err: Error) => void;
  telemetry: (s: DeviceState) => void; // emitted on every decoded push
  closed: (reason: string) => void;
}

const TELEMETRY_REGS = new Set([0xc0, 0xc3, 0xc4, 0xd9, 0xda, 0xe2, 0xe3]);

export class DeviceController {
  private parser = new FrameParser();
  private state: DeviceState = emptyDeviceState();
  private transport: SerialTransport | null = null;
  private listeners: { [K in keyof DeviceEvents]: Set<DeviceEvents[K]> } = {
    state: new Set(),
    log: new Set(),
    error: new Set(),
    telemetry: new Set(),
    closed: new Set(),
  };
  private writeQueue: Promise<void> = Promise.resolve();
  private lastGroupTs = 0;
  private rxSeen = false;
  private snapResolve: (() => void) | null = null;

  constructor(private readonly baud = 115200) {}

  get baudRate(): number {
    return this.baud;
  }

  /** subscribe to an event; returns an unsubscribe function */
  on<K extends keyof DeviceEvents>(ev: K, fn: DeviceEvents[K]): () => void {
    this.listeners[ev].add(fn);
    return () => this.listeners[ev].delete(fn);
  }

  private emit<K extends keyof DeviceEvents>(ev: K, arg: Parameters<DeviceEvents[K]>[0]): void {
    for (const fn of [...this.listeners[ev]]) {
      (fn as (a: typeof arg) => void)(arg);
    }
  }

  getState(): DeviceState {
    return this.state;
  }

  isOpen(): boolean {
    return this.state.connected;
  }

  // ---------- lifecycle ----------

  async connect(transport: SerialTransport): Promise<DeviceState> {
    // close any previous transport first (avoids "port already open / device lost" on retries)
    const old = this.transport;
    if (old) {
      old.setDataHandler(null);
      try {
        if ((old as { onError?: unknown }).onError) await old.close();
      } catch (err) {
        this.log('warn', t('log.closeOldFailed').replace('{e}', String(err)));
      }
      this.transport = null;
    }
    this.transport = transport;
    this.wireTransport(transport);
    const actualBaud = transport.baudRate || this.baud;
    try {
      await transport.open();
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    Object.assign(this.state, emptyDeviceState());
    this.state.connected = true;
    this.rxSeen = false;
    this.emitState();
    await this.initSession(actualBaud);
    await this.ensureTraffic(actualBaud);
    return this.state;
  }

  /** attach data handler + diagnostics + auto-recovery to a transport */
  private wireTransport(transport: SerialTransport): void {
    transport.setDataHandler((data) => this.onData(data));
    transport.onError = (err) => {
      const msg = String(err);
      this.log('error', t('log.serialReadErr').replace('{e}', msg));
      if (/device has been lost|disconnected|failed/i.test(msg)) {
        this.log(
          'warn',
          t('log.readLost'),
        );
        void this.recoverOnce();
      } else {
        this.log('info', t('log.readRetry'));
      }
    };
    transport.onClose = (reason) => {
      if (this.state.connected && !this.recovering) this.log('warn', t('log.readClosed').replace('{r}', reason));
    };
  }

  private recovering = false;
  private recoveredOnce = false;

  /** close + reopen + re-init once after a lost read stream */
  private async recoverOnce(): Promise<void> {
    if (this.recovering || this.recoveredOnce || !this.transport || !this.state.connected) return;
    this.recovering = true;
    this.recoveredOnce = true;
    const tp = this.transport;
    const baud = tp.baudRate || this.baud;
    try {
      this.log('warn', t('log.autoRecover'));
      this.state.connected = false;
      this.emitState();
      await tp.close();
      await this.sleep(300);
      this.wireTransport(tp);
      await tp.open();
      this.state.connected = true;
      this.rxSeen = false;
      this.emitState();
      await this.initSession(baud);
      await this.ensureTraffic(baud);
      if (this.rxSeen) this.log('info', t('log.autoRecovered'));
      else this.log('warn', t('log.autoRecoverNoData'));
    } catch (err) {
      this.log('error', t('log.autoRecoverFailed').replace('{e}', String(err)));
      this.state.connected = false;
      this.emitState();
    } finally {
      this.recovering = false;
    }
  }

  /** send session enable + init queries */
  private async initSession(baud: number): Promise<void> {
    const flow = (this.transport as { flowControlUsed?: string } | null)?.flowControlUsed;
    this.log('info', t('log.transportOpen').replace('{kind}', (this.transport as {kind?:string})?.kind ?? '?').replace('{baud}', String(baud)).replace('{fc}', flow ?? '?'));
    // session enable (CMD_1)
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.SESSION, 0x00, 1));
    // identity query (E1) - DPS-150P replies 1
    await this.sleep(60);
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.READ, REG.IDENT, 0));
    // commandInit subset: baud announce + info + snapshot (announce with the ACTUAL port baud)
    await this.sleep(80);
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.BAUD, 0x00, baudCode(baud)));
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.READ, REG.MODEL_NAME, 0));
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.READ, REG.HW_VERSION, 0));
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.READ, REG.FW_VERSION, 0));
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.READ, REG.SNAPSHOT, 0));
  }

  /** watchdog: retry session enable once, then report; returns whether traffic was seen */
  private async ensureTraffic(baud: number): Promise<boolean> {
    const got = await this.waitTraffic(1800);
    if (!got) {
      this.log('warn', t('log.noTraffic'));
      await this.sendFrame(encodeFrame(HEADER_TX, GROUP.SESSION, 0x00, 1));
      const got2 = await this.waitTraffic(1600);
      if (!got2) {
        this.log(
          'warn',
          t('log.noTrafficTip'),
        );
        void baud;
      }
    } else {
      this.log('info', t('log.trafficOk'));
      void this.ensureInfo();
    }
    return this.rxSeen;
  }

  /** re-query device info strings that did not arrive (device occasionally drops one) */
  private async ensureInfo(): Promise<void> {
    await this.sleep(600);
    const want: [number, () => string | undefined][] = [
      [REG.MODEL_NAME, () => this.state.info.modelName],
      [REG.HW_VERSION, () => this.state.info.hwVersion],
      [REG.FW_VERSION, () => this.state.info.fwVersion],
    ];
    for (const [reg, get] of want) {
      if (!this.state.connected) return;
      if (get() !== undefined) continue;
      await this.sendFrame(encodeFrame(HEADER_TX, GROUP.READ, reg, 0));
      await this.sleep(350);
    }
  }

  async disconnect(reason = 'user'): Promise<void> {
    try {
      if (this.transport) {
        const tp = this.transport as { rxBytes?: number; rxChunks?: number; readLoops?: number };
        if (typeof tp.rxBytes === 'number') {
          this.log('info', t('log.sessionStats').replace('{rx}', String(tp.rxBytes)).replace('{chunks}', String(tp.rxChunks ?? 0)).replace('{loops}', String(tp.readLoops ?? 1)));
        }
        if (this.state.connected) {
          await this.sendFrame(encodeFrame(HEADER_TX, GROUP.SESSION, 0x00, 0)); // CMD_2 graceful
          await this.sleep(30);
        }
        await this.transport.close();
      }
    } catch (err) {
      this.log('warn', `close error: ${String(err)}`);
    } finally {
      this.state.connected = false;
      this.emitState();
      this.disposeTransport();
      this.emit('closed', reason);
    }
  }

  private disposeTransport(): void {
    if (this.transport) {
      this.transport.setDataHandler(null);
      this.transport = null;
    }
  }

  // ---------- data path ----------

  private onData(data: Uint8Array): void {
    this.rxSeen = true;
    this.parser.push(data, (f) => this.onFrame(f));
  }

  /** resolve true as soon as any RX arrives within ms */
  private waitTraffic(ms: number): Promise<boolean> {
    if (this.rxSeen) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + ms;
      const poll = (): void => {
        if (this.rxSeen || Date.now() >= deadline) {
          resolve(this.rxSeen);
        } else {
          setTimeout(poll, 60);
        }
      };
      poll();
    });
  }

  private onFrame(f: Frame): void {
    if (f.header !== HEADER_RX) return;
    const now = Date.now();
    if (TELEMETRY_REGS.has(f.reg)) {
      if (this.lastGroupTs) {
        const since = now - this.lastGroupTs;
        if (since > 0 && since < 3000) {
          this.state.telemetryPeriodMs = this.state.telemetryPeriodMs
            ? Math.round(this.state.telemetryPeriodMs * 0.7 + since * 0.3)
            : since;
        }
      }
      this.lastGroupTs = now;
    }
    const regHex = f.reg.toString(16).padStart(2, '0');
    this.log('rx', `RX reg=${regHex} len=${f.len}`, frameBytes(f));
    this.applyFrame(f);
    this.emit('telemetry', this.state);
  }

  private applyFrame(f: Frame): void {
    const r = decodeRx(f.reg, f.payload);
    const s = this.state;
    switch (r.kind) {
      case 'telemetry':
        Object.assign(s.telemetry, r.telemetry, { ts: Date.now() });
        break;
      case 'status':
        Object.assign(s.status, r.status);
        break;
      case 'info':
        Object.assign(s.info, r.info);
        break;
      case 'limit':
        Object.assign(s.limits, r.limits);
        break;
      case 'snapshot':
        if (r.snapshot) {
          const snap = decodeSnapshot(r.snapshot);
          Object.assign(s.telemetry, snap.telemetry);
          Object.assign(s.status, snap.status);
          Object.assign(s.limits, snap.limits);
          Object.assign(s.settings, snap.settings);
          Object.assign(s.protections, snap.protections);
          s.presets = snap.presets;
          s.lastSnapshot = r.snapshot;
        }
        break;
      default:
        break;
    }
    if (f.reg !== 0xff || r.kind === 'snapshot') {
      this.emitState();
      if (this.snapResolve) {
        const r2 = this.snapResolve;
        this.snapResolve = null;
        r2();
      }
    }
  }

  private emitState(): void {
    this.emit('state', this.state);
  }

  // ---------- TX commands (safe wrappers) ----------

  /** Serialize all writes (avoid interleaving partial commands). */
  private async sendFrame(bytes: Uint8Array): Promise<void> {
    const t = this.transport;
    if (!t) throw new Error('not connected');
    this.log('tx', hex(bytes), bytes);
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await t.write(bytes);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    });
    return this.writeQueue;
  }

  async setVoltage(v: number): Promise<void> {
    const max = this.state.limits.maxVoltage ?? Infinity;
    const clamped = Math.min(v, max);
    if (clamped !== v) this.log('warn', t('log.voltageClamped').replace('{v}', String(v)).replace('{max}', String(max)));
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.WRITE, REG.SET_VOLTAGE, float32Bytes(clamped)));
    await this.sleep(40);
    await this.readAndWaitSnapshot();
  }

  async setCurrent(a: number): Promise<void> {
    const max = this.state.limits.maxCurrent ?? Infinity;
    const clamped = Math.min(a, max);
    if (clamped !== a) this.log('warn', t('log.currentClamped').replace('{a}', String(a)).replace('{max}', String(max)));
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.WRITE, REG.SET_CURRENT, float32Bytes(clamped)));
    await this.sleep(40);
    await this.readAndWaitSnapshot();
  }

  async setOutput(run: boolean): Promise<void> {
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.WRITE, REG.OUTPUT, run ? 1 : 0));
    await this.sleep(80);
    await this.readAndWaitSnapshot();
  }

  async setProtection(reg: number, value: number): Promise<void> {
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.WRITE, reg, float32Bytes(value)));
    await this.sleep(60);
    await this.readAndWaitSnapshot();
  }

  async setBrightness(v: number): Promise<void> {
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.WRITE, REG.BRIGHTNESS, Math.round(v)));
    await this.sleep(60);
    await this.readAndWaitSnapshot();
  }

  async setVolume(v: number): Promise<void> {
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.WRITE, REG.VOLUME, Math.round(v)));
    await this.sleep(60);
    await this.readAndWaitSnapshot();
  }

  async setMetering(on: boolean): Promise<void> {
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.WRITE, REG.METERING, on ? 1 : 0));
    await this.sleep(60);
  }

  /** Session lock switch: locked=true sends CMD_1 (session enabled, panel may be locked); false sends CMD_2 (session closed, panel operable). */
  async setPanelLock(locked: boolean): Promise<void> {
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.SESSION, 0x00, locked ? 1 : 0));
    await this.sleep(60);
    if (locked) await this.readAndWaitSnapshot();
  }

  /** write a preset slot (M1..M6). Note: does NOT change the main setpoint. */
  async setPreset(n: number, voltage: number, current: number): Promise<void> {
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.WRITE, REG.presetVoltage(n), float32Bytes(voltage)));
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.WRITE, REG.presetCurrent(n), float32Bytes(current)));
    await this.sleep(80);
    await this.readAndWaitSnapshot();
  }

  /** official "load preset" behaviour: write slot AND mirror into main setpoint */
  async loadPreset(n: number): Promise<void> {
    const p = this.state.presets[n - 1];
    if (!p) throw new Error(`preset ${n} out of range`);
    await this.setVoltage(p.voltage);
    await this.setCurrent(p.current);
  }

  /** full snapshot refresh (fire-and-forget if caller just wants state pulled) */
  async refreshSnapshot(): Promise<void> {
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.READ, REG.SNAPSHOT, 0));
  }

  /** Register a waiter for the "next snapshot arrival", so state is the device's latest value when a write returns. */
  private expectSnapshot(timeoutMs = 900): Promise<void> {
    if (this.snapResolve) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.snapResolve = resolve;
      setTimeout(() => {
        if (this.snapResolve === resolve) this.snapResolve = null;
        resolve();
      }, timeoutMs);
    });
  }
  /** Send a snapshot read and wait for it to actually apply (eliminates the flipping caused by reading stale values). */
  private async readAndWaitSnapshot(): Promise<void> {
    const p = this.expectSnapshot();
    await this.sendFrame(encodeFrame(HEADER_TX, GROUP.READ, REG.SNAPSHOT, 0));
    await p;
  }

  // ---------- helpers ----------

  private log(level: LogLevel, text: string, frame?: Uint8Array): void {
    const e: LogEntry = { t: Date.now(), level, text, frame };
    this.emit('log', e);
    if (level === 'error') {
      this.emit('error', new Error(text));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

}

function frameBytes(f: Frame): Uint8Array {
  const out = new Uint8Array(f.payload.length + 5);
  out[0] = f.header;
  out[1] = f.group;
  out[2] = f.reg;
  out[3] = f.len;
  out.set(f.payload, 4);
  out[out.length - 1] = f.chk;
  return out;
}

export { SNAPSHOT_LEN, parseFrame };
