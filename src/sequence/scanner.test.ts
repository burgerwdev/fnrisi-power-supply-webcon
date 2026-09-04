import { describe, expect, it } from 'vitest';
import { buildSteps, ScanRunner, type ScanParams } from './scanner';

describe('buildSteps', () => {
  it('ascending', () => {
    expect(buildSteps(0, 1, 0.25)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });
  it('descending', () => {
    expect(buildSteps(1, 0, 0.25)).toEqual([1, 0.75, 0.5, 0.25, 0]);
  });
  it('invalid inputs are empty', () => {
    expect(buildSteps(0, 1, 0)).toEqual([]);
    expect(buildSteps(0, 1, -1)).toEqual([]);
    expect(buildSteps(1, 0, -0.5)).toEqual([]);
  });
});

describe('ScanRunner', () => {
  it('records a point per step and stops early on request', async () => {
    const params: ScanParams = {
      kind: 'voltage',
      start: 0,
      stop: 0.5,
      step: 0.25,
      fixed: 0.05,
      settleMs: 1,
      measureMs: 1,
    };
    const applied: string[] = [];
    const runner = new ScanRunner(params, {
      apply: async (v, a) => {
        applied.push(`${v}/${a}`);
      },
      sleep: () => new Promise((r) => setTimeout(r, 0)),
      measure: async () => ({ voltage: 1, current: 0.05, power: 0.05 }),
      isDeviceOk: () => true,
    });
    const points = await runner.run();
    expect(points).toHaveLength(3);
    expect(applied).toEqual(['0/0.05', '0.25/0.05', '0.5/0.05']);
    expect(points[1]).toMatchObject({ swept: 0.25, voltage: 1, current: 0.05 });
  });
});
