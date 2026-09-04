// Sampler adaptive downsampling: interval rises with recording duration so a
// session can span seconds to a week without unbounded growth.
import { describe, expect, it } from 'vitest';
import { adaptiveInterval } from './sampler';

const MIN = 60_000;
describe('adaptiveInterval', () => {
  it('is fastest under 5 minutes', () => {
    expect(adaptiveInterval(4 * MIN)).toBe(0);
  });
  it('steps up across the schedule', () => {
    expect(adaptiveInterval(5 * MIN)).toBe(1000); // 5min
    expect(adaptiveInterval(60 * MIN)).toBe(5000); // 1h
    expect(adaptiveInterval(360 * MIN)).toBe(30_000); // 6h
    expect(adaptiveInterval(24 * 60 * MIN)).toBe(60_000); // 1 day
    expect(adaptiveInterval(7 * 24 * 60 * MIN)).toBe(60_000); // 1 week
  });
});
