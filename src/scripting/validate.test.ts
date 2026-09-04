import { describe, expect, it } from 'vitest';
import { parseDsl, validateDsl } from './dsl';
import { checkCurrent, checkDelayMs, checkVoltage } from './validators';

describe('validators', () => {
  it('voltage range vs device limit', () => {
    expect(checkVoltage(1, { connected: true, maxVoltage: 19.86 }).some((c) => c.level === 'error')).toBe(false);
    const over = checkVoltage(21, { connected: true, maxVoltage: 19.86 });
    expect(over.find((c) => c.level === 'error')?.msg).toContain('超过设备当前上限');
    const noLim = checkVoltage(40, { connected: true });
    expect(noLim.find((c) => c.level === 'warn')?.msg).toContain('常见规格');
  });
  it('negative / nan values rejected', () => {
    expect(checkVoltage(-1, { connected: true }).some((c) => c.level === 'error')).toBe(true);
    expect(checkCurrent(Number.NaN, { connected: true }).some((c) => c.level === 'error')).toBe(true);
  });
  it('delay checks', () => {
    expect(checkDelayMs(1500)).toEqual([]);
    expect(checkDelayMs(-5).some((c) => c.level === 'error')).toBe(true);
    expect(checkDelayMs(2 * 3600_000).some((c) => c.level === 'warn')).toBe(true);
  });
});

describe('validateDsl', () => {
  it('flags voltage above device limit with line number', () => {
    const { lines } = parseDsl('SET V 30');
    const { errors } = validateDsl(lines, { connected: true, maxVoltage: 19.86 });
    expect(errors.some((e) => e.msg.includes('第1行') && e.msg.includes('19.86'))).toBe(true);
  });
  it('blocks everything when not connected', () => {
    const { lines } = parseDsl('SET V 1\nSNAP');
    const { errors } = validateDsl(lines, { connected: false });
    expect(errors.some((e) => e.msg.includes('连接'))).toBe(true);
  });
  it('valid small script passes clean', () => {
    const { lines } = parseDsl('SET V A 1.0 0.05\nWAIT 0.2\nSNAP');
    const { errors } = validateDsl(lines, { connected: true, maxVoltage: 19.86, maxCurrent: 5.1 });
    expect(errors).toEqual([]);
  });
});
