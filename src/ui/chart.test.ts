// chart.ts value rounding: device float32 noise must not cause visible chart jitter.
import { describe, expect, it } from 'vitest';
import { chartRound, smoothData } from './chart';

describe('chartRound', () => {
  it('rounds voltage/current/power to the same precision as the setpoint', () => {
    // float32-ish noise collapses to stable values
    expect(chartRound(0.05000000074505806, 3)).toBe(0.05);
    expect(chartRound(1.0999999046325684, 2)).toBe(1.1);
    expect(chartRound(19.85999870300293, 2)).toBe(19.86);
    expect(chartRound(5.099999904632568, 3)).toBe(5.1);
  });

  it('leaves non-finite / undefined as-is', () => {
    expect(chartRound(undefined, 2)).toBeUndefined();
    expect(chartRound(Number.NaN, 2)).toBeNaN();
    expect(chartRound(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
  });

  it('keeps temperature to one decimal', () => {
    expect(chartRound(28.833333, 1)).toBe(28.8);
  });
});

describe('smoothData (Gaussian smoothing)', () => {
  it('preserves a flat signal and reduces noise', () => {
    const flat = [1, 1, 1, 1, 1];
    expect(smoothData(flat, 3).every((x) => x === 1)).toBe(true);
    const noisy = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    const s = smoothData(noisy, 2);
    // after smoothing, adjacent-point changes should be far smaller than the original jumps
    for (let i = 1; i < s.length; i++) expect(Math.abs((s[i] as number) - (s[i - 1] as number))).toBeLessThan(0.6);
  });

  it('handles gaps (undefined) by normalizing over available points', () => {
    const v = [1, undefined, 1, undefined, 1];
    const s = smoothData(v, 2);
    expect((s[2] as number)).toBeCloseTo(1, 5);
    expect(s[1]).toBeDefined();
  });

  it('returns input when window < 2', () => {
    expect(smoothData([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });
});
