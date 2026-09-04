// Protocol constants derived from static analysis of the official FNIRSI app,
// the fnirst-power-cli serial logs and real-device measurements (see the project docs).

export const HEADER_TX = 0xf1; // host -> device
export const HEADER_RX = 0xf0; // device -> host

export const GROUP = {
  /** read/query + device responses */
  READ: 0xa1,
  /** register write */
  WRITE: 0xb1,
  /** session control (open/close) */
  SESSION: 0xc1,
  /** baud rate announce */
  BAUD: 0xb0,
  /** system (session-related special) */
  SYSTEM: 0xc0,
} as const;

export type Group = (typeof GROUP)[keyof typeof GROUP];

/** Register addresses. RX (device->host) and TX (host->device) share the same byte space. */
export const REG = {
  // -------- TX: settings (float32 LE) --------
  SET_VOLTAGE: 0xc1, // output voltage setpoint
  SET_CURRENT: 0xc2, // current limit

  // TX: preset memory M1..M6 (V = C5+2*(n-1), A = C6+2*(n-1)) -> write-only slots,
  // reading them back happens through the FF snapshot.
  presetVoltage: (n: number) => 0xc5 + 2 * (n - 1),
  presetCurrent: (n: number) => 0xc6 + 2 * (n - 1),

  // TX: protections (float32)
  OVP: 0xd1,
  OCP: 0xd2,
  OPP: 0xd3,
  OTP: 0xd4,
  LVP: 0xd5,

  // TX: system bytes
  BRIGHTNESS: 0xd6, // u8
  VOLUME: 0xd7, // u8
  METERING: 0xd8, // u8: 1 = on (device pushes D9/DA), 0 = off
  OUTPUT: 0xdb, // u8: 1 = RUN, 0 = STOP

  // -------- RX telemetry (device push, ~500-700ms period) --------
  VIN: 0xc0, // float32 input voltage
  MEAS: 0xc3, // 12B: vout, iout, pout (3x float32)
  TEMP: 0xc4, // float32 internal temperature C
  CAPACITY_AH: 0xd9, // float32 accumulated Ah (with metering on + RUN)
  ENERGY_WH: 0xda, // float32 accumulated Wh
  OUT_STATE: 0xdb, // u8 echo/push: 1 RUN 0 STOP
  PROTECTION: 0xdc, // u8 push on change
  MODE: 0xdd, // u8 push on change: 0 CC 1 CV
  IDENT: 0xe1, // u8 identity/model code (DPS-150P -> 1)
  MAX_VOLTAGE: 0xe2, // float32 upper voltage limit (~ vin - 0.2)
  MAX_CURRENT: 0xe3, // float32 upper current limit (~ 5.1)

  // -------- info queries (TX with zero payload; RX string/bytes) --------
  MODEL_NAME: 0xde, // ASCII string, e.g. "DPS-150P"
  HW_VERSION: 0xdf, // ASCII string, e.g. "V1.0"
  FW_VERSION: 0xe0, // ASCII string, e.g. "V1.6"

  // -------- full memory snapshot (139 bytes) --------
  SNAPSHOT: 0xff,
} as const;

export const PROTECTION_STATES = ['OK', 'OVP', 'OCP', 'OPP', 'OTP', 'LVP', 'REP'] as const;
export type ProtectionState = (typeof PROTECTION_STATES)[number] | 'UNKNOWN';

export const BAUDS = [9600, 19200, 38400, 57600, 115200] as const;
export type Baud = (typeof BAUDS)[number];
/** payload byte for REG.BAUD announce: index into BAUDS + 1 */
export function baudCode(baud: number): number {
  const i = BAUDS.indexOf(baud as (typeof BAUDS)[number]);
  if (i < 0) throw new Error(`unsupported baud ${baud}`);
  return i + 1;
}

export const SNAPSHOT_LEN = 139;
