// Scan wizard core: voltage scan / current scan over MAIN setpoints (C1/C2).
// For each step we set the swept parameter (and the fixed counterpart), wait for the
// output to settle, then average the measured window and record an (V,I[,P]) point.
// A load must be connected while scanning; UI confirms beforehand.

import { t } from '../i18n';
import type { DeviceController } from '../device/controller';

export type ScanKind = 'voltage' | 'current';

export interface ScanParams {
  kind: ScanKind;
  /** swept axis start / stop / step (V for voltage scan, A for current scan) */
  start: number;
  stop: number;
  step: number;
  /** fixed axis value (A for voltage scan, V for current scan) */
  fixed: number;
  /** settle time after applying each step, ms */
  settleMs: number;
  /** averaging window at each point, ms */
  measureMs: number;
}

export interface ScanPoint {
  index: number;
  swept: number; // the swept value (V in voltage scan, A in current scan)
  voltage: number;
  current: number;
  power: number;
}

/** Build ascending/descending swept-axis values. */
export function buildSteps(start: number, stop: number, step: number): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(stop) || step <= 0 || !Number.isFinite(step)) return [];
  const dir = stop >= start ? 1 : -1;
  const out: number[] = [];
  const eps = step * 1e-6;
  for (let v = start; dir * v <= dir * stop + eps; v += dir * step) {
    out.push(Number(v.toFixed(4)));
    if (out.length > 100000) break; // safety
  }
  return out;
}

export interface ScanHooks {
  apply(swept: number, fixed: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** average measurement over the given window; resolve undefined if no data */
  measure(ms: number): Promise<{ voltage: number; current: number; power: number } | undefined>;
  isDeviceOk?(): boolean;
  onProgress?(done: number, total: number, label: string): void;
  /** called as soon as one measured point is available (live plotting) */
  onPoint?(point: ScanPoint, done: number, total: number): void;
  onProblem?(msg: string): Promise<boolean>;
  onFinished?(points: ScanPoint[], interrupted: boolean): void;
}

export class ScanRunner {
  private stopped = false;
  constructor(
    private params: ScanParams,
    private hooks: ScanHooks,
  ) {}

  requestStop(): void {
    this.stopped = true;
  }

  async run(): Promise<ScanPoint[]> {
    const { kind, start, stop, step, fixed } = this.params;
    const sweep = buildSteps(start, stop, step);
    if (!sweep.length) throw new Error(t('scan.rangeInvalid'));
    const points: ScanPoint[] = [];
    this.stopped = false;
    for (let i = 0; i < sweep.length; i++) {
      if (this.stopped) break;
      if (!(this.hooks.isDeviceOk?.() ?? true)) {
        const cont = this.hooks.onProblem ? await this.hooks.onProblem(t('scan.devProblem')) : false;
        if (!cont) break;
      }
      const sweptVal = sweep[i];
      const applyVoltage = kind === 'voltage' ? sweptVal : fixed;
      const applyCurrent = kind === 'current' ? sweptVal : fixed;
      await this.hooks.apply(applyVoltage, applyCurrent);
      await this.hooks.sleep(this.params.settleMs);
      this.hooks.onProgress?.(i + 1, sweep.length, `${kind === 'voltage' ? 'V' : 'A'}=${sweptVal}`);
      const m = await this.hooks.measure(this.params.measureMs);
      if (m) {
        const pt: ScanPoint = {
          index: points.length + 1,
          swept: sweptVal,
          voltage: m.voltage,
          current: m.current,
          power: m.power,
        };
        points.push(pt);
        this.hooks.onPoint?.(pt, i + 1, sweep.length);
      }
    }
    this.hooks.onFinished?.(points, this.stopped);
    return points;
  }
}

/** helper used by the UI: average telemetry values over a window */
export async function measureAverage(
  device: DeviceController,
  windowMs: number,
): Promise<{ voltage: number; current: number; power: number } | undefined> {
  const vals: { v: number; i: number; p: number }[] = [];
  const off = device.on('telemetry', (s) => {
    const t = s.telemetry;
    if (t.outputVoltage !== undefined && t.outputCurrent !== undefined) {
      vals.push({ v: t.outputVoltage, i: t.outputCurrent, p: t.outputPower ?? 0 });
    }
  });
  await new Promise((r) => setTimeout(r, windowMs));
  off();
  if (!vals.length) return undefined;
  const n = vals.length;
  const sum = vals.reduce((a, b) => ({ v: a.v + b.v, i: a.i + b.i, p: a.p + b.p }));
  return { voltage: sum.v / n, current: sum.i / n, power: sum.p / n };
}
