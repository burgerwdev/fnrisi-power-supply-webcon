// RX payload decoders: per-register telemetry and the 139-byte FF full snapshot.
// Layout documented in the project docs §7 (confirmed on real hardware).

import { PROTECTION_STATES, SNAPSHOT_LEN, type ProtectionState } from './const';
import { asciiString, readFloat32 } from './frame';
import type {
  DeviceInfo,
  DeviceSettings,
  Limits,
  Preset,
  ProtectionSettings,
  StatusBits,
  Telemetry,
} from './types';

export function decodeProtection(u: number): ProtectionState {
  return (PROTECTION_STATES[u] as ProtectionState | undefined) ?? 'UNKNOWN';
}

export function decodeTelemetry(reg: number, payload: Uint8Array, out: Telemetry): void {
  switch (reg) {
    case 0xc0: // input voltage
      if (payload.length === 4) out.inputVoltage = readFloat32(payload, 0);
      break;
    case 0xc3: // measured vout / iout / pout
      if (payload.length === 12) {
        out.outputVoltage = readFloat32(payload, 0);
        out.outputCurrent = readFloat32(payload, 4);
        out.outputPower = readFloat32(payload, 8);
      }
      break;
    case 0xc4:
      if (payload.length === 4) out.temperature = readFloat32(payload, 0);
      break;
    case 0xd9:
      if (payload.length === 4) out.capacityAh = readFloat32(payload, 0);
      break;
    case 0xda:
      if (payload.length === 4) out.energyWh = readFloat32(payload, 0);
      break;
    default:
      break;
  }
}

export interface DecodeResult {
  kind: 'telemetry' | 'status' | 'info' | 'limit' | 'snapshot' | 'unknown';
  telemetry?: Partial<Telemetry>;
  status?: Partial<StatusBits>;
  info?: Partial<DeviceInfo>;
  limits?: Partial<Limits>;
  settings?: Partial<DeviceSettings>;
  snapshot?: Uint8Array;
  protections?: Partial<ProtectionSettings>;
  presets?: Preset[];
  raw?: { reg: number; payload: Uint8Array };
}

/** Decode one RX frame payload by register. Returns null when nothing meaningful. */
export function decodeRx(reg: number, payload: Uint8Array): DecodeResult {
  switch (reg) {
    case 0xc0:
    case 0xc3:
    case 0xc4:
    case 0xd9:
    case 0xda: {
      const telemetry: Partial<Telemetry> = {};
      decodeTelemetry(reg, payload, telemetry as Telemetry);
      return { kind: 'telemetry', telemetry };
    }
    case 0xdb:
      return {
        kind: 'status',
        status: { output: payload[0] === 1 ? 'RUN' : 'STOP' },
        raw: { reg, payload },
      };
    case 0xdc:
      return {
        kind: 'status',
        status: { protection: decodeProtection(payload[0]) },
        raw: { reg, payload },
      };
    case 0xdd:
      return {
        kind: 'status',
        status: { mode: payload[0] === 0 ? 'CC' : 'CV' },
        raw: { reg, payload },
      };
    case 0xde:
      return { kind: 'info', info: { modelName: asciiString(payload) }, raw: { reg, payload } };
    case 0xdf:
      return { kind: 'info', info: { hwVersion: asciiString(payload) }, raw: { reg, payload } };
    case 0xe0:
      return { kind: 'info', info: { fwVersion: asciiString(payload) }, raw: { reg, payload } };
    case 0xe1:
      return { kind: 'info', info: { ident: payload[0] }, raw: { reg, payload } };
    case 0xe2:
      return payload.length === 4
        ? { kind: 'limit', limits: { maxVoltage: readFloat32(payload, 0) }, raw: { reg, payload } }
        : { kind: 'unknown', raw: { reg, payload } };
    case 0xe3:
      return payload.length === 4
        ? { kind: 'limit', limits: { maxCurrent: readFloat32(payload, 0) }, raw: { reg, payload } }
        : { kind: 'unknown', raw: { reg, payload } };
    case 0xff:
      if (payload.length >= SNAPSHOT_LEN) return { kind: 'snapshot', snapshot: payload.subarray(0, SNAPSHOT_LEN) };
      return { kind: 'unknown', raw: { reg, payload } };
    default:
      return { kind: 'unknown', raw: { reg, payload } };
  }
}

// ---------- FF snapshot (139 bytes) ----------

export interface FullSnapshot {
  telemetry: Telemetry;
  settings: DeviceSettings;
  status: StatusBits;
  limits: Limits;
  presets: Preset[];
  protections: ProtectionSettings;
  /** static rating constants at offsets 119..139 */
  rating: { ovpMax: number; ocpMax: number; oppMax: number; otpMax: number; lvpMax: number };
}

export function decodeSnapshot(p: Uint8Array): FullSnapshot {
  if (p.length < SNAPSHOT_LEN) throw new Error(`snapshot too short: ${p.length}`);
  const fl = (o: number) => readFloat32(p, o);
  const presets: Preset[] = [];
  for (let i = 0; i < 6; i++) {
    presets.push({ voltage: fl(28 + i * 8), current: fl(32 + i * 8) });
  }
  return {
    telemetry: {
      ts: Date.now(),
      inputVoltage: fl(0),
      outputVoltage: fl(12),
      outputCurrent: fl(16),
      outputPower: fl(20),
      temperature: fl(24),
      capacityAh: fl(99),
      energyWh: fl(103),
    },
    settings: {
      voltageSet: fl(4),
      currentSet: fl(8),
      brightness: p[96],
      volume: p[97],
      meteringOn: p[98] === 1,
    },
    status: {
      output: p[107] === 1 ? 'RUN' : 'STOP',
      protection: decodeProtection(p[108]),
      mode: p[109] === 0 ? 'CC' : 'CV',
    },
    limits: { maxVoltage: fl(111), maxCurrent: fl(115) },
    presets,
    protections: {
      ovp: fl(76),
      ocp: fl(80),
      opp: fl(84),
      otp: fl(88),
      lvp: fl(92),
    },
    rating: { ovpMax: fl(119), ocpMax: fl(123), oppMax: fl(127), otpMax: fl(131), lvpMax: fl(135) },
  };
}
