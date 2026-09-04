import { describe, expect, it } from 'vitest';
import { ActivityGate } from './activity';

describe('ActivityGate', () => {
  it('idle by default; connect exclusive while connecting', () => {
    const g = new ActivityGate();
    expect(g.current().kind).toBe('idle');
    expect(g.beginConnecting()).toBe(true);
    expect(g.current().kind).toBe('connecting');
    expect(g.beginConnecting()).toBe(false);
    expect(g.beginAuto('x', () => {})).toBeNull();
    expect(g.canManual()).toBe(false);
    g.endConnecting();
    expect(g.current().kind).toBe('idle');
  });

  it('auto is exclusive; stop is requested but needs endAuto to release', () => {
    const g = new ActivityGate();
    const t = g.beginAuto('扫描', () => {});
    expect(t).not.toBeNull();
    expect(g.isAuto()).toBe(true);
    expect(g.canManual()).toBe(false);
    expect(g.beginConnecting()).toBe(false);
    expect(g.beginAuto('序列', () => {})).toBeNull(); // cannot run a second auto task concurrently
    g.requestStop();
    expect(g.isStopRequested()).toBe(true);
    expect(g.current().kind).toBe('auto'); // still auto, waiting for the task to confirm finish
    g.endAuto(t as number);
    expect(g.current().kind).toBe('idle');
    expect(g.canManual()).toBe(true);
  });

  it('wrong token cannot end another job (防死锁/误操作)', () => {
    const g = new ActivityGate();
    const a = g.beginAuto('a', () => {}) as number;
    const b = g.beginAuto('b', () => {});
    expect(b).toBeNull(); // a still holds it
    g.endAuto(a + 1); // wrong token
    expect(g.isAuto()).toBe(true);
    g.endAuto(a);
    expect(g.isAuto()).toBe(false);
  });

  it('notifies listeners on every transition', () => {
    const g = new ActivityGate();
    const seen: string[] = [];
    g.on((i) => seen.push(i.kind));
    g.beginConnecting();
    g.endConnecting();
    const t = g.beginAuto('任务', () => {}) as number;
    g.endAuto(t);
    expect(seen).toEqual(['connecting', 'idle', 'auto', 'idle']);
  });
});
