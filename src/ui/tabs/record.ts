// Record tab: live chart + session sampling controls + session management & export.
import type { DeviceController } from '../../device/controller';
import { Sampler, loadSessionRows } from '../../session/sampler';
import { deleteSession, listSessions, type SessionMeta } from '../../storage/sessions';
import { loadChartPrefs, loadSettings, saveChartPrefs, saveSettings } from '../../storage/settings';
import { download } from '../../storage/export';
import { fmtClockMs } from '../../ui/format';
import { CHART_SERIES_ORDER, TelemetryChart } from '../../ui/chart';
import { q, h, on } from '../../ui/dom';
import { confirmDialog } from '../../ui/confirm';
import { t } from '../../i18n';

export interface RecordTabOptions {
  device: DeviceController;
  samplePeriodMs: () => number;
  sessionCapPoints: () => number;
}

export function initRecordTab(root: HTMLElement, opts: RecordTabOptions): void {
  const { device } = opts;
  const sampler = new Sampler(device, () => ({
    samplePeriodMs: opts.samplePeriodMs(),
    sessionCapPoints: opts.sessionCapPoints(),
  }));

  root.textContent = '';
  root.append(
    h('div', { class: 'row rec-head' },
      h('span', { class: 'chart-context sh-title' }, t('rec.chartTitle')),
      h('span', { class: 'spacer' }),
      h('span', { class: 'notice', id: 'rc-status' }, t('rec.statusIdle'))),
    h('div', { class: 'row' },
      h('label', { title: t('rec.windowTitle') }, t('rec.window')),
      h('select', { id: 'rc-win', title: t('rec.windowTip') },
        h('option', { value: '10000' }, '10 s'),
        h('option', { value: '60000', selected: true }, '1 min'),
        h('option', { value: '180000' }, '3 min'),
        h('option', { value: '300000' }, '5 min'),
        h('option', { value: '600000' }, '10 min')),
      h('button', { id: 'rc-pause' }, t('rec.pause')),
      h('button', { id: 'rc-clear' }, t('rec.clear')),
      h('button', { id: 'rc-png' }, t('rec.png')),
      h('button', { id: 'rc-csv-live' }, t('rec.csvLive')),
      h('span', { class: 'spacer' }),
      h('label', { title: t('rec.rateTitle') }, t('rec.sampleRate')),
      h('select', { id: 'rc-period', title: t('rec.adaptiveTip') },
        h('option', { value: '0' }, t('rec.fastest')),
        h('option', { value: '500' }, '500 ms'),
        h('option', { value: '1000' }, '1 s'),
        h('option', { value: '2000' }, '2 s'),
        h('option', { value: '5000' }, '5 s'),
        h('option', { value: '-1' }, t('rec.adaptive'))),
      h('button', { id: 'rc-start', class: 'primary' }, t('rec.start')),
      h('button', { id: 'rc-stop', disabled: true }, t('rec.stop')),
    ),
    h('div', { id: 'rc-chart', class: 'chart-wrap', style: 'position:relative;height:280px;border:1px solid var(--border);border-radius:4px' },
      h('canvas', { id: 'rc-canvas', class: 'cc-canvas', style: 'width:100%;height:100%;display:block' })),
    h('div', { class: 'session-section', style: 'margin-top:10px' },
      h('div', { class: 'session-head' },
        h('span', { class: 'sh-title' }, t('rec.sessions')),
        h('span', { class: 'session-count', id: 'rc-session-count' }, '')),
      h('div', { id: 'rc-sessions' }),
      h('div', { class: 'session-pager', id: 'rc-pager' })),
  );

  const $start = q('#rc-start', root) as HTMLButtonElement;
  const $stop = q('#rc-stop', root) as HTMLButtonElement;
  const $status = q('#rc-status', root);
  const $period = q('#rc-period', root) as HTMLSelectElement;
  // Persist the sampling-rate choice to settings (including the "adaptive" option, which the sampler uses to auto-downsample).
  $period.value = String(loadSettings().samplePeriodMs);
  on($period, 'change', () => {
    const st = loadSettings();
    st.samplePeriodMs = Number($period.value);
    saveSettings(st);
  });
  const $sessions = q('#rc-sessions', root);
  const $pager = q('#rc-pager', root);
  const $sessionCount = q('#rc-session-count', root);
  const canvas = q('#rc-canvas', root) as HTMLCanvasElement;

  const chart = new TelemetryChart(canvas, [...CHART_SERIES_ORDER], { windowMs: 60_000 });
  const unsubTelemetry = device.on('telemetry', (s) => chart.push(s));
  const unsubState = device.on('state', (s) => chart.push(s));

  // --- chart legend: each item is a visibility toggle button; primary-axis series selected independently; config persisted ---
  const prefs = loadChartPrefs();
  if (Array.isArray(prefs.visible)) {
    for (const def of chart.defsList) chart.setVisible(def.id, prefs.visible.includes(def.id));
  }
  chart.setPrimary(prefs.primary);
  chart.setSmooth(prefs.smooth);
  const savePrefs = (): void => {
    saveChartPrefs({
      visible: chart.defsList.filter((d) => chart.isVisible(d.id)).map((d) => d.id),
      primary: chart.primaryId,
      smooth: chart.isSmoothing(),
      windowMs: chart.windowMsValue(),
    });
  };
  const legend = h('div', { class: 'chart-legend' });
  for (const def of chart.defsList) {
    const on0 = chart.isVisible(def.id);
    const dot = h('span', { class: 'sw', style: `background:${def.color}` });
    const btn = h('button', { type: 'button', class: 'item' + (on0 ? '' : ' off'), title: t('rec.showHide').replace('{label}', def.label) },
      dot, h('span', {}, def.label)) as HTMLButtonElement;
    on(btn, 'click', () => {
      const next = !chart.isVisible(def.id);
      chart.setVisible(def.id, next);
      btn.classList.toggle('off', !next);
      savePrefs();
    });
    legend.append(btn);
  }
  const prim = h('select', { id: 'chart-primary', title: t('rec.primaryTitle') }) as HTMLSelectElement;
  for (const def of chart.defsList) prim.append(h('option', { value: def.id }, def.label));
  if (chart.defsList.some((d) => d.id === prefs.primary)) prim.value = prefs.primary;
  on(prim, 'change', () => {
    chart.setPrimary(prim.value);
    savePrefs();
  });
  const smoothCb = h('input', { type: 'checkbox', id: 'chart-smooth', title: t('rec.smoothTitle') }) as HTMLInputElement;
  smoothCb.checked = prefs.smooth;
  on(smoothCb, 'change', () => {
    chart.setSmooth(smoothCb.checked);
    savePrefs();
  });
  const followBtn = h('button', { class: 'chip-like', id: 'chart-follow' }, t('rec.follow'));
  const paintFollow = (f: boolean): void => {
    followBtn.textContent = f ? t('rec.followOn') : t('rec.followOff');
    followBtn.classList.toggle('on', f);
  };
  chart.onFollowChange(paintFollow);
  on(followBtn, 'click', () => {
    const next = !chart.isFollowing();
    chart.setFollow(next);
    paintFollow(next);
  });
  paintFollow(chart.isFollowing());
  const bar = h('div', { class: 'chart-bar' },
    h('label', { class: 'ctl' }, h('span', {}, 'Y'), prim),
    legend,
    h('label', { class: 'opt' }, h('span', {}, t('rec.smooth')), smoothCb),
    followBtn);
  q('#rc-chart', root).after(bar); // legend and controls below the curve

  on(q('#rc-win', root) as HTMLSelectElement, 'change', (e) => {
    chart.setWindow(Number((e.target as HTMLSelectElement).value));
  });
  const $pause = q('#rc-pause', root) as HTMLButtonElement;
  on($pause, 'click', () => {
    const p = $pause.textContent === t('rec.pause');
    chart.setPaused(p);
    $pause.textContent = p ? t('rec.resume') : t('rec.pause');
  });
  on(q('#rc-clear', root), 'click', () => {
    void confirmDialog({ title: t('rec.clearchart.title'), body: t('rec.clearchart.body'), okText: t('rec.clearchart.ok') }).then(
      (ok) => ok && chart.clear(),
    );
  });
  on(q('#rc-png', root), 'click', () => chart.exportPng());
  on(q('#rc-csv-live', root), 'click', () => download(`chart-${Date.now()}.csv`, chart.exportCsv()));

  const renderStatus = (): void => {
    const st = sampler.getStatus();
    $start.disabled = st.running;
    $stop.disabled = !st.running;
    $period.disabled = st.running;
    $status.textContent = st.running
      ? `${t('rec.statusRecording')} ${st.sessionId} · ${st.count}${t('rec.pointUnit')}(${t('rec.throttledDropped')} ${st.dropped})`
      : st.count
        ? `${t('rec.statusStopped')} ${st.count}${t('rec.pointUnit')}`
        : t('rec.statusIdle');
  };
  sampler.onStatusChange(renderStatus);

  on($start, 'click', async () => {
    if (!device.isOpen()) {
      await confirmDialog({ title: t('rec.noconn.title'), body: t('rec.noconn.body'), okText: t('rec.noconn.ok') });
      return;
    }
    await sampler.start();
  });
  on($stop, 'click', async () => {
    await sampler.stop();
    await renderSessions();
  });

  let sessionPage = 0;
  const PAGE_SIZE = 5;
  async function renderSessions(): Promise<void> {
    const metas = await listSessions();
    const totalPages = Math.max(1, Math.ceil(metas.length / PAGE_SIZE));
    if (sessionPage >= totalPages) sessionPage = totalPages - 1;
    const pageMetas = metas.slice(sessionPage * PAGE_SIZE, (sessionPage + 1) * PAGE_SIZE);
    $sessions.textContent = '';
    $sessionCount.textContent = `${t('rec.countPrefix')}${metas.length}${t('rec.countSuffix')}`;
    if (!metas.length) {
      $sessions.append(h('div', { class: 'notice' }, t('rec.empty')));
    } else {
      for (const m of pageMetas) $sessions.append(sessionRow(m, () => renderSessions()));
    }
    // pager controls: prev / current page · total · per-page count / jump dropdown / next
    $pager.textContent = '';
    const prev = h('button', { disabled: sessionPage <= 0 }, t('rec.prev')) as HTMLButtonElement;
    const next = h('button', { disabled: sessionPage >= totalPages - 1 }, t('rec.next')) as HTMLButtonElement;
    on(prev, 'click', () => { sessionPage = Math.max(0, sessionPage - 1); renderSessions(); });
    on(next, 'click', () => { sessionPage = Math.min(totalPages - 1, sessionPage + 1); renderSessions(); });
    const jump = h('select', { id: 'rc-page-jump', title: t('rec.jump') }) as HTMLSelectElement;
    for (let i = 0; i < totalPages; i++) jump.append(h('option', { value: String(i + 1) }, `${i + 1}`));
    jump.value = String(sessionPage + 1);
    on(jump, 'change', () => { sessionPage = Number(jump.value) - 1; renderSessions(); });
    const perPage = h('span', { class: 'page-info' }, t('rec.perPage').replace('{n}', String(PAGE_SIZE)));
    const pageInfo = h('span', { class: 'page-info' }, `${t('rec.pageInfo').replace('{p}', String(sessionPage + 1)).replace('{t}', String(totalPages))}`);
    $pager.append(prev, pageInfo, perPage, h('span', { class: 'page-info' }, t('rec.jump')), jump, next);
  }

  function sessionRow(m: SessionMeta, refresh: () => void): HTMLElement {
    const time = new Date(m.createdAt).toLocaleString();
    const dur = m.endedAt && m.endedAt >= m.createdAt ? fmtClockMs(m.endedAt - m.createdAt) : t('rec.runningLive');
    const rate = m.samplePeriodMs ? m.samplePeriodMs + 'ms' : t('rec.fastestShort');
    const sum = h('span', { class: 'notice', style: 'flex:1' },
      `${m.name} · ${time} · ${m.count}${t('rec.pointUnit')} · ${t('rec.smpl')} ${rate} · ${dur}`);
    const exp = h('button', { title: t('rec.exportTitle') }, t('rec.exportCsv'));
    const del = h('button', { class: 'danger' }, t('rec.delete'));
    on(exp, 'click', async () => {
      const rows: (string | number | undefined)[][] = [];
      await loadSessionRows(m.id, (r) =>
        rows.push([new Date(r.ts).toISOString(), r.vin, r.vout, r.iout, r.pout, r.temp, r.ah, r.wh, r.out, r.prot, r.mode]));
      download(`${m.name}.csv`, csvOf(rows));
    });
    on(del, 'click', async () => {
      const ok = await confirmDialog({ title: t('rec.delsess.title'), body: t('rec.delsess.body').replace('{name}', m.name), okText: t('rec.delsess.ok'), danger: true });
      if (!ok) return;
      await deleteSession(m.id);
      refresh();
    });
    return h('div', { class: 'row', style: 'border-bottom:1px solid var(--border-soft);padding:2px 0' }, sum, exp, del);
  }

  renderSessions();
  renderStatus();
  // page-local cleanup on tab detach not needed (singleton page)
  void unsubTelemetry;
  void unsubState;
}

function csvOf(rows: (string | number | undefined)[][]): string {
  const head = ['time', 'vin', 'vout', 'iout', 'pout', 'temp', 'ah', 'wh', 'out', 'prot', 'mode'];
  const esc = (v: string | number | undefined) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '\ufeff' + [head.join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n') + '\r\n';
}
