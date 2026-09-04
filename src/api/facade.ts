// Full-capability automation API facade.
// Exposed as window.dps150 in the browser console and usable from the scripting tab.
// All writes are serialized by the controller and followed by a snapshot refresh so
// the returned/observable state reflects the device.

import type { DeviceController, LogEntry } from '../device/controller';
import type { DeviceState } from '../protocol/types';

export type ProtectionKind = 'ovp' | 'ocp' | 'opp' | 'otp' | 'lvp';

export const PROTECTION_REGS: Record<ProtectionKind, number> = {
  ovp: 0xd1,
  ocp: 0xd2,
  opp: 0xd3,
  otp: 0xd4,
  lvp: 0xd5,
};

export interface Dps150Api {
  readonly version: string;
  readonly connected: boolean;
  readonly state: DeviceState;
  /** request a port from the browser chooser and connect */
  connect(): Promise<DeviceState>;
  disconnect(): Promise<void>;
  setVoltage(v: number): Promise<void>;
  setCurrent(a: number): Promise<void>;
  setOutput(run: boolean): Promise<void>;
  /** true -> RUN, false -> STOP */
  enableOutput(): Promise<void>;
  disableOutput(): Promise<void>;
  setProtection(kind: ProtectionKind, value: number): Promise<void>;
  setBrightness(v: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  setMetering(on: boolean): Promise<void>;
  /** write preset slot n (1..6). Does NOT touch the main setpoint. */
  setPreset(n: number, voltage: number, current: number): Promise<void>;
  /** official "load preset": slot + mirror into main setpoint */
  loadPreset(n: number): Promise<void>;
  refresh(): Promise<void>;
  /** subscribe: returns unsubscribe fn */
  onTelemetry(cb: (s: DeviceState) => void): () => void;
  onState(cb: (s: DeviceState) => void): () => void;
  onLog(cb: (e: LogEntry) => void): () => void;
}

export function createApi(device: DeviceController): Dps150Api {
  const on = <K extends 'state' | 'telemetry' | 'log'>(
    kind: K,
    cb: (e: K extends 'log' ? LogEntry : DeviceState) => void,
  ): (() => void) => device.on(kind, cb as never);

  return {
    version: '0.1.0',
    get connected(): boolean {
      return device.isOpen();
    },
    get state(): DeviceState {
      return device.getState();
    },
    async connect(): Promise<DeviceState> {
      const { WebSerialTransport } = await import('../serial/transport');
      if (!('serial' in navigator)) throw new Error('Web Serial API unavailable (need Chromium + https/localhost)');
      const port = await navigator.serial.requestPort();
      return device.connect(new WebSerialTransport(port, device.baudRate));
    },
    async disconnect(): Promise<void> {
      await device.disconnect();
    },
    setVoltage: (v) => device.setVoltage(v),
    setCurrent: (a) => device.setCurrent(a),
    setOutput: (run) => device.setOutput(run),
    enableOutput: () => device.setOutput(true),
    disableOutput: () => device.setOutput(false),
    setProtection: (kind, value) => device.setProtection(PROTECTION_REGS[kind], value),
    setBrightness: (v) => device.setBrightness(v),
    setVolume: (v) => device.setVolume(v),
    setMetering: (on) => device.setMetering(on),
    setPreset: (n, v, a) => device.setPreset(n, v, a),
    loadPreset: (n) => device.loadPreset(n),
    refresh: () => device.refreshSnapshot(),
    onTelemetry: (cb) => on('telemetry', cb),
    onState: (cb) => on('state', cb),
    onLog: (cb) => on('log', cb),
  };
}

declare global {
  interface Window {
    dps150?: Dps150Api;
  }
}
