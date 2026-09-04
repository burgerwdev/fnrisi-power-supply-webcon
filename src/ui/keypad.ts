// Floating semi-transparent numeric keypad: draggable, closable, targets V/A inputs.
import { h, on } from './dom';
import { t } from '../i18n';

export class FloatingKeypad {
  private panel: HTMLElement;
  private header: HTMLElement;
  private body: HTMLElement;
  private visible = false;
  private dragging = false;
  private dx = 0;
  private dy = 0;
  private active: HTMLInputElement | null = null;
  private fresh = false; // just focused + select-all; first key should replace rather than append

  constructor(private targetA: HTMLInputElement, private targetB: HTMLInputElement) {
    this.panel = h('div', { class: 'kbd float', hidden: '' });
    this.header = h('div', { class: 'kbd-head' }, h('span', { class: 'kbd-title' }, t('kbd.title')), h('button', { type: 'button', class: 'kbd-close', title: t('kbd.close') }, '×'));
    this.body = h('div', { class: 'kbd-body' });
    this.panel.append(this.header, this.body);
    document.body.append(this.panel);
    on(this.header, 'pointerdown', (e) => this.startDrag(e));
    on(this.header.querySelector('.kbd-close') as HTMLButtonElement, 'click', () => this.hide());
    this.targetA.addEventListener('input', () => this.render());
    this.targetB.addEventListener('input', () => this.render());
    // clicking anywhere else focuses? keep simple: click on target fields already tracked by page
  }

  private startDrag(e: PointerEvent): void {
    if ((e.target as HTMLElement).classList.contains('kbd-close')) return;
    e.preventDefault();
    this.dragging = true;
    const r = this.panel.getBoundingClientRect();
    this.dx = e.clientX - r.left;
    this.dy = e.clientY - r.top;
    const move = (ev: PointerEvent): void => {
      if (!this.dragging) return;
      const pw = this.panel.offsetWidth || 340;
      const ph = this.panel.offsetHeight || 300;
      const left = Math.min(Math.max(4, ev.clientX - this.dx), Math.max(4, window.innerWidth - pw - 4));
      const top = Math.min(Math.max(4, ev.clientY - this.dy), Math.max(4, window.innerHeight - ph - 4));
      this.panel.style.right = 'auto';
      this.panel.style.bottom = 'auto';
      this.panel.style.left = `${left}px`;
      this.panel.style.top = `${top}px`;
    };
    const up = (): void => {
      this.dragging = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private current(): HTMLInputElement {
    // Remember the most recently focused target, so pressing keypad buttons after losing focus doesn't write back to the wrong field.
    if (this.active) return this.active;
    const focused = document.activeElement;
    if (focused === this.targetA) return this.targetA;
    if (focused === this.targetB) return this.targetB;
    return this.targetB.value ? this.targetA : this.targetA;
  }

  isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    this.visible = true;
    const f = document.activeElement;
    if (f === this.targetA || f === this.targetB) {
      this.active = f as HTMLInputElement;
      this.fresh = true;
    }
    this.panel.hidden = false;
    this.render();
    // Initial position: below the current target input box, kept within the viewport
    const t = this.current().getBoundingClientRect();
    const pw = Math.min(340, Math.max(220, window.innerWidth - 16));
    this.panel.style.width = pw + 'px';
    this.panel.style.right = 'auto';
    this.panel.style.bottom = 'auto';
    let left = Math.max(8, Math.min(t.left, window.innerWidth - pw - 8));
    let top = t.bottom + 8;
    const ph = this.panel.offsetHeight || 320;
    if (top + ph > window.innerHeight - 8) {
      top = Math.max(8, t.top - ph - 8);
    }
    this.panel.style.left = `${left}px`;
    this.panel.style.top = `${top}px`;
  }

  hide(): void {
    this.visible = false;
    this.panel.hidden = true;
  }

  private render(): void {
    if (!this.visible) return;
    const target = this.current();
    const isV = target === this.targetA;
    this.panel.classList.toggle('tone-v', isV);
    this.panel.classList.toggle('tone-a', !isV);
    this.body.textContent = '';
    const lbl = h('div', { class: 'kbd-target' }, isV ? t('kbd.enteringV') : t('kbd.enteringA'));
    const grid = h('div', { class: 'kbd-grid' });
    for (const k of ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.', '⌫']) {
      const b = h('button', { type: 'button', class: 'kbd-key' }, k);
      on(b, 'click', () => {
        const target = this.current();
        const cur = this.fresh ? '' : target.value; // first key after select-all replaces the original content
        if (k === '⌫') target.value = cur.slice(0, -1);
        else {
          if (k === '.' && cur.includes('.')) return;
          if (cur.length >= 9) return;
          target.value = cur + k;
        }
        this.fresh = false;
        this.render();
      });
      grid.append(b);
    }
    const clr = h('button', { type: 'button', class: 'kbd-key wide' }, t('kbd.clear'));
    on(clr, 'click', () => {
      target.value = '';
      this.fresh = false;
      this.render();
    });
    grid.append(clr);
    const quick = h('div', { class: 'kbd-quick' }, h('span', { class: 'os-lbl' }, t('kbd.quick')));
    const vals = isV ? ['1.00', '3.30', '5.00', '12.00', '19.00', '24.00'] : ['0.005', '0.010', '0.050', '0.100', '0.500', '1.000', '5.000'];
    for (const v of vals) {
      const b = h('button', { type: 'button', class: 'kbd-key quick' }, v);
      on(b, 'click', () => {
        target.value = v;
        this.fresh = false;
        this.render();
      });
      quick.append(b);
    }
    this.body.append(lbl, grid, quick);
  }
}
