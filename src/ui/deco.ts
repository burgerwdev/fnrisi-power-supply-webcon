// Decorative canvas: standby sine when disconnected, live Vout sparkline when connected.
import type { DeviceController } from '../device/controller';

export class DecoWave {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private phase = 0;
  private buf: number[] = [];
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement, device: DeviceController) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.size();
    window.addEventListener('resize', () => this.size());
    device.on('telemetry', (s) => {
      const v = s.telemetry.outputVoltage;
      if (v !== undefined && Number.isFinite(v)) {
        this.buf.push(v);
        if (this.buf.length > 240) this.buf.shift();
      }
    });
    const tick = (): void => {
      if (!this.destroyed) {
        this.draw();
        this.raf = requestAnimationFrame(tick);
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
  }

  private size(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    const w = rect?.width || 800;
    const h = 40;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.height = '100%';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    ctx.strokeStyle = css.getPropertyValue('--border-soft') || '#0a2';
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (!this.buf.length) {
      // standby slow sine
      this.phase += 0.03;
      ctx.strokeStyle = css.getPropertyValue('--dim') || '#2e7a2e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const y = h / 2 + Math.sin(x / 46 + this.phase) * (h / 3);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else {
      // live sparkline of Vout
      const cssV = css.getPropertyValue('--chart-line-v') || '#46f08a';
      ctx.strokeStyle = cssV;
      ctx.lineWidth = 1.8;
      ctx.shadowColor = cssV;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      const n = this.buf.length;
      let min = Infinity;
      let max = -Infinity;
      for (const v of this.buf) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const span = Math.max(1e-6, max - min);
      for (let i = 0; i < n; i++) {
        const x = (i / Math.max(1, n - 1)) * w;
        const y = h - 3 - ((this.buf[i] - min) / span) * (h - 6);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }
}
