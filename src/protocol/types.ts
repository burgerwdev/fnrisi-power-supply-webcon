// Device model types (single source of truth consumed by UI / API / scripting).

export type OutputState = 'STOP' | 'RUN';
export type CvCc = 'CC' | 'CV';
export type ProtectionState = 'OK' | 'OVP' | 'OCP' | 'OPP' | 'OTP' | 'LVP' | 'REP' | 'UNKNOWN';

export interface Telemetry {
  ts: number; // epoch ms of last update
  inputVoltage?: number;
  outputVoltage?: number;
  outputCurrent?: number;
  outputPower?: number;
  temperature?: number;
  capacityAh?: number;
  energyWh?: number;
}

export interface StatusBits {
  output: OutputState;
  protection: ProtectionState;
  mode: CvCc;
}

export interface DeviceInfo {
  modelName?: string; // DE "DPS-150P"
  hwVersion?: string; // DF "V1.0"
  fwVersion?: string; // E0 "V1.6"
  ident?: number; // E1 byte (1 for DPS-150P)
}

export interface Limits {
  maxVoltage?: number; // E2 (~ vin - 0.2)
  maxCurrent?: number; // E3 (~ 5.1)
}

export interface ProtectionSettings {
  ovp?: number;
  ocp?: number;
  opp?: number;
  otp?: number;
  lvp?: number;
}

export interface Preset {
  voltage: number;
  current: number;
}

export interface DeviceSettings {
  voltageSet?: number;
  currentSet?: number;
  brightness?: number;
  volume?: number;
  meteringOn?: boolean;
}

export interface DeviceState {
  connected: boolean;
  info: DeviceInfo;
  telemetry: Telemetry;
  status: StatusBits;
  limits: Limits;
  settings: DeviceSettings;
  presets: Preset[]; // M1..M6
  protections: ProtectionSettings;
  /** FF snapshot raw bytes (139) of the last full refresh, if any */
  lastSnapshot?: Uint8Array;
  /** device-push cadence in ms between full telemetry groups (rolling estimate) */
  telemetryPeriodMs?: number;
}

export function emptyDeviceState(): DeviceState {
  return {
    connected: false,
    info: {},
    telemetry: { ts: 0 },
    status: { output: 'STOP', protection: 'UNKNOWN', mode: 'CV' },
    limits: {},
    settings: {},
    presets: Array.from({ length: 6 }, () => ({ voltage: 0, current: 0 })),
    protections: {},
  };
}
