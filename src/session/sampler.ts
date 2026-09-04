// Session sampling manager: throttles device telemetry into IndexedDB sessions
// at a configurable rate (0 = every device push = fastest) and honors a point cap.

import type { DeviceController } from '../device/controller';
import type { DeviceState } from '../protocol/types';
import type { SampleRow } from '../storage/sessions';
import { loadSessionRows, startSession, type SessionRecorder } from '../storage/sessions';

export interface SamplerConfig {
  /** 0 = fastest (every device push); otherwise minimum ms between samples */
  samplePeriodMs: number;
  sessionCapPoints: number;
  recipeName?: string;
}

export interface SamplerStatus {
  running: boolean;
  sessionId?: string;
  count: number;
  startedAt?: number;
  dropped: number;
}

// Adaptive downsampling: automatically relaxes the sampling interval as recording time grows, keeping long records (seconds~days, up to a week) with a manageable point count.
export function adaptiveInterval(elapsedMs: number): number {
  const m = elapsedMs / 60000;
  if (m < 5) return 0; // first 5 minutes: device push fastest
  if (m < 60) return 1000; // 5 min ~ 1 hour: 1s
  if (m < 360) return 5000; // 1 ~ 6 hours: 5s
  if (m < 1440) return 30000; // 6 hours ~ 1 day: 30s
  return 60000; // 1 day+: 60s (about 10k points for a week, comfortably held by IndexedDB)
}

export function rowFromState(s: DeviceState): SampleRow {
  const t = s.telemetry;
  return {
    ts: t.ts || Date.now(),
    vin: t.inputVoltage,
    vout: t.outputVoltage,
    iout: t.outputCurrent,
    pout: t.outputPower,
    temp: t.temperature,
    ah: t.capacityAh,
    wh: t.energyWh,
    out: s.status.output === 'RUN' ? 1 : 0,
    prot: ['OK', 'OVP', 'OCP', 'OPP', 'OTP', 'LVP', 'REP'].indexOf(s.status.protection),
    mode: s.status.mode === 'CC' ? 0 : 1,
  };
}

export class Sampler {
  private device: DeviceController;
  private cfg: () => SamplerConfig;
  private rec: SessionRecorder | null = null;
  private lastTs = 0;
  private status: SamplerStatus = { running: false, count: 0, dropped: 0 };
  private unsub: (() => void) | null = null;
  private onStatus?: (s: SamplerStatus) => void;
  private capWarned = false;

  constructor(device: DeviceController, cfg: () => SamplerConfig) {
    this.device = device;
    this.cfg = cfg;
  }

  onStatusChange(fn: (s: SamplerStatus) => void): void {
    this.onStatus = fn;
  }

  getStatus(): SamplerStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    if (this.status.running) return;
    const st = this.device.getState();
    const meta = {
      name: `session-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}`,
      samplePeriodMs: this.cfg().samplePeriodMs,
      device: {
        model: st.info.modelName,
        hw: st.info.hwVersion,
        fw: st.info.fwVersion,
      },
      recipeName: this.cfg().recipeName,
    };
    const rec = await startSession(meta);
    this.rec = rec;
    this.lastTs = 0;
    this.capWarned = false;
    this.status = { running: true, sessionId: rec.id, count: 0, startedAt: Date.now(), dropped: 0 };
    this.unsub = this.device.on('telemetry', (s) => this.onTelemetry(s));
    this.emit();
  }

  async stop(): Promise<void> {
    if (!this.status.running) return;
    this.unsub?.();
    this.unsub = null;
    const rec = this.rec;
    this.rec = null;
    this.status = { ...this.status, running: false };
    this.emit();
    if (rec) {
      await rec.finish();
      this.status.dropped = 0;
    }
  }

  async toggle(): Promise<void> {
    if (this.status.running) await this.stop();
    else await this.start();
  }

  private onTelemetry(s: DeviceState): void {
    const cfg = this.cfg();
    let period = cfg.samplePeriodMs;
    if (period < 0) {
      const elapsed = this.status.startedAt ? (s.telemetry.ts || Date.now()) - this.status.startedAt : 0;
      period = adaptiveInterval(elapsed);
    }
    const now = s.telemetry.ts || Date.now();
    if (period > 0) {
      if (this.lastTs && now - this.lastTs < period) {
        this.status.dropped++;
        return;
      }
      this.lastTs = now;
    }
    const cap = cfg.sessionCapPoints;
    if (cap > 0 && this.status.count >= cap) {
      if (!this.capWarned) {
        this.capWarned = true;
        console.warn(`[sampler] session cap ${cap} reached; stopping`);
      }
      void this.stop();
      return;
    }
    this.rec?.append([rowFromState(s)]);
    this.status.count++;
    if (this.status.count % 50 === 0) this.emit();
  }

  private emit(): void {
    this.onStatus?.({ ...this.status });
  }
}

export { loadSessionRows };
