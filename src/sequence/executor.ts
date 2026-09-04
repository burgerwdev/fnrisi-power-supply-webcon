// Sequence / table executor core: runs rows {voltage, current, delayMs} against the
// MAIN setpoints (C1/C2, per confirmed requirement: row count is unlimited, >6).
// Loops & ranges per official "auto mode"; supports pause/step/stop; monitors device
// problems during auto-run and reacts per configured strategy (prompt/pause/stop).
import { t } from '../i18n';

export type RunMode = 'auto' | 'manual';

export interface SeqRow {
  voltage: number;
  current: number;
  delayMs: number;
}

export interface RunParams {
  mode: RunMode;
  /** 1-based inclusive range into rows */
  startIndex: number;
  stopIndex: number;
  loops: number; // auto mode only; 0 = infinite until stopped
}

export interface Progress {
  running: boolean;
  paused: boolean;
  step: number; // 1-based current row within full sequence window (0 when idle)
  loop: number; // 1-based current loop
}

export interface StepResult {
  progress: Progress;
  done: boolean;
}

/** pure stepping: advance to the next row index given current state. */
export function nextStep(
  params: RunParams,
  currentStep: number,
  currentLoop: number,
): { step: number; loop: number; done: boolean } {
  const n = params.stopIndex - params.startIndex + 1;
  if (n <= 0) return { step: 0, loop: currentLoop, done: true };
  if (currentStep < params.startIndex) return { step: params.startIndex, loop: 1, done: false };
  if (currentStep < params.stopIndex) return { step: currentStep + 1, loop: currentLoop, done: false };
  // at end of a loop
  if (params.mode === 'manual') return { step: 0, loop: currentLoop, done: true };
  if (params.loops > 0 && currentLoop >= params.loops) return { step: 0, loop: currentLoop, done: true };
  return { step: params.startIndex, loop: currentLoop + 1, done: false };
}

export type DeviceProblemStrategy = 'prompt' | 'pause' | 'stop';

export interface SequenceHooks {
  /** apply one row to the device (e.g. setVoltage + setCurrent) */
  apply(row: SeqRow): Promise<void>;
  /** wait between rows */
  sleep(ms: number): Promise<void>;
  /** called when device problem detected during run; returns whether to continue (for prompt) */
  onProblem?(problem: string): Promise<boolean>;
  onProgress?(p: Progress): void;
  onFinished?(reason: 'completed' | 'stopped' | 'problem'): void;
  /** current device healthy? default true */
  isDeviceOk?(): boolean;
  getStrategy(): DeviceProblemStrategy;
}

export class SequenceRunner {
  private stopFlag = false;
  private pauseFlag = false;
  private progress: Progress = { running: false, paused: false, step: 0, loop: 0 };

  constructor(
    private rows: SeqRow[],
    private params: RunParams,
    private hooks: SequenceHooks,
  ) {}

  getProgress(): Progress {
    return { ...this.progress };
  }

  requestStop(): void {
    this.stopFlag = true;
  }

  togglePause(): void {
    this.pauseFlag = !this.pauseFlag;
    this.emit();
  }

  async run(): Promise<void> {
    const { startIndex, stopIndex } = this.params;
    if (!this.rows.length || startIndex < 1 || stopIndex > this.rows.length || startIndex > stopIndex) {
      this.hooks.onFinished?.('stopped');
      return;
    }
    this.stopFlag = false;
    this.pauseFlag = false;
    this.progress = { running: true, paused: false, step: 0, loop: 0 };
    this.emit();

    const n = stopIndex - startIndex + 1;
    let step = 0;
    let loop = 0;
    try {
      for (;;) {
        if (this.stopFlag) {
          this.hooks.onFinished?.('stopped');
          return;
        }
        // device problem monitor (checked between steps, does not interrupt a delay)
        if (!(this.hooks.isDeviceOk?.() ?? true)) {
          const strategy = this.hooks.getStrategy();
          if (strategy === 'stop') {
            this.hooks.onFinished?.('problem');
            return;
          }
          if (strategy === 'pause') this.pauseFlag = true;
          if (strategy === 'prompt' && this.hooks.onProblem) {
            const cont = await this.hooks.onProblem(t('seq.devProblem'));
            if (!cont) {
              this.hooks.onFinished?.('problem');
              return;
            }
          }
        }
        const next = nextStep(this.params, step, loop);
        if (next.done) {
          this.hooks.onFinished?.('completed');
          return;
        }
        step = next.step;
        loop = next.loop;
        this.progress.step = step;
        this.progress.loop = loop;
        this.emit();
        const row = this.rows[step - 1];
        await this.hooks.apply(row);
        // pause gate
        const delayUntil = Date.now() + row.delayMs;
        while (Date.now() < delayUntil) {
          if (this.stopFlag) {
            this.hooks.onFinished?.('stopped');
            return;
          }
          if (this.pauseFlag) {
            await this.hooks.sleep(100);
            continue; // re-check until unpaused
          }
          await this.hooks.sleep(Math.min(50, delayUntil - Date.now()));
        }
        void n;
      }
    } finally {
      this.progress = { running: false, paused: false, step: 0, loop: 0 };
      this.emit();
    }
  }

  private emit(): void {
    this.hooks.onProgress?.({ ...this.progress });
  }
}
