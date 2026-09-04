// Activity state machine (Activity Gate): centrally manages mutually exclusive "interactive activities" to prevent conflicts/deadlocks/mis-operations.
// States: idle / connecting / auto (single auto task) / stopping (stop requested, waiting to finish)
// Rules:
//  - only idle allows starting a "connect" or "auto task";
//  - while connecting, no new connect/auto task and no manual writes;
//  - while auto, no other auto task or manual control (write setpoint / toggle output / switch preset) except connect/disconnect;
//  - stop() only requests stopping the current auto; the task's end callback actually exits (prevents deadlock);
//  - disconnecting first calls stopAll, so the task won't keep writing to the device after disconnect.

export type ActivityKind = 'idle' | 'connecting' | 'auto' | 'stopping';

export interface ActivityInfo {
  kind: ActivityKind;
  label?: string; // auto task description (for UI hints)
}

export type ActivityListener = (info: ActivityInfo) => void;

export class ActivityGate {
  private info: ActivityInfo = { kind: 'idle' };
  private token = 0;
  private stopRequested = false;
  private stopper: (() => void) | null = null;
  private listeners = new Set<ActivityListener>();

  on(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  current(): ActivityInfo {
    return { ...this.info };
  }
  isBusy(): boolean {
    return this.info.kind !== 'idle';
  }
  isAuto(): boolean {
    return this.info.kind === 'auto';
  }
  /** Whether manual control (write setpoint / toggle output / switch preset / change params) is allowed */
  canManual(): boolean {
    return this.info.kind === 'idle';
  }
  canConnect(): boolean {
    return this.info.kind === 'idle';
  }
  /** Whether lifecycle ops like connect/disconnect are allowed while output runs (disconnect first stops) */
  canDisconnect(): boolean {
    return this.info.kind !== 'connecting';
  }

  beginConnecting(): boolean {
    if (this.info.kind !== 'idle') return false;
    this.set({ kind: 'connecting' });
    return true;
  }

  endConnecting(): void {
    if (this.info.kind === 'connecting') this.set({ kind: 'idle' });
  }

  /** Try to start an auto task (sequence/scan/script). Returns null on failure (busy or not allowed). */
  beginAuto(label: string, stop: () => void): number | null {
    if (this.info.kind !== 'idle') return null;
    this.token++;
    this.stopRequested = false;
    this.stopper = stop;
    this.set({ kind: 'auto', label });
    return this.token;
  }

  /** Task finished normally (called uniformly after success/error/stop) */
  endAuto(token: number): void {
    if (this.info.kind === 'auto' && token === this.token) {
      this.stopper = null;
      this.stopRequested = false;
      this.set({ kind: 'idle' });
    }
  }

  /** Request stopping the current auto task (idempotent; only sets a flag; the task exits at the next checkpoint and calls endAuto) */
  requestStop(): void {
    if (this.info.kind !== 'auto') return;
    this.stopRequested = true;
    this.stopper?.();
  }

  isStopRequested(): boolean {
    return this.stopRequested;
  }

  private set(next: ActivityInfo): void {
    this.info = next;
    for (const l of [...this.listeners]) l({ ...this.info });
  }
}
/** Singleton: the activity gate shared by all UI entry points */
export const uiGate = new ActivityGate();
