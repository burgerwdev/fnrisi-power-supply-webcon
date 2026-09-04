// Human-readable description of a protocol frame (for the TX/RX debug log).
// Given the raw bytes we decode the group/register name and, when the payload is
// meaningful, interpret the data so the user can see what each message means.

import { GROUP, HEADER_TX, REG } from './const';
import { t } from '../i18n';
import { asciiString, readFloat32 } from './frame';

const GROUP_NAME: Record<number, string> = {
  [GROUP.READ]: t('reg.gRead'),
  [GROUP.WRITE]: t('reg.gWrite'),
  [GROUP.SESSION]: t('reg.gSession'),
  [GROUP.BAUD]: t('reg.gBaud'),
  [GROUP.SYSTEM]: t('reg.gSystem'),
};

const REG_NAME: Record<number, string> = {
  [REG.SET_VOLTAGE]: t('reg.setVoltage'),
  [REG.SET_CURRENT]: t('reg.setCurrent'),
  [REG.OVP]: t('reg.ovp'),
  [REG.OCP]: t('reg.ocp'),
  [REG.OPP]: t('reg.opp'),
  [REG.OTP]: t('reg.otp'),
  [REG.LVP]: t('reg.lvp'),
  [REG.BRIGHTNESS]: t('reg.brightness'),
  [REG.VOLUME]: t('reg.volume'),
  [REG.METERING]: t('reg.metering'),
  [REG.OUT_STATE]: t('reg.outState'),
  [REG.VIN]: t('reg.vin'),
  [REG.MEAS]: t('reg.meas'),
  [REG.TEMP]: t('reg.temp'),
  [REG.CAPACITY_AH]: t('reg.capacityAh'),
  [REG.ENERGY_WH]: t('reg.energyWh'),
  [REG.PROTECTION]: t('reg.protection'),
  [REG.MODE]: t('reg.mode'),
  [REG.IDENT]: t('reg.ident'),
  [REG.MAX_VOLTAGE]: t('reg.maxVoltage'),
  [REG.MAX_CURRENT]: t('reg.maxCurrent'),
  [REG.MODEL_NAME]: t('reg.modelName'),
  [REG.HW_VERSION]: t('reg.hwVersion'),
  [REG.FW_VERSION]: t('reg.fwVersion'),
  [REG.SNAPSHOT]: t('reg.snapshot'),
};

function regLabel(reg: number): string {
  const base = REG_NAME[reg];
  if (base) return `${base}(C${reg.toString(16)})`;
  if (reg >= 0xc5 && reg <= 0xca) {
    const n = Math.floor((reg - 0xc5) / 2) + 1;
    return t('reg.presetV').replace('{n}', String(n)) + ((reg - 0xc5) % 2 === 0 ? '' : t('reg.presetA').replace('{n}', String(n)));
  }
  return `C${reg.toString(16)}`;
}

function fstr(v: number, d: number): string {
  return v.toFixed(d);
}

/** interpret a payload for a known register */
function describePayload(reg: number, payload: Uint8Array): string {
  const len = payload.length;
  // info strings
  if (reg === REG.MODEL_NAME || reg === REG.HW_VERSION || reg === REG.FW_VERSION) {
    const s = asciiString(payload);
    return s ? `=${JSON.stringify(s)}` : t('reg.empty');
  }
  if (reg === REG.IDENT) return payload.length ? `=${payload[0]}` : t('reg.empty');
  if (reg === REG.SNAPSHOT) return `len=${len}`;
  if (reg === REG.MEAS && len === 12) {
    return `= ${fstr(readFloat32(payload, 0), 3)}V / ${fstr(readFloat32(payload, 4), 3)}A / ${fstr(readFloat32(payload, 8), 3)}W`;
  }
  // float32 payloads
  if (len === 4) {
    const v = readFloat32(payload, 0);
    return `=${fstr(v, 4)}`;
  }
  // single byte payloads
  if (len === 1) {
    const b = payload[0];
    if (reg === REG.OUTPUT || reg === REG.OUT_STATE) return b === 1 ? '=1(RUN '+t('reg.outOn')+')' : '=0(STOP '+t('reg.outOff')+')';
    if (reg === REG.METERING) return b === 1 ? '=1('+t('reg.meterOn')+')' : '=0('+t('reg.meterOff')+')';
    if (reg === REG.PROTECTION) return `=0x${b.toString(16)}`;
    if (reg === REG.MODE) return b === 0 ? '=0(CC '+t('reg.ccMode')+')' : '=1(CV '+t('reg.cvMode')+')';
    if (reg === REG.SET_VOLTAGE || reg === REG.SET_CURRENT) return `=0x${b.toString(16)}`;
    return `=0x${b.toString(16)}`;
  }
  return len ? `len=${len}` : t('reg.noData');
}

function payloadPreview(payload: Uint8Array): string {
  if (!payload.length) return '';
  const hexs = Array.from(payload.slice(0, 8), (x) => x.toString(16).padStart(2, '0')).join(' ');
  return ` [${hexs}${payload.length > 8 ? ' …' : ''}]`;
}

export function describeFrame(bytes: Uint8Array): string {
  if (bytes.length < 5) return `${t('reg.shortFrame')} len=${bytes.length})`;
  const header = bytes[0];
  const group = bytes[1];
  const reg = bytes[2];
  const len = bytes[3];
  const payload = bytes.subarray(4, 4 + len);
  const toHost = header === HEADER_TX;
  const dir = toHost ? t('reg.dirSend') : t('reg.dirRecv');
  const arrow = toHost ? '→' : '←';
  const gname = GROUP_NAME[group] ?? `G${group.toString(16)}`;
  const label = regLabel(reg);
  const detail = describePayload(reg, payload);
  const preview = payloadPreview(payload);
  return `${arrow}${dir} [${gname} 0x${(group).toString(16).padStart(2, '0')}] ${label} ${detail}${preview}`;
}

export { GROUP_NAME, REG_NAME };
