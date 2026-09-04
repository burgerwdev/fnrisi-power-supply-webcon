// Preset (M1..M6) and protection tabs.
import type { DeviceController } from '../../device/controller';
import { t } from '../../i18n';
import { PROTECTION_REGS, type ProtectionKind } from '../../api/facade';
import { q, h, on } from '../../ui/dom';

const PROT_DEF: { kind: ProtectionKind; label: string; unit: string }[] = [
  { kind: 'ovp', label: t('prot.ovp'), unit: 'V' },
  { kind: 'ocp', label: t('prot.ocp'), unit: 'A' },
  { kind: 'opp', label: t('prot.opp'), unit: 'W' },
  { kind: 'otp', label: t('prot.otp'), unit: '°C' },
  { kind: 'lvp', label: t('prot.lvp'), unit: 'V' },
];

export function initPresetTab(root: HTMLElement, device: DeviceController): void {
  root.textContent = '';
  root.append(h('h2', {}, t('page.preset')));
  root.append(
    h('div', { class: 'notice', style: 'margin:0 0 8px' },
      t('preset.notice')),
    h('div', { id: 'ps-grid', style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:8px' }),
  );
  const grid = q('#ps-grid', root) as HTMLElement;
  const cells: { n: number; v: HTMLInputElement; a: HTMLInputElement; cur: HTMLElement }[] = [];
  for (let n = 1; n <= 6; n++) {
    const vin = h('input', { type: 'number', step: '0.01', min: '0', value: '5.0', style: 'width:90px' }) as HTMLInputElement;
    const ain = h('input', { type: 'number', step: '0.001', min: '0', value: '1.0', style: 'width:90px' }) as HTMLInputElement;
    const store = h('button', { title: t('preset.store.title') }, t('preset.store'));
    const cur = h('span', { class: 'notice', style: 'font-size:11px' }, t('preset.deviceNowEmpty'));
    cells.push({ n, v: vin, a: ain, cur });
    on(store, 'click', async () => {
      const v = Number(vin.value);
      const a = Number(ain.value);
      if (!Number.isFinite(v) || !Number.isFinite(a)) return;
      await device.setPreset(n, v, a);
      syncInputs();
    });

    grid.append(
      h('div', { class: 'panel', style: 'margin:0' },
        h('h2', { style: 'margin-bottom:4px' }, `M${n}`),
        h('div', { class: 'row ps-va-row' },
          h('label', { title: t('set.voltage') }, t('set.voltage')), vin, h('span', { class: 'ps-unit v' }, 'V'),
          h('label', { title: t('set.current') }, t('set.current')), ain, h('span', { class: 'ps-unit a' }, 'A')),
        h('div', { class: 'row', style: 'margin-top:6px' }, store),
        h('div', { class: 'row', style: 'margin-top:2px' }, cur),
      ),
    );
  }
  function syncInputs(): void {
    const s = device.getState();
    s.presets.forEach((p, i) => {
      const c = cells[i];
      if (!c) return;
      if (document.activeElement !== c.v && document.activeElement !== c.a) {
        c.v.value = p.voltage.toFixed(2);
        c.a.value = p.current.toFixed(3);
      }
      c.cur.textContent = t('preset.deviceNow') + ` ${p.voltage.toFixed(2)} V / ${p.current.toFixed(3)} A`;
    });
  }
  device.on('state', syncInputs);
  device.on('telemetry', syncInputs);
  syncInputs();
}

export function initProtectTab(root: HTMLElement, device: DeviceController): void {
  root.textContent = '';
  root.append(h('div', { class: 'notice' }, t('prot.notice')));
  const rows = h('div', {});
  const inputs: Record<string, HTMLInputElement> = {};
  for (const d of PROT_DEF) {
    const inp = h('input', { type: 'number', step: '0.1', min: '0', style: 'width:120px' }) as HTMLInputElement;
    inputs[d.kind] = inp;
    const apply = h('button', {}, t('prot.apply'));
    on(apply, 'click', async () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v)) return;
      await device.setProtection(PROTECTION_REGS[d.kind], v);
    });
    rows.append(
      h('div', { class: 'row' },
        h('label', { style: 'min-width:150px' }, `${d.label} (${d.unit})`),
        inp,
        apply,
      ),
    );
  }
  root.append(rows);
  const sync = (): void => {
    const p = device.getState().protections;
    for (const d of PROT_DEF) {
      const v = p[d.kind];
      const inp = inputs[d.kind];
      if (v !== undefined && document.activeElement !== inp) inp.value = String(Number(v.toFixed(2)));
    }
  };
  device.on('state', sync);
  device.on('telemetry', sync);
  sync();
}
