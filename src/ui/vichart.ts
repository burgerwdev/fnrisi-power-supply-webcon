// Compact V-I chart for the scan analysis: plots current vs voltage (linear or
// log10-y), optional power overlay, adaptive unit, and hover value readout.
import type { ScanPoint } from '../sequence/scanner';

export interface ViChartOptions {
  logY: boolean; // semi-log (log10 y-axis) vs linear
  showPower: boolean; // overlay power (right scale) as a second series
  kind: 'voltage' | 'current'; // voltage -> V-I (x=voltage, y=current); current -> I-V
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function fmtNum(v: number, dec: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-4)) return v.toExponential(2);
  return v.toFixed(dec).replace(/\.?0+$/, '');
}

// Pick a human-friendly current unit (A / mA / uA) from the visible range.
function pickUnit(maxAbs: number): { div: number; unit: string } {
  if (maxAbs <= 0) return { div: 1, unit: 'A' };
  if (maxAbs < 1e-3) return { div: 1e-6, unit: 'µA' };
  if (maxAbs < 1) return { div: 1e-3, unit: 'mA' };
  return { div: 1, unit: 'A' };
}

export class ViChart {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pts: { x: number; y: number; p: number }[] = [];
  private opts: ViChartOptions;
  private hoverX: number | null = null;
  private view: { vMin: number; vMax: number } | null = null; // null = auto fit
  private drag = { on: false, startX: 0, startView: { vMin: 0, vMax: 0 } };
  private padL = 58;
  private padR = 56;
  private padT = 16;
  private padB = 30;

  constructor(canvas: HTMLCanvasElement, opts: ViChartOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.opts = opts;
    window.addEventListener('resize', () => this.size());
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointerup', () => { this.drag.on = false; });
    canvas.addEventListener('pointerleave', () => { this.hoverX = null; this.drag.on = false; this.draw(); });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', () => { this.view = null; this.draw(); });
    requestAnimationFrame(() => this.size());
  }

  setData(points: ScanPoint[]): void {
    this.pts = points.map((p) =>
      this.opts.kind === 'voltage' ? { x: p.voltage, y: p.current, p: p.power } : { x: p.current, y: p.voltage, p: p.power },
    );
    this.sizeIfNeeded();
    this.draw();
  }

  setKind(kind: 'voltage' | 'current'): void {
    if (this.opts.kind !== kind) {
      // swap x/y (voltage<->current) in place
      for (const q of this.pts) { const t = q.x; q.x = q.y; q.y = t; }
      this.opts.kind = kind;
    }
    this.draw();
  }

  setShowPower(show: boolean): void {
    this.opts.showPower = show;
    this.draw();
  }

  clear(): void {
    this.pts = [];
    this.hoverX = null;
    this.draw();
  }

  private onMove(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (this.drag.on) {
      const [rw] = this.plotSize(r.width, r.height);
      const span = this.drag.startView.vMax - this.drag.startView.vMin || 1;
      const dx = ((x - this.drag.startX) / (rw || 1)) * span;
      this.view = { vMin: this.drag.startView.vMin - dx, vMax: this.drag.startView.vMax - dx };
      this.hoverX = null;
      this.draw();
      return;
    }
    this.hoverX = x;
    this.draw();
  }

  private onDown(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const [dvMin, dvMax] = this.dataXRange();
    const cur = this.view ?? { vMin: dvMin, vMax: dvMax };
    this.drag = { on: true, startX: x, startView: cur };
    e.preventDefault();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const [dvMin, dvMax] = this.dataXRange();
    const cur = this.view ?? { vMin: dvMin, vMax: dvMax };
    const span = cur.vMax - cur.vMin || (dvMax - dvMin) || 1;
    const frac = Math.min(1, Math.max(0, (x - this.padL) / (r.width - this.padL - this.padR)));
    const anchor = cur.vMin + frac * span;
    const factor = e.deltaY < 0 ? 1 / 1.4 : 1.4;
    const newSpan = span * factor;
    this.view = { vMin: anchor - frac * newSpan, vMax: anchor + (1 - frac) * newSpan };
    this.draw();
  }

  private dataXRange(): [number, number] {
    let vMin = Infinity, vMax = -Infinity;
    for (const q of this.pts) { if (q.x < vMin) vMin = q.x; if (q.x > vMax) vMax = q.x; }
    if (!Number.isFinite(vMax)) return [0, 1];
    if (vMax === vMin) vMax = vMin + 1;
    return [vMin, vMax];
  }

  private xRange(): { vMin: number; vMax: number } {
    const [dmin, dmax] = this.dataXRange();
    return this.view ?? { vMin: dmin, vMax: dmax };
  }

  private plotSize(cw: number, ch: number): [number, number] {
    return [cw - this.padL - this.padR, ch - this.padT - this.padB];
  }

  private sizeIfNeeded(): void {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw > 0 && ch > 0 && (this.canvas.width / Math.max(1, window.devicePixelRatio || 1) !== cw || this.canvas.height / Math.max(1, window.devicePixelRatio || 1) !== ch)) this.size();
  }

  private size(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 360;
    const h = rect.height || 260;
    if (w < 10 || h < 10) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private draw(): void {
    const w = this.canvas.width / Math.max(1, window.devicePixelRatio || 1);
    const h = this.canvas.height / Math.max(1, window.devicePixelRatio || 1);
    const ctx = this.ctx;
    const { padL, padR, padT, padB } = this;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    ctx.clearRect(0, 0, w, h);
    if (w < 10 || h < 10) return;
    ctx.fillStyle = cssVar('--panel-2', '#0a0a0a');
    ctx.fillRect(0, 0, w, h);
    if (this.pts.length < 1) {
      ctx.fillStyle = cssVar('--dim', '#2e7a2e');
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('—', padL + plotW / 2, padT + plotH / 2);
      ctx.textAlign = 'left';
      return;
    }
    // X = sweep axis, Y = measured axis (kind pins which is which; honors zoom/pan view)
    const curOnX = this.opts.kind === 'current';
    const rng = this.xRange();
    const vMin = rng.vMin;
    const vMax = rng.vMax;
    let yMax = -Infinity, pMax = -Infinity, curMax = -Infinity;
    for (const q of this.pts) {
      if (q.x < vMin || q.x > vMax) continue;
      if (q.y > yMax) yMax = q.y;
      if (q.p > pMax) pMax = q.p;
      const cur = curOnX ? q.x : q.y;
      if (cur > curMax) curMax = cur;
    }
    if (yMax === -Infinity) yMax = 1;
    const { div, unit } = pickUnit(curMax);
    const useLog = this.opts.logY;
    // y scale (log or linear on the y-axis field)
    let yLo: number, yHi: number;
    if (useLog) {
      const pos = this.pts.map((q) => q.y).filter((x) => x > 0);
      const lo = pos.length ? Math.min(...pos) : 1e-7;
      const hi = pos.length ? Math.max(...pos) : 1e-6;
      yLo = Math.log10(Math.max(1e-7, lo));
      yHi = Math.log10(Math.max(1e-6, hi * 1.05));
      if (yHi <= yLo) yHi = yLo + 2;
    } else {
      yLo = 0;
      yHi = yMax > 0 ? yMax * 1.1 : 1;
    }
    const X = (x: number) => padL + ((x - vMin) / (vMax - vMin)) * plotW;
    const Y = (y: number): number => {
      if (useLog) {
        const lv = y <= 0 ? Math.log10(Math.max(1e-9, yMax * 1e-6)) : Math.log10(y);
        return padT + (1 - (lv - yLo) / (yHi - yLo)) * plotH;
      }
      const c = Math.max(0, Math.min(y, yHi));
      return padT + (1 - c / yHi) * plotH;
    };
    const fmtY = (val: number) => (curOnX ? fmtNum(val, 2) : fmtNum(val / div, 3));
    const fmtX = (val: number) => (curOnX ? fmtNum(val / div, 3) : fmtNum(val, 2));
    // grid + y ticks
    ctx.strokeStyle = cssVar('--chart-grid', '#123f12');
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = cssVar('--label', '#0c6');
    ctx.textAlign = 'right';
    for (let g = 0; g <= 4; g++) {
      const y = padT + (plotH / 4) * g;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      const valA = useLog ? Math.pow(10, yHi - ((yHi - yLo) / 4) * g) : yHi - (yHi / 4) * g;
      ctx.fillText(fmtY(valA), padL - 4, y + 3);
    }
    // x ticks
    ctx.textAlign = 'center';
    for (let g = 0; g <= 4; g++) {
      const x = padL + (plotW / 4) * g;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.fillText(fmtX(vMin + ((vMax - vMin) / 4) * g), x, h - 12);
    }
    ctx.textAlign = 'left';
    // x axis caption (below ticks), moved to avoid overlap
    ctx.fillStyle = cssVar('--sub', '#0a7a0a');
    const xCap = curOnX ? `I/${unit}` : 'V';
    ctx.fillText(xCap, vMax > vMin ? X((vMin + vMax) / 2) + 8 : padL, h - 4);
    // y axis caption (rotated)
    ctx.fillStyle = cssVar('--label', '#0c6');
    ctx.save();
    ctx.translate(12, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    const yCap = useLog ? (curOnX ? 'log10(V)' : `log10(I/${unit})`) : curOnX ? 'V' : `I/${unit}`;
    ctx.fillText(yCap, 0, 0);
    ctx.restore();
    // clip series/power/crosshair to the plot area (so zooming doesn't overflow)
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.clip();
    // power overlay (right scale)
    if (this.opts.showPower && pMax > 0) {
      ctx.strokeStyle = cssVar('--led-amber', '#e0a030');
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let kicked = false;
      for (const q of this.pts) {
        const x = X(q.x);
        const y = padT + (1 - Math.max(0, q.p) / pMax) * plotH;
        if (!kicked) { ctx.moveTo(x, y); kicked = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = cssVar('--led-amber', '#e0a030');
      ctx.fillText(fmtNum(pMax, 2) + ' W', padL + plotW + 4, padT + 8);
    }
    // current series
    ctx.strokeStyle = cssVar('--led-cyan', '#35b6ff');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (const q of this.pts) {
      const x = X(q.x);
      const y = Y(q.y);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // hover crosshair + value
    if (this.hoverX !== null) {
      const hx = Math.min(Math.max(this.hoverX, padL), padL + plotW);
      const frac = (hx - padL) / plotW;
      const vTarget = vMin + frac * (vMax - vMin);
      let best = 0, bd = Infinity;
      for (let i = 0; i < this.pts.length; i++) {
        const d = Math.abs(this.pts[i].x - vTarget);
        if (d < bd) { bd = d; best = i; }
      }
      const pt = this.pts[best];
      const cx = X(pt.x);
      ctx.strokeStyle = cssVar('--focus', '#0f8');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      const curOnX = this.opts.kind === 'current';
      const box = curOnX
        ? `${fmtNum(pt.x / div, 3)} ${unit} · ${fmtNum(pt.y, 2)} V${this.opts.showPower ? ' · ' + fmtNum(pt.p, 3) + ' W' : ''}`
        : `${fmtNum(pt.x, 2)} V · ${fmtNum(pt.y / div, 3)} ${unit}${this.opts.showPower ? ' · ' + fmtNum(pt.p, 3) + ' W' : ''}`;
      ctx.font = '11px ui-monospace, monospace';
      const bw = ctx.measureText(box).width + 12;
      const bh = 20;
      const bx = cx + 10 > padL + plotW - bw ? cx - bw - 10 : cx + 10;
      const by = Math.max(4, Math.min(padT, h - bh - 2));
      ctx.fillStyle = 'rgba(6,10,6,0.92)';
      ctx.strokeStyle = cssVar('--border', '#0a3');
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = cssVar('--label', '#0c6');
      ctx.fillText(box, bx + 6, by + 14);
    }
  }
}
