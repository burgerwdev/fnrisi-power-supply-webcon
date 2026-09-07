// Scan tab UI: voltage/current sweep wizard with live VI plot and CSV export.
import type { DeviceController } from '../../device/controller';
import { t } from '../../i18n';
import { measureAverage, ScanRunner, type ScanPoint } from '../../sequence/scanner';
import { h, on, q } from '../../ui/dom';
import { confirmDialog } from '../../ui/confirm';
import { download } from '../../storage/export';
import { TelemetryChart } from '../../ui/chart';
import { ViChart } from '../../ui/vichart';
import { deleteScanRecord, listScanRecords, saveScanRecord, type ScanRecord } from '../../storage/scanrecords';
import { uiGate } from '../../app/activity';

export function initScanTab(root: HTMLElement, device: DeviceController): void {
  root.textContent = '';
  let viLinTitle: HTMLElement | null = null;
  let viLogTitle: HTMLElement | null = null;
  let viLin: ViChart | null = null;
  let viLog: ViChart | null = null;
  root.append(h('h2', {}, t('page.scan')));
  let runner: ScanRunner | null = null;
  let activeTok: number | null = null;
  let lastPoints: ScanPoint[] = [];
  let records: ScanRecord[] = [];
  let selectedRecordId: string | null = null;

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
  // V-I 分析双图(线性 + 半对数,可叠加功率)
  const powerChk = h('label', { class: 'vi-toggle', title: t('scan.overlayPowerTip') },
    h('input', { type: 'checkbox' }), ' ', t('scan.overlayPower'));
  viLinTitle = h('div', { class: 'vi-title' }, `${t('scan.linearVI')} · ${t('scan.viTip')}`);
  viLogTitle = h('div', { class: 'vi-title' }, `${t('scan.semilogVI')} · ${t('scan.viTip')}`);
  const viLinWrap = h('div', { class: 'vi-box', title: t('scan.viTip') }, viLinTitle,
    h('canvas', { id: 'vi-lin', class: 'cc-canvas', style: 'width:100%;display:block' }));
  const viLogWrap = h('div', { class: 'vi-box', title: t('scan.viTip') }, viLogTitle,
    h('canvas', { id: 'vi-log', class: 'cc-canvas', style: 'width:100%;display:block' }));
  const viRow = h('div', { class: 'vi-row' }, viLinWrap, viLogWrap);
  // 记录工具栏
  const recSel = h('select', { id: 'sc-rec', title: t('scan.recordsTip') });
  const recLoad = h('button', { disabled: true }, t('scan.loadRec'));
  const recDel = h('button', { disabled: true }, t('scan.deleteRec'));
  const clear = h('button', { id: 'sc-clear' }, t('scan.clear'));
  const recBar = h('div', { class: 'row sc-recbar' },
    h('span', { class: 'sc-rec-label' }, t('scan.records')),
    recSel, recLoad, recDel, exportCsv, h('span', { class: 'spacer' }), clear, powerChk);

  function sweepUnit(): 'V' | 'A' {
    return kindSel.value === 'voltage' ? 'V' : 'A';
  }
  function relabel(): void {
    const isV = kindSel.value === 'voltage';
    const unit = isV ? 'V' : 'A';
    fixedLbl.textContent = isV ? t('scan.fixedCurr') : t('scan.fixedVolt');
    startLbl.textContent = `${t('scan.sweepStart')} (${unit})`;
    stopLbl.textContent = `${t('scan.sweepStop')} (${unit})`;
    stepLbl.textContent = `${t('scan.step')} (${unit})`;
    const kind = kindSel.value as 'voltage' | 'current';
    if (viLinTitle) viLinTitle.textContent = `${kind === 'voltage' ? t('scan.linearVI') : t('scan.linearIV')} · ${t('scan.viTip')}`;
    if (viLogTitle) viLogTitle.textContent = `${kind === 'voltage' ? t('scan.semilogVI') : t('scan.semilogIV')} · ${t('scan.viTip')}`;
    viLin?.setKind(kind);
    viLog?.setKind(kind);
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
    if (![start, stopVal, step, fixed].every(Number.isFinite)) {
      uiGate.endAuto(activeTok);
      activeTok = null;
      return;
    }
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
    if (!ok || !device.isOpen()) {
      uiGate.endAuto(activeTok);
      activeTok = null;
      return;
    }
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
          // accumulate live so the VI charts draw during the sweep
          points.push(pt);
          renderTable(points);
          viLin!.setData(points);
          viLog!.setData(points);
          exportCsv.disabled = false;
          status.textContent = `${t('scan.running')} ${d}/${total} · ${points.length}${t('scan.pointsSuffix')}`;
        },
        onProblem: async (msg) => {
          const c = await confirmDialog({ title: t('scan.devIssue.title'), body: msg, okText: t('scan.devIssue.ok'), danger: true });
          return c;
        },
        onFinished: (_pts, interrupted) => {
          if (activeTok !== null) {
            uiGate.endAuto(activeTok);
            activeTok = null;
          }
          lastPoints = points;
          setRunning(false);
          runner = null;
          renderTable(points);
          updateViCharts();
          status.textContent = `${interrupted ? t('scan.stopped') : t('scan.done')} · ${points.length}${t('scan.pointsSuffix')}${t('scan.outClosed')}`;
          void device.setOutput(false).catch(() => undefined);
          const rec: ScanRecord = {
            id: `s${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            createdAt: Date.now(),
            kind,
            start,
            stop: stopVal,
            step,
            fixed,
            settleMs: Math.max(0, Number(settleIn.value) || 0),
            points: [...points],
            interrupted,
          };
          void saveScanRecord(rec).then(() => {
            records = [...records, rec];
            selectedRecordId = rec.id;
            refreshRecList();
          });
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
    h('div', { class: 'row sc-settings-run' },
      h('div', { class: 'sc-fields' },
        h('div', { class: 'sc-field' }, h('label', { class: 'sc-lbl' }, t('scan.axis')), kindSel),
        h('div', { class: 'sc-field' }, startLbl, startIn),
        h('div', { class: 'sc-field' }, stopLbl, stopIn),
        h('div', { class: 'sc-field' }, stepLbl, stepIn),
        h('div', { class: 'sc-field' }, fixedLbl, fixedIn),
        h('div', { class: 'sc-field' }, settleLbl, settleIn),
      ),
      h('div', { class: 'sc-runctrl' }, run, stop, status)),
    recBar,
    chartTitle,
    chartWrap,
    viRow,
    tableWrap,
    h('div', { class: 'notice' }, t('scan.chartNote')),
  );
  const chart = new TelemetryChart(q('#sc-canvas', root) as HTMLCanvasElement, ['vout', 'iout', 'pout'], { windowMs: 90_000 });
  chart.setPrimary('vout');
  device.on('telemetry', (st) => chart.push(st));
  device.on('state', (st) => chart.push(st));
  viLin = new ViChart(q('#vi-lin', root) as HTMLCanvasElement, { logY: false, showPower: false, kind: kindSel.value as 'voltage' | 'current' });
  viLog = new ViChart(q('#vi-log', root) as HTMLCanvasElement, { logY: true, showPower: false, kind: kindSel.value as 'voltage' | 'current' });

  // ---- records management ----
  function recLabel(r: ScanRecord): string {
    const d = new Date(r.createdAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm} · ${r.kind === 'voltage' ? 'V' : 'A'} ${r.start}→${r.stop} step ${r.step} · ${r.points.length} pts${r.interrupted ? ' (int)' : ''}`;
  }
  function updateViCharts(): void {
    viLin!.setData(lastPoints);
    viLog!.setData(lastPoints);
  }
  function refreshRecList(): void {
    recSel.textContent = '';
    for (const r of records) {
      recSel.append(h('option', { value: r.id }, recLabel(r)));
    }
    const any = records.length > 0;
    recLoad.disabled = !any;
    recDel.disabled = !any;
    if (!any) selectedRecordId = null;
    else if (!records.some((r) => r.id === selectedRecordId)) selectedRecordId = records[0].id;
    recSel.value = selectedRecordId ?? '';
  }
  async function loadRecords(): Promise<void> {
    records = await listScanRecords();
    refreshRecList();
  }
  function viewRecord(id: string): void {
    const r = records.find((x) => x.id === id);
    if (!r) return;
    lastPoints = [...r.points];
    selectedRecordId = id;
    setRunning(false);
    renderTable(r.points);
    updateViCharts();
    status.textContent = `${t('scan.loadedRec')} · ${r.points.length}${t('scan.pointsSuffix')}`;
  }
  on(recSel, 'change', () => {
    selectedRecordId = recSel.value || null;
    if (selectedRecordId) viewRecord(selectedRecordId);
  });
  on(recLoad, 'click', () => {
    const id = recSel.value || selectedRecordId;
    if (id) viewRecord(id);
  });
  on(recDel, 'click', async () => {
    const id = recSel.value || selectedRecordId;
    if (!id) return;
    const ok = await confirmDialog({ title: t('scan.deleteRec.title'), body: t('scan.deleteRec.body'), okText: t('scan.delete'), danger: true });
    if (!ok) return;
    await deleteScanRecord(id);
    await loadRecords();
    lastPoints = [];
    renderTable([]);
    updateViCharts();
    status.textContent = t('scan.idle');
  });
  on(clear, 'click', () => {
    lastPoints = [];
    renderTable([]);
    updateViCharts();
    status.textContent = t('scan.idle');
    refreshRecList();
    chart.clear();
  });
  powerChk.addEventListener('change', () => {
    const on = (powerChk.querySelector('input') as HTMLInputElement).checked;
    viLin!.setShowPower(on);
    viLog!.setShowPower(on);
  });
  setRunning(false);
  void loadRecords();
}
