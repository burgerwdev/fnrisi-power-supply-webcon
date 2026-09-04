// Sequence tab UI: edit rows (V,A,delayMs), choose mode/range/loops, run with
// pre-confirm, pause/step-less stop; device problem handled per settings strategy.
import type { DeviceController } from '../../device/controller';
import { t } from '../../i18n';
import type { AppSettings } from '../../storage/settings';
import { SequenceRunner, type SeqRow } from '../../sequence/executor';
import { uiGate } from '../../app/activity';
import {
  checkCurrent,
  checkDelayMs,
  checkVoltage,
  joinChecks,
  type Check,
  type LimitCtx,
} from '../../scripting/validators';
import { h, on } from '../../ui/dom';
import { confirmDialog } from '../../ui/confirm';

const EXAMPLE = `${t('seq.example')}\n1.0, 0.05, 2000\n2.0, 0.05, 2000\n3.0, 0.05, 2000\n1.0, 0.05, 1000`;

export function initSequenceTab(root: HTMLElement, device: DeviceController, getSettings: () => AppSettings): void {
  root.textContent = '';
  root.append(h('h2', {}, t('page.sequence')));
  const ta = h('textarea', {
    spellcheck: 'false',
    wrap: 'off',
    style: 'width:100%;height:200px;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:18px;background:var(--input-bg);color:var(--text);border:1px solid var(--input-border);border-radius:4px;padding:8px',
  }) as HTMLTextAreaElement;
  ta.value = EXAMPLE;
  // Highlight the currently executing line while running: overlay a translucent bar on the matching textarea row (tied to line-height/padding)
  const activeBar = h('div', { class: 'seq-activebar' }) as HTMLElement;
  const taWrap = h('div', { class: 'seq-editor' }, ta, activeBar);
  let activeLine = -1; // 0-based global line number; -1 = hidden
  const seqMetrics = (): { lh: number; pad: number } => {
    const cs = getComputedStyle(ta);
    return { lh: parseFloat(cs.lineHeight) || 18, pad: parseFloat(cs.paddingTop) || 8 };
  };
  const placeBar = (): void => {
    if (activeLine < 0) {
      activeBar.style.display = 'none';
      return;
    }
    const { lh, pad } = seqMetrics();
    const y = pad + activeLine * lh - ta.scrollTop;
    activeBar.style.display = 'block';
    activeBar.style.top = `${Math.max(-lh, y)}px`;
  };
  const ensureVisible = (): void => {
    if (activeLine < 0) return;
    const { lh, pad } = seqMetrics();
    const target = pad + activeLine * lh;
    const top = ta.scrollTop;
    if (target < top + pad) ta.scrollTop = Math.max(0, target - pad);
    else if (target > top + ta.clientHeight - pad - lh) ta.scrollTop = target - (ta.clientHeight - pad - lh);
    placeBar();
  };
  on(ta, 'input', () => {
    activeLine = -1;
    placeBar();
  });
  on(ta, 'scroll', placeBar);
  const modeSel = h('select', {},
    h('option', { value: 'manual' }, t('seq.modeManual')),
    h('option', { value: 'auto', selected: true }, t('seq.modeAuto')));
  const startIn = h('input', { type: 'number', min: '1', value: '1', style: 'width:70px', title: t('seq.startRow') }) as HTMLInputElement;
  const stopIn = h('input', { type: 'number', min: '1', value: '1', style: 'width:70px', title: t('seq.stopRow') }) as HTMLInputElement;
  const loopsIn = h('input', { type: 'number', min: '0', value: '1', style: 'width:70px', title: t('seq.loopsTitle') }) as HTMLInputElement;
  const status = h('div', { class: 'notice', id: 'sq-status' }, t('seq.idle'));
  const run = h('button', { class: 'primary', id: 'sq-run' }, t('seq.run'));
  const stop = h('button', { id: 'sq-stop', disabled: true }, t('seq.stop'));
  const pause = h('button', { id: 'sq-pause', disabled: true }, t('seq.pause'));

  function parseRows(ctx: LimitCtx): { rows: SeqRow[]; errors: Check[] } {
    const rows: SeqRow[] = [];
    const errors: Check[] = [];
    const rawLines = ta.value.split(/\r?\n/);
    rawLines.forEach((raw, idx) => {
      const lineNo = idx + 1;
      const ln = raw.replace(/#.*$/, '').trim();
      if (!ln) return;
      const parts = ln.split(',').map((x) => x.trim());
      if (parts.length < 3) {
        errors.push({ level: 'error', msg: t('seq.rowFormat').replace('{n}', String(lineNo)).replace('{raw}', raw.trim()) });
        return;
      }
      const v = Number(parts[0]);
      const a = Number(parts[1]);
      const d = Number(parts[2]);
      if (![v, a, d].every(Number.isFinite)) {
        errors.push({ level: 'error', msg: t('seq.rowNonNumber').replace('{n}', String(lineNo)).replace('{raw}', raw.trim()) });
        return;
      }
      const cs = [
        ...checkVoltage(v, ctx).map((c) => ({ ...c, msg: `${t('log.linePrefix').replace('{n}', String(lineNo))}: ${c.msg}` })),
        ...checkCurrent(a, ctx).map((c) => ({ ...c, msg: `${t('log.linePrefix').replace('{n}', String(lineNo))}: ${c.msg}` })),
        ...checkDelayMs(d).map((c) => ({ ...c, msg: `${t('log.linePrefix').replace('{n}', String(lineNo))}: ${c.msg}` })),
      ];
      const hardErr = cs.find((c) => c.level === 'error');
      if (hardErr) {
        errors.push(...cs.filter((c) => c.level === 'error'));
        return;
      }
      rows.push({ voltage: v, current: a, delayMs: d });
      // collect (non-fatal) warnings
      errors.push(...cs.filter((c) => c.level === 'warn'));
    });
    return { rows, errors };
  }

  function friendlyBlock(title: string, checks: Check[]): void {
    void confirmDialog({ title, body: joinChecks(checks), okText: t('seq.know'), danger: true });
  }
  let runner: SequenceRunner | null = null;
  let activeTok: number | null = null;

  async function refreshRowCount(): Promise<void> {
    const st = device.getState();
    const { rows } = parseRows({ connected: device.isOpen(), maxVoltage: st.limits.maxVoltage, maxCurrent: st.limits.maxCurrent });
    stopIn.value = String(Math.max(1, rows.length));
  }
  on(ta, 'input', () => void refreshRowCount());

  function isDeviceOk(): boolean {
    const s = device.getState();
    return s.connected && (s.status.protection === 'OK' || s.status.protection === 'UNKNOWN');
  }

  function strategy(): AppSettings['autoRunInterrupt'] {
    return getSettings().autoRunInterrupt;
  }

  on(run, 'click', async () => {
    if (runner || activeTok !== null) return;
    const tok = uiGate.beginAuto(t('task.seq'), () => runner?.requestStop());
    if (tok === null) {
      friendlyBlock(t('seq.busy.title'), [{ level: 'error', msg: t('seq.busy.body').replace('{label}', uiGate.current().label ?? '') }]);
      return;
    }
    activeTok = tok;
    const st = device.getState();
    const ctx: LimitCtx = { connected: device.isOpen(), maxVoltage: st.limits.maxVoltage, maxCurrent: st.limits.maxCurrent };
    const { rows, errors } = parseRows(ctx);
    const warns = errors.filter((c) => c.level === 'warn');
    const hardErr = errors.filter((c) => c.level === 'error');
    if (!ctx.connected) {
      friendlyBlock(t('seq.noconn.title'), [{ level: 'error', msg: t('seq.noconn.body') }]);
      return;
    }
    if (hardErr.length) {
      friendlyBlock(t('seq.invalid.title'), hardErr);
      return;
    }
    if (!rows.length) {
      await confirmDialog({ title: t('seq.empty.title'), body: t('seq.empty.body'), okText: t('seq.ok') });
      return;
    }
    const startIndex = Math.min(Math.max(1, Number(startIn.value) || 1), rows.length);
    const stopIndex = Math.min(Math.max(startIndex, Number(stopIn.value) || rows.length), rows.length);
    const loops = Math.max(0, Number(loopsIn.value) || 0);
    const mode = modeSel.value as 'auto' | 'manual';
    if (Number(stopIn.value) && Number(stopIn.value) < Number(startIn.value)) {
      friendlyBlock(t('seq.range.title'), [{ level: 'error', msg: t('seq.range.body') }]);
      return;
    }
    const preview = rows.slice(startIndex - 1, stopIndex).map((r) => `${r.voltage.toFixed(1)}V/${r.current.toFixed(3)}A`).join(' → ');
    const ok = await confirmDialog({
      title: `${t('seq.run.title')}(${stopIndex - startIndex + 1} ${t('seq.rowUnit')}${mode === 'auto' ? ` × ${loops || '∞'} ${t('seq.loopUnit')}` : ''})`,
      body: t('seq.run.body'),
      detail: (warns.length ? warns.map((w) => '⚠ ' + w.msg).join('\n') + '\n\n' : '') + preview,
      okText: t('seq.startRun'),
      danger: true,
    });
    if (!ok) return;
    await device.setOutput(true).catch(() => undefined);
    runner = new SequenceRunner(rows, { mode, startIndex, stopIndex, loops }, {
      apply: async (r) => {
        await device.setVoltage(r.voltage);
        await device.setCurrent(r.current);
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      isDeviceOk,
      getStrategy: strategy,
      onProblem: async (msg) => {
        const cont = await confirmDialog({ title: t('seq.devissue.title'), body: msg, okText: t('seq.continue'), danger: true, detail: t('seq.devissue.detail') });
        return cont;
      },
      onProgress: (p) => {
        activeLine = p.running ? startIndex - 1 + p.step : -1; // 0-based global line number
        ensureVisible();
        status.textContent = p.running
          ? p.paused
            ? `${t('seq.paused')} · ${t('seq.loopUnit')} ${p.loop} · ${t('seq.rowUnit')} ${p.step}`
            : `${t('seq.running')} · ${t('seq.loopUnit')} ${p.loop} · ${t('seq.rowUnit')} ${p.step}/${stopIndex - startIndex + 1}`
          : t('seq.idle');
      },
      onFinished: async (reason) => {
        activeLine = -1;
        placeBar();
        if (activeTok !== null) {
          uiGate.endAuto(activeTok);
          activeTok = null;
        }
        runner = null;
        run.disabled = false;
        stop.disabled = true;
        pause.disabled = true;
        pause.textContent = t('seq.pause');
        await device.setOutput(false).catch(() => undefined);
        const why = reason === 'completed' ? t('seq.completeAll') : reason === 'problem' ? t('seq.problemInterrupt') : t('seq.stopped');
        status.textContent = `${t('seq.finish')}:${why}(${t('seq.closed')})`;
        if (reason === 'problem') {
          await confirmDialog({ title: t('seq.interrupt.title'), body: t('seq.interrupt.body'), okText: t('seq.know'), danger: true });
        }
      },
    });
    run.disabled = true;
    stop.disabled = false;
    pause.disabled = false;
    void runner.run();
  });

  on(stop, 'click', () => uiGate.requestStop());
  on(pause, 'click', () => {
    runner?.togglePause();
    pause.textContent = pause.textContent === t('seq.pause') ? t('seq.resume') : t('seq.pause');
  });

  root.append(
    h('div', { class: 'notice' }, t('seq.notice')),
    h('div', { class: 'sc-fields' },
      h('div', { class: 'sc-field' }, h('label', { class: 'sc-lbl' }, t('seq.mode')), modeSel),
      h('div', { class: 'sc-field' }, h('label', { class: 'sc-lbl', title: t('seq.startRow') }, t('seq.startRow')), startIn),
      h('div', { class: 'sc-field' }, h('label', { class: 'sc-lbl', title: t('seq.stopRow') }, t('seq.stopRow')), stopIn),
      h('div', { class: 'sc-field' }, h('label', { class: 'sc-lbl', title: t('seq.loopsTitle') }, t('seq.loops')), loopsIn),
    ),
    h('div', { class: 'row' }, run, pause, stop, status),
    taWrap,
    h('div', { class: 'notice' }, t('seq.tip')),
  );
  void refreshRowCount();
}
