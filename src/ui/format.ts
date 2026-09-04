// Numeric display normalization (per user spec):
// voltage = 2 decimals (e.g. 5.00) / current dynamic mA/A (0.001 mA precision) / power 2-decimal W;
// energy/capacity 0000.000 (3 decimals) Ah/Wh; duration 00:00:00.

export type FmtField =
  | 'vin' | 'vout' | 'iout' | 'pout' | 'temp'
  | 'setv' | 'seta' | 'ah' | 'wh' | 'ovp' | 'ocp' | 'opp' | 'otp' | 'lvp';

export const FIELD_DEC: Record<FmtField, number> = {
  vin: 2, vout: 2, iout: 3, pout: 2, temp: 1,
  setv: 2, seta: 3, ah: 3, wh: 3,
  ovp: 2, ocp: 3, opp: 1, otp: 0, lvp: 2,
};

export function fmtField(v: number | undefined, field: FmtField): string {
  if (v === undefined || !Number.isFinite(v)) return '--';
  const dec = FIELD_DEC[field] ?? 3;
  const fixed = v.toFixed(dec);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return trimmed === '' ? '0' : trimmed;
}

/** Voltage display: 2 decimals, no leading zero in the integer part (e.g. 5.00 / 19.86; not 05.00). */
export function fmtVolt2(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '--.--';
  const neg = v < 0 ? '-' : '';
  const a = Math.abs(v);
  const int = String(Math.floor(a));
  const dec = Math.round((a - Math.floor(a)) * 100);
  return `${neg}${int}.${String(dec).padStart(2, '0')}`;
}

/** Current split: returns [value text, unit]; magnitude <0.5 A uses mA (3 decimals), otherwise A (3 decimals) */
export function fmtCurrSplit(v: number | undefined): [string, string] {
  if (v === undefined || !Number.isFinite(v)) return ['--.---', 'A'];
  if (Math.abs(v) < 0.5) return [fixed3(v * 1000), 'mA'];
  return [fixed3(v), 'A'];
}
function fixed3(v: number): string {
  const neg = v < 0 ? '-' : '';
  const a = Math.abs(v);
  const int = String(Math.floor(a));
  const dec = Math.round((a - Math.floor(a)) * 1000);
  return `${neg}${int}.${String(dec).padStart(3, '0')}`;
}

/** Energy/capacity: 0000.0000 */
export function fmtEnergy(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '0000.0000';
  const neg = v < 0 ? '-' : '';
  const a = Math.abs(v);
  const int = String(Math.floor(a)).padStart(4, '0');
  const dec = Math.round((a - Math.floor(a)) * 1000);
  return `${neg}${int}.${String(dec).padStart(3, '0')}`;
}

/** Seconds -> 00:00:00 (allows overflow beyond 24h) */
export function fmtClock(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '00:00:00';
  const s = Math.floor(totalSec % 60);
  const m = Math.floor((totalSec / 60) % 60);
  const h = Math.floor(totalSec / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/** Record duration/session etc. converted from ms */
export function fmtClockMs(ms: number): string {
  return fmtClock(ms / 1000);
}
