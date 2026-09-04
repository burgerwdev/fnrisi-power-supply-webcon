// Shared run-time input validators with i18n messages.
// levels: error = block running; warn = warn but allow (merged into confirm details)
import { t } from '../i18n';

export interface LimitCtx {
  connected: boolean;
  maxVoltage?: number; // E2 (~input-0.2)
  maxCurrent?: number; // E3 (~5.1)
}

export interface Check {
  level: 'error' | 'warn';
  msg: string;
}

/** Common factory/spec limits (used as conservative references when the device does not return E2/E3) */
export const NOMINAL = { vMax: 30.0, aMax: 5.1, wMax: 153.0, otpMax: 99, protVMax: 35, protAMax: 6 };

const fill = (tmpl: string, map: Record<string, string | number>): string =>
  Object.entries(map).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), tmpl);

export function checkConnected(ctx: LimitCtx): Check[] {
  return ctx.connected ? [] : [{ level: 'error', msg: t('validate.connectFirst') }];
}

function rangeCheck(label: string, v: number, lo: number, hi: number | undefined, nominalHi: number): Check[] {
  if (!Number.isFinite(v)) return [{ level: 'error', msg: fill(t('val.notNumber'), { label }) }];
  if (v < lo) return [{ level: 'error', msg: fill(t('val.tooLow'), { label, lo }) }];
  if (hi !== undefined && v > hi + 1e-9) {
    return [{ level: 'error', msg: fill(t('val.overDevice'), { label, v, hi: hi.toFixed(2) }) }];
  }
  if (hi === undefined && v > nominalHi + 1e-9) {
    return [{ level: 'warn', msg: fill(t('val.overNominal'), { label, v, hi: nominalHi }) }];
  }
  return [];
}

export function checkVoltage(v: number, ctx: LimitCtx): Check[] {
  return rangeCheck(t('val.voltage'), v, 0, ctx.maxVoltage, NOMINAL.vMax);
}

export function checkCurrent(a: number, ctx: LimitCtx): Check[] {
  return rangeCheck(t('val.current'), a, 0, ctx.maxCurrent, NOMINAL.aMax);
}

export function checkDelayMs(ms: number): Check[] {
  if (!Number.isFinite(ms) || ms < 0) return [{ level: 'error', msg: t('val.delayInvalid') }];
  if (ms > 3600_000) return [{ level: 'warn', msg: fill(t('val.delayLong'), { s: (ms / 1000).toFixed(0) }) }];
  return [];
}

const PROT_NOMINAL: Record<string, { lo: number; hi: number }> = {
  ovp: { lo: 0, hi: NOMINAL.protVMax },
  ocp: { lo: 0, hi: NOMINAL.protAMax },
  opp: { lo: 0, hi: NOMINAL.wMax },
  otp: { lo: 0, hi: NOMINAL.otpMax },
  lvp: { lo: 0, hi: NOMINAL.protVMax },
};

export function checkProtection(which: string, v: number): Check[] {
  const r = PROT_NOMINAL[which];
  const w = which.toUpperCase();
  if (!r) return [{ level: 'error', msg: fill(t('val.unknownProt'), { w }) }];
  if (!Number.isFinite(v)) return [{ level: 'error', msg: fill(t('val.protInvalid'), { w }) }];
  if (v < r.lo) return [{ level: 'error', msg: fill(t('val.protTooLow'), { w, lo: r.lo }) }];
  if (v > r.hi) return [{ level: 'warn', msg: fill(t('val.protOutRange'), { w, v, hi: r.hi }) }];
  return [];
}

export function checkPresetValue(v: number, a: number, ctx: LimitCtx): Check[] {
  return [...checkVoltage(v, ctx), ...checkCurrent(a, ctx)];
}

export function joinChecks(cs: Check[]): string {
  return cs.map((c) => (c.level === 'error' ? `· ${c.msg}` : `⚠ ${c.msg}`)).join('\n');
}
