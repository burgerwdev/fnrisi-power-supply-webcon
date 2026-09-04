// Scan tab UI: voltage/current sweep wizard with live VI plot and CSV export.
import type { DeviceController } from '../../device/controller';
import { t } from '../../i18n';
import { measureAverage, ScanRunner, type ScanPoint } from '../../sequence/scanner';
import { h, on, q } from '../../ui/dom';
import { confirmDialog } from '../../ui/confirm';
import { download } from '../../storage/export';
import { TelemetryChart } from '../../ui/chart';
import { uiGate } from '../../app/activity';

export function initScanTab(root: HTMLElement, device: DeviceController): void {
  root.textContent = '';
  root.append(h('h2', {}, t('page.scan')));
  let runner: ScanRunner | null = null;
  let activeTok: number | null = null;
  let lastPoints: ScanPoint[] = [];

  const kindSel = h('select', { id: 'sc-kind', title: t('scan.tip.kind') },
    h('option', { value: 'voltage' }, t('scan.kindV')),
    h('option', { value: 'current' }, t('scan.kindA')));
  const startLbl = h('label', { class: 'sc-lbl', title: t('scan.tip.start') }, t('scan.sweepStart'));
  const stopLbl = h('label', { class: 'sc-lbl', title: t('scan.tip.stop') }, t('scan.sweepStop'));
  const stepLbl = h('label', { class: 'sc-lbl', title: t('scan.tip.step') }, t('scan.step'));
  const fixedLbl = h('label', { class: 'sc-lbl', title: t('scan.tip.fixed') }, t('scan.fixedCurr'));
  const settleLbl = h('label', { class: 'sc-lbl', title: t('scan.tip.settle') }, t('scan.settle'));
  const startIn = h('input', { id: 'sc-start', type: 'number', step: '0.01', value: '0.5', title: t('scan.tip.start') }) as HTMLInputElement;
  const stopIn = h('input', { id: 'sc-stop', type: 'number', step: '0.01', value: '1.0', title: t('scan.tip.stop') }) as HTMLInputElement;
  const stepIn = h('input', { id: 'sc-step', type: 'number', step: '0.01', min: '0.001', value: '0.5', title: t('scan.tip.step') }) as HTMLInputElement;
  const fixedIn = h('input', { id: 'sc-fixed', type: 'number', step: '0.001', value: '0.02', title: t('scan.tip.fixed') }) as HTMLInputElement;
  const settleIn = h('input', { id: 'sc-settle', type: 'number', step: '100', min: '0', value: '150', title: t('scan.tip.settle') }) as HTMLInputElement;
  const run = h('button', { class: 'primary' }, t('scan.run'));
  const stop = h('button', { disabled: true }, t('scan.stop'));
  const exportCsv = h('button', { disabled: true }, t('scan.csv'));
  const status = h('div', { id: 'sc-status', class: 'notice' }, t('scan.idle'));
  const chartTitle = h('div', { class: 'chart-title' },
    h('span', { class: 'ct-txt' }, t('scan.chartTitle')),
    h('span', { class: 'ct-sub' }, t('scan.chartHint')));
  const chartWrap = h('div', { id: 'sc-chart', class: 'chart-wrap scan', style: 'height:280px;border:1px solid var(--border);border-radius:4px' },
    h('canvas', { id: 'sc-canvas', class: 'cc-canvas', style: 'width:100%;height:100%;display:block' }));
  const tableWrap = h('div', { class: 'table-scroll' });

  function sweepUnit(): 'V' | 'A' {
    return kindSel.value === 'voltage' ? 'V' : 'A';
  }
  function relabel(): void {
    const isV = kindSel.value === 'voltage';
    fixedLbl.textContent = isV ? t('scan.fixedCurr') : t('scan.fixedVolt');
  }
  kindSel.addEventListener('change', relabel);
  relabel();

  function renderTable(points: ScanPoint[]): void {
    tableWrap.textContent = '';
    if (!points.length) {
      tableWrap.append(h('div', { class: 'notice' }, t('scan.noResult')));
      return;
    }
    const header = ['#', t('scan.sweptCol'), t('scan.tableMeasV'), t('scan.tableMeasA'), t('scan.tableMeasW')];
    const grid = h('div', { style: 'display:grid;grid-template-columns:repeat(5,minmax(90px,1fr));gap:2px;font-size:12px;margin-top:8px' });
    for (const c of header) grid.append(h('div', { style: 'color:var(--label)' }, c));
    for (const p of points) {
      grid.append(h('div', {}, String(p.index)));
      grid.append(h('div', {}, p.swept.toFixed(3)));
      grid.append(h('div', {}, p.voltage.toFixed(3)));
      grid.append(h('div', {}, p.current.toFixed(4)));
      grid.append(h('div', {}, p.power.toFixed(4)));
    }
    tableWrap.append(grid);
  }

  function setRunning(running: boolean): void {
    run.disabled = running;
    stop.disabled = !running;
    exportCsv.disabled = running || lastPoints.length === 0;
    kindSel.disabled = running;
  }

  on(run, 'click', async () => {
    if (activeTok !== null) return;
    const tok = uiGate.beginAuto(t('task.scan'), () => runner?.requestStop());
    if (tok === null) {
      void confirmDialog({ title: t('scan.busy.title'), body: t('scan.busy.body').replace('{label}', uiGate.current().label ?? ''), okText: t('scan.know'), danger: true });
      return;
    }
    activeTok = tok;
    const kind = kindSel.value as 'voltage' | 'current';
    const start = Number(startIn.value);
    const stopVal = Number(stopIn.value);
    const step = Number(stepIn.value);
    const fixed = Number(fixedIn.value);
    if (![start, stopVal, step, fixed].every(Number.isFinite)) return;
    const ok = await confirmDialog({
      title: kind === 'voltage' ? t('scan.confirmVstart') : t('scan.confirmAstart'),
      body: t('scan.confirmBody'),
      detail:
        kind === 'voltage'
          ? `${t('scan.axisV')}: ${start} → ${stopVal},${t('scan.step')} ${step};${t('scan.fixedCurr')}=${fixed};${t('scan.settle')} ${settleIn.value}ms`
          : `${t('scan.axisA')}: ${start} → ${stopVal},${t('scan.step')} ${step};${t('scan.fixedVolt')}=${fixed};${t('scan.settle')} ${settleIn.value}ms`,
      okText: t('scan.confirmOk'),
      danger: true,
    });
    if (!ok || !device.isOpen()) return;
    await device.setOutput(true).catch(() => undefined);
    lastPoints = [];
    setRunning(true);
    const points: ScanPoint[] = [];
    runner = new ScanRunner(
      { kind, start, stop: stopVal, step, fixed, settleMs: Math.max(0, Number(settleIn.value) || 0), measureMs: 900 },
      {
        apply: async (v, a) => {
          await device.setVoltage(v);
          await device.setCurrent(a);
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        measure: () => measureAverage(device, 900),
        isDeviceOk: () => device.getState().connected,
        onProgress: (d, total, label) => {
          status.textContent = `${t('scan.running')} ${d}/${total} · ${label}`;
        },
        onPoint: (pt, d, total) => {
          // live preview without mutating the final list (final list assembled in onFinished)
          const live = [...points, pt];
          renderTable(live);
          exportCsv.disabled = false;
          status.textContent = `${t('scan.running')} ${d}/${total} · ${live.length}${t('scan.pointsSuffix')}`;
        },
        onProblem: async (msg) => {
          const c = await confirmDialog({ title: t('scan.devIssue.title'), body: msg, okText: t('scan.devIssue.ok'), danger: true });
          return c;
        },
        onFinished: (pts, interrupted) => {
          if (activeTok !== null) {
            uiGate.endAuto(activeTok);
            activeTok = null;
          }
          points.push(...pts);
          lastPoints = points;
          setRunning(false);
          runner = null;
          renderTable(points);
          status.textContent = `${interrupted ? t('scan.stopped') : t('scan.done')} · ${points.length}${t('scan.pointsSuffix')}${t('scan.outClosed')}`;
          void device.setOutput(false).catch(() => undefined);
        },
      },
    );
    void runner.run();
  });

  on(stop, 'click', () => {
    uiGate.requestStop();
    status.textContent = t('scan.stopping');
  });

  on(exportCsv, 'click', () => {
    const head = ['#', `swept(${sweepUnit()})`, 'voltage', 'current', 'power'];
    const rows = lastPoints.map((p) => [p.index, p.swept, p.voltage, p.current, p.power]);
    const esc = (v: string | number) => {
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = '\ufeff' + [head.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
    download(`scan-${sweepUnit()}-${Date.now()}.csv`, csv);
  });

  root.append(
    h('div', { class: 'notice' }, t('scan.notice')),
    h('div', { class: 'sc-fields' },
      h('div', { class: 'sc-field' }, h('label', { class: 'sc-lbl' }, t('scan.axis')), kindSel),
      h('div', { class: 'sc-field' }, startLbl, startIn),
      h('div', { class: 'sc-field' }, stopLbl, stopIn),
      h('div', { class: 'sc-field' }, stepLbl, stepIn),
      h('div', { class: 'sc-field' }, fixedLbl, fixedIn),
      h('div', { class: 'sc-field' }, settleLbl, settleIn),
    ),
    h('div', { class: 'row' }, run, stop, exportCsv, status),
    chartTitle,
    chartWrap,
    tableWrap,
    h('div', { class: 'notice' }, t('scan.chartNote')),
  );
  const chart = new TelemetryChart(q('#sc-canvas', root) as HTMLCanvasElement, ['vout', 'iout', 'pout'], { windowMs: 90_000 });
  chart.setPrimary('vout');
  device.on('telemetry', (st) => chart.push(st));
  device.on('state', (st) => chart.push(st));
  setRunning(false);
}
