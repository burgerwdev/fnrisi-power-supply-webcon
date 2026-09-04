// Telemetry chart v3:
// - series visibility & primary (Y-axis) selection, smoothing toggle
// - crisp DPR rendering, X/Y tick labels, drag-to-pan, wheel-to-zoom, follow-tail mode
import type { DeviceState } from '../protocol/types';
import { t } from '../i18n';
import { fmtCurrSplit } from './format';

export interface ChartSeriesDef {
  id: string;
  label: string;
  unit: string;
  color: string;
  pick: (s: DeviceState) => number | undefined;
}

// Uniformly round device readings to the set/display precision, removing small fluctuations caused by float32 noise.
export function chartRound(v: number | undefined, d: number): number | undefined {
  return v === undefined || !Number.isFinite(v) ? v : Math.round(v * 10 ** d) / 10 ** d;
}
const rnd = chartRound;

const SERIES_DEFS: Record<string, ChartSeriesDef> = {
  vout: { id: 'vout', label: t('chart.vout'), unit: 'V', color: '#46f08a', pick: (s) => rnd(s.telemetry.outputVoltage, 2) },
  iout: { id: 'iout', label: t('chart.iout'), unit: 'A', color: '#35b6ff', pick: (s) => rnd(s.telemetry.outputCurrent, 6) },
  pout: { id: 'pout', label: t('chart.pout'), unit: 'W', color: '#ffb000', pick: (s) => rnd(s.telemetry.outputPower, 3) },
  vin: { id: 'vin', label: t('chart.vin'), unit: 'V', color: '#b7b7b7', pick: (s) => rnd(s.telemetry.inputVoltage, 2) },
  temp: { id: 'temp', label: t('chart.temp'), unit: '°C', color: '#ff8b8b', pick: (s) => rnd(s.telemetry.temperature, 1) },
};

export const CHART_SERIES_ORDER = ['vout', 'iout', 'pout', 'vin', 'temp'] as const;

interface Pt {
  t: number;
  values: (number | undefined)[];
}

const MAX_POINTS = 200000;
const MAX_DRAW = 1200;
const MIN_WINDOW = 2000;
const MAX_WINDOW = 60 * 60 * 1000;

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
const timeStr = (t: number) => new Date(t).toTimeString().slice(0, 8);

// Legend/hover value display: consistent with the small meter (dashboard page) — current uses mA/A auto-scaling so small currents aren't rounded to 0.000 A.
function fmtVal(def: ChartSeriesDef, v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '--';
  if (def.id === 'iout') {
    const [txt, unit] = fmtCurrSplit(v);
    return `${txt}${unit}`;
  }
  if (def.unit === 'V') return `${v.toFixed(2)}${def.unit}`;
  if (def.unit === 'W') return `${v.toFixed(2)}${def.unit}`;
  if (def.unit === '°C') return `${v.toFixed(1)}${def.unit}`;
  return `${v.toFixed(3)}${def.unit}`;
}

// Gaussian-weighted smoothing (common practice): a normalized Gaussian-kernel weighted average centered on each point.
// Smoother than a simple moving average without the "blocky" feel, while preserving the trend; when the window is short of data, normalize by the available weights.
export function smoothData(vals: (number | undefined)[], win: number): (number | undefined)[] {
  if (win < 2) return vals;
  const sigma = Math.max(1, win / 3);
  const out: (number | undefined)[] = new Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    let sum = 0;
    let wsum = 0;
    const lo = Math.max(0, i - win);
    const hi = Math.min(vals.length - 1, i + win);
    for (let j = lo; j <= hi; j++) {
      const v = vals[j];
      if (v === undefined) continue;
      const w = Math.exp(-((j - i) * (j - i)) / (2 * sigma * sigma));
      sum += v * w;
      wsum += w;
    }
    out[i] = wsum ? sum / wsum : vals[i];
  }
  return out;
}
const smooth1d = smoothData;

export class TelemetryChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private wrap: HTMLElement;
  private ro: ResizeObserver | null = null;
  private ring: Pt[] = [];
  private defs: ChartSeriesDef[]; // ordered as CHART_SERIES_ORDER
  private windowMs: number;
  private paused = false;
  private smooth = false;
  private visible = new Set<string>();
  private primary = 'vout';
  private followTail = true;
  private viewEnd = 0; // last visible time (tail anchor)
  private cssW = 0;
  private cssH = 0;
  private raf = 0;
  private lastDraw = 0;
  private destroyed = false;
  private hoverX: number | null = null;
  private dragging = false;
  private dragStartX = 0;
  private dragStartEnd = 0;

  constructor(canvas: HTMLCanvasElement, seriesIds: string[], opts?: { windowMs?: number }) {
    this.canvas = canvas;
    this.wrap = canvas.parentElement ?? canvas;
    this.defs = seriesIds.map((id) => SERIES_DEFS[id]).filter(Boolean);
    for (const d of this.defs) this.visible.add(d.id);
    this.windowMs = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, opts?.windowMs ?? 60_000));
    this.ctx = canvas.getContext('2d')!;
    this.size();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.size());
      this.ro.observe(this.wrap);
    }
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      if (!this.dragging) this.draw();
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this.zoom(e.deltaY, e.clientX - rect.left);
    }, { passive: false });
    canvas.addEventListener('dblclick', () => {
      // double-click returns to real-time follow
      this.setFollow(true);
    });
    // window-level move/up so drag continues outside the canvas
    window.addEventListener('pointermove', (e) => {
      if (this.dragging) this.onMove(e);
    });
    window.addEventListener('pointerup', () => {
      if (this.dragging) {
        this.dragging = false;
        this.draw();
      }
    });
    window.addEventListener('blur', () => {
      if (this.dragging) this.dragging = false;
    });
    this.loop();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
  }

  // ---- public controls (used by the legend UI) ----
  setVisible(id: string, on: boolean): void {
    if (on) this.visible.add(id);
    else this.visible.delete(id);
    this.draw();
  }
  isVisible(id: string): boolean {
    return this.visible.has(id);
  }
  setPrimary(id: string): void {
    if (SERIES_DEFS[id]) this.primary = id;
    this.draw();
  }
  setSmooth(on: boolean): void {
    this.smooth = on;
    this.draw();
  }
  isSmoothing(): boolean {
    return this.smooth;
  }
  private followCb: ((f: boolean) => void) | null = null;
  onFollowChange(cb: (f: boolean) => void): void {
    this.followCb = cb;
  }
  setFollow(follow: boolean): void {
    this.followTail = follow;
    if (follow) this.viewEnd = 0;
    this.draw();
    this.followCb?.(follow);
  }
  isFollowing(): boolean {
    return this.followTail;
  }
  get defsList(): ChartSeriesDef[] {
    return this.defs;
  }
  get primaryId(): string {
    return this.primary;
  }

  push(s: DeviceState): void {
    if (this.paused || this.destroyed) return;
    const now = s.telemetry.ts || Date.now();
    const values = this.defs.map((d) => {
      const v = d.pick(s);
      return v === undefined || !Number.isFinite(v) ? undefined : v;
    });
    const last = this.ring[this.ring.length - 1];
    if (last && now - last.t < 60 && values.every((v, i) => v === last.values[i])) return;
    this.ring.push({ t: now, values });
    if (this.ring.length > MAX_POINTS) this.ring.splice(0, this.ring.length - MAX_POINTS);
  }

  clear(): void {
    this.ring = [];
    this.draw();
  }
  setPaused(p: boolean): void {
    this.paused = p;
    if (!p) this.draw();
  }
  setWindow(ms: number): void {
    this.windowMs = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, ms));
    this.draw();
  }
  windowMsValue(): number {
    return this.windowMs;
  }

  private zoom(deltaY: number, xPx?: number): void {
    const factor = deltaY > 0 ? 1.16 : 1 / 1.16;
    const newMs = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.round(this.windowMs * factor)));
    // Manual mode: zoom anchored at the cursor so that time point stays under the cursor
    if (!this.followTail && xPx !== undefined) {
      const padL = 66;
      const padR = 18;
      const plotW = this.cssW - padL - padR;
      const frac = Math.min(Math.max((xPx - padL) / Math.max(1, plotW), 0), 1);
      const anchor = this.viewEnd - this.windowMs + frac * this.windowMs;
      this.viewEnd = anchor + (1 - frac) * newMs;
    }
    this.windowMs = newMs;
    this.draw();
  }

  private onDown(e: PointerEvent): void {
    if (!this.cssW) return;
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    this.dragging = true;
    this.dragStartX = e.clientX - rect.left;
    this.dragStartEnd = this.viewEnd;
    this.hoverX = this.dragStartX;
    try {
      this.canvas.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  }
  private onMove(e: PointerEvent): void {
    if (!this.cssW) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), this.cssW);
    this.hoverX = x;
    if (this.dragging) {
      const padL = 66;
      const padR = 18;
      const plotW = this.cssW - padL - padR;
      const dx = this.dragStartX - x; // drag right -> see earlier data
      const dt = (dx / Math.max(1, plotW)) * this.windowMs;
      let end = this.dragStartEnd + dt;
      const tail = this.ring.length ? this.ring[this.ring.length - 1].t : Date.now();
      end = Math.min(end, tail);
      const first = this.ring.length ? this.ring[0].t : Date.now() - this.windowMs;
      end = Math.max(end, first + this.windowMs);
      this.followTail = false;
      this.viewEnd = end;
      this.followCb?.(false);
    }
    this.draw();
  }

  private loop = (): void => {
    if (!this.destroyed) {
      if (Date.now() - this.lastDraw > 200) this.draw();
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  private size(): void {
    // Use the canvas's own content-box size (excluding the outer container's padding) to avoid scaling misalignment from gap padding.
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 780;
    const h = rect.height || 260;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.max(10, Math.round(w * dpr));
    this.canvas.height = Math.max(10, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /** collect points in the visible window (downsampled) */
  private windowed(): { pts: Pt[]; t0: number; t1: number } {
    const tail = this.ring.length ? this.ring[this.ring.length - 1].t : Date.now();
    let end: number;
    if (this.followTail || !this.viewEnd) {
      end = tail;
      this.viewEnd = tail;
    } else end = this.viewEnd;
    const from = end - this.windowMs;
    let arr = this.ring.filter((p) => p.t >= from && p.t <= end);
    let out: Pt[] = arr;
    if (arr.length > MAX_DRAW) {
      const step = arr.length / MAX_DRAW;
      out = [];
      for (let i = 0; i < arr.length; i += Math.max(1, Math.floor(step))) out.push(arr[Math.floor(i)]);
    }
    return { pts: out, t0: out.length ? out[0].t : from, t1: out.length ? out[out.length - 1].t : end };
  }

  private draw(): void {
    this.lastDraw = Date.now();
    const { ctx, cssW: w, cssH: h } = this;
    if (!w || !h || this.destroyed) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = cssVar('--panel-2', '#0d0d0d');
    ctx.fillRect(0, 0, w, h);

    const padL = 66; // y-axis labels
    const padR = 18;
    const padT = 20;
    const padB = 28; // x-axis labels
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const { pts } = this.windowed();

    // ---- shared y range across ALL visible series (so nothing is clipped) ----
    // All visible curves share one y-axis range, auto-fit from minimum 0 to maximum on the left, so you can still see the voltage when "6V voltage / 0.01A current".
    type S = { def: ChartSeriesDef; vals: (number | undefined)[] };
    const drawn: S[] = [];
    let gHi = -Infinity;
    for (let si = 0; si < this.defs.length; si++) {
      const def = this.defs[si];
      if (!this.visible.has(def.id)) continue;
      const vals = this.smooth ? smooth1d(pts.map((p) => p.values[si]), 3) : pts.map((p) => p.values[si]);
      let shi = -Infinity;
      for (const v of vals) if (v !== undefined && v > shi) shi = v;
      if (!Number.isFinite(shi)) continue;
      drawn.push({ def, vals });
      if (shi > gHi) gHi = shi;
    }
    let lo = 0;
    let hi = 1;
    if (gHi > 0) {
      const span = gHi || 1;
      const pad = Math.max(span * 0.1, gHi * 0.03 + 1e-6);
      hi = gHi + pad;
      lo = 0;
    }
    const fmtTick = (v: number): string => {
      const span = hi - lo;
      const d = span >= 100 ? 0 : span >= 10 ? 1 : span >= 1 ? 2 : 3;
      return v.toFixed(d);
    };
    ctx.strokeStyle = cssVar('--chart-grid', '#123f12');
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = cssVar('--label', '#0c6');
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      const v = hi - ((hi - lo) / 4) * i;
      ctx.textAlign = 'right';
      ctx.fillText(fmtTick(v), padL - 4, y + 3);
    }
    ctx.textAlign = 'left';
    // y axis caption (emphasis series)
    const primIdx = this.defs.findIndex((d) => d.id === this.primary);
    const primDef = this.defs[primIdx];
    if (primDef) {
      ctx.fillStyle = primDef.color;
      ctx.font = '10px sans-serif';
      ctx.save();
      ctx.translate(8, padT + plotH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${primDef.label} (${primDef.unit})`, 0, 0);
      ctx.restore();
    }
    ctx.font = '10px ui-monospace, monospace';

    if (pts.length < 2) {
      ctx.fillStyle = cssVar('--label', '#0c6');
      ctx.font = '12px sans-serif';
      ctx.fillText(t('chart.waiting'), padL, 28);
      return;
    }
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const spanT = Math.max(1, t1 - t0);
    const X = (t: number) => padL + ((t - t0) / spanT) * plotW;

    // series lines (physically proportional: unified y range consistent with ticks; primary series thicker + glowing for distinction)
    for (const s of drawn) {
      const def = s.def;
      const isPrim = def.id === this.primary;
      ctx.strokeStyle = def.color;
      ctx.lineWidth = isPrim ? 3.5 : 1.2;
      ctx.globalAlpha = isPrim ? 1 : 0.8;
      ctx.lineJoin = 'round';
      if (isPrim) { ctx.shadowColor = def.color; ctx.shadowBlur = 8; } else { ctx.shadowBlur = 0; }
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < pts.length; i++) {
        const v = s.vals[i];
        if (v === undefined) {
          started = false;
          continue;
        }
        const x = X(pts[i].t);
        const y = padT + (1 - (v - lo) / (hi - lo)) * plotH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // last-value legend top-right
    ctx.font = '10px ui-monospace, monospace';
    let ly = padT + 9;
    for (let si = 0; si < this.defs.length; si++) {
      const def = this.defs[si];
      if (!this.visible.has(def.id)) continue;
      const lastV = pts[pts.length - 1].values[si];
      const txt = `${def.id}: ${fmtVal(def, lastV)}`;
      ctx.fillStyle = def.color;
      ctx.fillText(txt, w - padR - ctx.measureText(txt).width, ly);
      ly += 11;
    }

    // x axis labels (start/end/mid) + caption
    ctx.fillStyle = cssVar('--label', '#0c6');
    ctx.textAlign = 'center';
    ctx.fillText(timeStr(t0), padL, h - 7);
    ctx.fillText(timeStr(t0 + spanT / 2), padL + plotW / 2, h - 7);
    ctx.fillText(timeStr(t1), w - padR, h - 7);
    ctx.textAlign = 'left';
    ctx.font = '10px sans-serif';
    ctx.fillText(t('chart.hint') + (this.followTail ? ` · ${t('chart.statusFollow')}` : ` · ${t('chart.statusManual')}`), padL, padT - 4);

    // hover crosshair + tooltip
    if (this.hoverX !== null && pts.length) {
      const hx = Math.min(Math.max(this.hoverX, padL), padL + plotW);
      const frac = (hx - padL) / plotW;
      const tt = t0 + frac * spanT;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(pts[i].t - tt);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      const p = pts[best];
      ctx.strokeStyle = cssVar('--focus', '#0f8');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      const lines: string[] = [timeStr(p.t)];
      for (let si = 0; si < this.defs.length; si++) {
        const v = p.values[si];
        if (v === undefined || !this.visible.has(this.defs[si].id)) continue;
        lines.push(`${this.defs[si].id}: ${fmtVal(this.defs[si], v)}`);
      }
      const bw = 138;
      const bh = 14 * lines.length + 6;
      const bx = hx + 12 > w - bw ? hx - bw - 12 : hx + 12;
      const by = Math.max(4, Math.min(24, padT + plotH - bh));
      ctx.fillStyle = 'rgba(6,10,6,0.92)';
      ctx.strokeStyle = cssVar('--border', '#0a3');
      ctx.lineWidth = 1;
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.font = '11px ui-monospace, monospace';
      lines.forEach((ln, i) => {
        ctx.fillStyle = i === 0 ? cssVar('--label', '#0c6') : this.defs.find((d) => ln.startsWith(d.id + ':'))?.color ?? '#fff';
        ctx.fillText(ln, bx + 5, by + 13 + i * 14);
      });
    }
  }

  exportPng(filename = `dps150-chart-${Date.now()}.png`): void {
    const a = document.createElement('a');
    a.href = this.canvas.toDataURL('image/png');
    a.download = filename;
    a.click();
  }

  exportCsv(): string {
    const head = ['time', ...this.defs.map((d) => d.id)];
    const { pts } = this.windowed();
    const esc = (v: string | number | undefined) => {
      if (v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = pts.map((p) => [new Date(p.t).toISOString(), ...p.values.map((v) => esc(v))].join(','));
    return '\ufeff' + [head.join(','), ...rows].join('\r\n') + '\r\n';
  }
}
