import { describe, expect, it } from 'vitest';
import { nextStep, type RunParams } from './executor';

const AUTO: RunParams = { mode: 'auto', startIndex: 1, stopIndex: 3, loops: 2 };
const MANUAL: RunParams = { mode: 'manual', startIndex: 2, stopIndex: 4, loops: 1 };

describe('nextStep', () => {
  it('manual: walks the window then done', () => {
    expect(nextStep(MANUAL, 0, 0)).toEqual({ step: 2, loop: 1, done: false });
    expect(nextStep(MANUAL, 2, 1)).toEqual({ step: 3, loop: 1, done: false });
    expect(nextStep(MANUAL, 4, 1)).toEqual({ step: 0, loop: 1, done: true });
  });
  it('auto: repeats until loops exhausted', () => {
    expect(nextStep(AUTO, 0, 0)).toEqual({ step: 1, loop: 1, done: false });
    expect(nextStep(AUTO, 3, 1)).toEqual({ step: 1, loop: 2, done: false });
    expect(nextStep(AUTO, 3, 2)).toEqual({ step: 0, loop: 2, done: true });
  });
  it('auto with loops=0 runs forever (no done at end of loop)', () => {
    const inf: RunParams = { mode: 'auto', startIndex: 1, stopIndex: 2, loops: 0 };
    expect(nextStep(inf, 2, 3)).toEqual({ step: 1, loop: 4, done: false });
  });
  it('invalid ranges are done', () => {
    expect(nextStep({ mode: 'auto', startIndex: 5, stopIndex: 3, loops: 1 }, 0, 0)).toEqual({
      step: 0,
      loop: 0,
      done: true,
    });
  });
});
