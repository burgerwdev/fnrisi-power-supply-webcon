// Scripting tab: tiny DPS-150 DSL (see src/scripting/dsl.ts) — editor, syntax check,
// run/stop with pre-confirm, samples, help, save (localStorage) / import / export.
import { t } from '../../i18n';
import type { Dps150Api } from '../../api/facade';
import { DSL_HELP, DSL_SAMPLES, executeDsl, parseDsl, validateDsl } from '../../scripting/dsl';
import { joinChecks } from '../../scripting/validators';
import { uiGate } from '../../app/activity';
import { h, on } from '../../ui/dom';
import { confirmDialog } from '../../ui/confirm';
import { download } from '../../storage/export';
import { deleteScript, listScripts, listOutputs, saveScript, appendOutput, type ScriptMeta, type ScriptOutputRec } from '../../storage/scriptdata';

const DEFAULT_SCRIPT = t('script.default');

export function initScriptTab(root: HTMLElement, getApi: () => Dps150Api | null): void {
  root.textContent = '';
  root.append(h('h2', {}, t('page.script')));
  const output = h('div', { class: 'log', style: 'height:110px;margin-top:6px;resize:vertical;overflow:auto' }, t('script.output'));
  const dataOut = h('div', { class: 'log dsldata', style: 'height:120px;margin-top:6px;resize:vertical;overflow:auto' }, t('script.dataOutput'));
  const exportData = h('button', { id: 'dsl-exportdata', disabled: true }, t('script.exportData'));
  const clearData = h('button', { id: 'dsl-cleardata' }, t('script.clearData'));
  const histBtn = h('button', { id: 'dsl-hist' }, t('script.history'));
  const ta = h('textarea', {
    spellcheck: 'false',
    style: 'width:100%;height:250px;resize:vertical;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;background:var(--input-bg);color:var(--text);border:1px solid var(--input-border);border-radius:4px;padding:8px;line-height:1.5',
  }) as HTMLTextAreaElement;
  ta.value = DEFAULT_SCRIPT;

  const runBtn = h('button', { class: 'primary', id: 'dsl-run' }, t('script.run'));
  const stopBtn = h('button', { id: 'dsl-stop', disabled: true }, t('script.stop'));
  const chkBtn = h('button', { id: 'dsl-check' }, t('script.check'));
  const saveBtn = h('button', { id: 'dsl-save' }, t('script.save'));
  const expBtn = h('button', { id: 'dsl-export' }, t('script.export'));
  const impBtn = h('button', { id: 'dsl-import' }, t('script.import'));
  const sampleSel = h('select', { title: t('script.loadSample') }, h('option', { value: '' }, t('script.sampleOption')));
  for (const s of DSL_SAMPLES) sampleSel.append(h('option', { value: s.name }, s.name));
  const listEl = h('div', { style: 'margin-top:6px' });
  // Help: the right toggle button opens a draggable/resizable/closable floating layer (similar to Debug)
  const helpBtn = h('button', { id: 'dsl-help', class: 'chip-like' }, t('script.helpBtn'));
  const helpWin = h('div', { class: 'dsl-help floating', hidden: '' },
    h('div', { class: 'dsl-help-head' },
      h('span', { class: 'dsl-help-title' }, t('script.helpTitle')),
      h('button', { id: 'dsl-help-close', class: 'danger', title: t('log.close') }, '×')),
    h('pre', { class: 'dsl-help-body' }, DSL_HELP));
  document.body.append(helpWin);
  let helpOn = false;
  const setHelp = (on: boolean): void => {
    helpOn = on;
    helpWin.classList.toggle('open', on);
    helpWin.hidden = !on;
  };
  on(helpBtn, 'click', () => setHelp(!helpOn));
  on(helpWin.querySelector('#dsl-help-close') as HTMLButtonElement, 'click', () => setHelp(false));
  const hd = helpWin.querySelector('.dsl-help-head') as HTMLElement;
  const hDrag = { on: false, dx: 0, dy: 0 };
  hd.addEventListener('pointerdown', (e: PointerEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault();
    hDrag.on = true;
    const r = helpWin.getBoundingClientRect();
    hDrag.dx = e.clientX - r.left;
    hDrag.dy = e.clientY - r.top;
    const mv = (ev: PointerEvent): void => {
      if (!hDrag.on) return;
      const l = Math.min(Math.max(4, ev.clientX - hDrag.dx), window.innerWidth - 160);
      const tp = Math.min(Math.max(4, ev.clientY - hDrag.dy), window.innerHeight - 60);
      helpWin.style.left = `${l}px`;
      helpWin.style.top = `${tp}px`;
    };
    const up = (): void => {
      hDrag.on = false;
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  });

  root.append(
    h('div', { class: 'row' }, sampleSel, runBtn, stopBtn, chkBtn, saveBtn, expBtn, impBtn, h('span', { class: 'spacer' }), helpBtn),
    ta,
    output,
    h('div', { class: 'row' }, exportData, clearData, histBtn, h('span', { class: 'dsldata-label' }, t('script.dataOutputTitle'))),
    dataOut,
    h('div', { style: 'margin-top:8px' }, h('span', { style: 'font-size:13px;color:var(--label)' }, t('script.saved')), listEl),
  );

  let dataLines: string[] = [];
  let currentScriptId: string | null = null;
  let currentScriptName: string | null = null;
  let runId = '';
  function log(msg: string): void {
    const line = h('div', {}, `[${new Date().toLocaleTimeString()}] ${msg}`);
    output.append(line);
    output.scrollTop = output.scrollHeight;
  }
  function data(msg: string): void {
    if (!dataLines.length) dataOut.textContent = '';
    dataLines.push(msg);
    const line = h('div', {}, msg);
    dataOut.append(line);
    dataOut.scrollTop = dataOut.scrollHeight;
    exportData.disabled = false;
  }

  on(sampleSel, 'change', () => {
    const s = DSL_SAMPLES.find((x) => x.name === sampleSel.value);
    if (s) ta.value = s.code;
  });

  on(chkBtn, 'click', () => {
    const { lines, errors } = parseDsl(ta.value);
    if (errors.length) log(`${t('script.syntaxErr').replace('{n}', String(errors.length))}\n` + errors.map((e) => `  ${e.line}: ${e.msg}`).join('\n'));
    else log(t('script.syntaxOk').replace('{n}', String(lines.length)));
  });

  let stopped = false;
  let activeTok: number | null = null;
  on(runBtn, 'click', async () => {
    if (activeTok !== null) return;
    const api = getApi();
    if (!api) {
      log(t('script.apiNotReady'));
      return;
    }
    const { lines, errors } = parseDsl(ta.value);
    if (errors.length) {
      log(`${t('script.syntaxErr').replace('{n}', String(errors.length))}:\n` + errors.map((e) => `  ${e.line}: ${e.msg}`).join('\n'));
      return;
    }
    if (!lines.length) {
      log(t('script.emptyScript'));
      return;
    }
    // Pre-run value validation: an error shows a friendly prompt directly (no run confirm dialog)
    const st = api.state;
    const { errors: vErr, warnings } = validateDsl(lines, {
      connected: api.connected,
      maxVoltage: st.limits.maxVoltage,
      maxCurrent: st.limits.maxCurrent,
    });
    if (vErr.length) {
      const text = joinChecks(vErr);
      log(`${t('log.verifyPrefix')}:\n` + vErr.map((c) => '  ' + c.msg).join('\n'));
      await confirmDialog({ title: t('script.invalidInput'), body: text, okText: t('script.know'), danger: true });
      return;
    }
    const hasOutOn = (() => {
      const scan = (nodes: typeof lines): boolean =>
        nodes.some((l) => {
          const k = l.op.kind;
          if (k === 'out' && (l.op as { on: boolean }).on) return true;
          if (k === 'if') return scan((l.op as { then: typeof lines; else?: typeof lines }).then) || ((l.op as { else?: typeof lines }).else ? scan((l.op as { else: typeof lines }).else!) : false);
          if (k === 'for' || k === 'while') return scan((l.op as { body: typeof lines }).body);
          return false;
        });
      return scan(lines);
    })();
    const warnText = warnings.length ? t('script.run.warn') + '\n' + warnings.map((w) => `  ${w.msg}`).join('\n') : '';
    const ok = await confirmDialog({
      title: t('script.run.title'),
      body: t('script.run.body').replace('{n}', String(lines.length)) + (hasOutOn ? t('script.run.outOn') : '') + warnText,
      detail: lines.slice(0, 10).map((l) => `L${l.line} ${l.raw.trim()}`).join('\n') + (lines.length > 10 ? '\n…' : ''),
      okText: t('script.run.ok'),
      danger: hasOutOn,
    });
    if (!ok) return;
    const tok = uiGate.beginAuto(t('task.script'), () => { stopped = true; });
    if (tok === null) {
      log(t('script.otherTask').replace('{label}', uiGate.current().label ?? ''));
      return;
    }
    activeTok = tok;
    stopped = false;
    runBtn.disabled = true;
    stopBtn.disabled = false;
    runId = `run${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    log(t('script.run.start').replace('{n}', String(lines.length)));
    const r = await executeDsl(lines, api, log, () => stopped, data);
    // persist this run's data-output records, tied to the owning script (if any)
    if (currentScriptId && dataLines.length) {
      const sid = currentScriptId;
      const records: ScriptOutputRec[] = dataLines.map((ln, i) => ({
        id: `${runId}:${i}`,
        scriptId: sid,
        ts: Date.now() + i,
        kind: 'data',
        text: ln,
      }));
      Promise.all(records.map((rec) => appendOutput(rec))).catch(() => undefined);
    }
    if (activeTok !== null) {
      uiGate.endAuto(activeTok);
      activeTok = null;
    }
    runBtn.disabled = false;
    stopBtn.disabled = true;
    log(r.ok ? t('script.run.done') : t('script.run.interrupted').replace('{e}', r.error ?? ''));
    if (currentScriptId && dataLines.length) log(`${t('script.savedOutput').replace('{n}', String(dataLines.length))}`);
  });

  on(stopBtn, 'click', () => {
    uiGate.requestStop();
    log(t('script.stopReq'));
  });

  on(saveBtn, 'click', async () => {
    if (currentScriptId) {
      const ok = await confirmDialog({ title: t('script.save.title'), body: t('script.save.body').replace('{n}', currentScriptName ?? ''), okText: t('script.save.overwrite') });
      if (ok) {
        await saveScript({ id: currentScriptId, name: currentScriptName ?? t('script.unnamed'), code: ta.value, updatedAt: Date.now() });
        await renderList();
        log(t('script.savedDone').replace('{n}', currentScriptName ?? ''));
        return;
      }
    }
    const nm = prompt(t('script.namePrompt'))?.trim();
    if (!nm) return;
    currentScriptId = `sc${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    currentScriptName = nm;
    await saveScript({ id: currentScriptId, name: nm, code: ta.value, updatedAt: Date.now() });
    await renderList();
    log(t('script.savedDone').replace('{n}', nm));
  });
  on(expBtn, 'click', () => download(`dps150-script-${Date.now()}.txt`, ta.value, 'text/plain'));
  on(exportData, 'click', () => {
    if (!dataLines.length) return;
    const csv = '\ufeff' + dataLines.map((l) => l).join('\r\n');
    download(`dps150-data-${Date.now()}.csv`, csv);
  });
  on(clearData, 'click', () => {
    dataLines = [];
    dataOut.textContent = '';
    exportData.disabled = true;
  });
  on(histBtn, 'click', async () => {
    if (!currentScriptId) {
      log(t('script.histNone'));
      return;
    }
    const outs = await listOutputs(currentScriptId);
    if (!outs.length) {
      log(t('script.histNone'));
      return;
    }
    const rows = outs.filter((o) => o.kind === 'data');
    const csv = '\ufeff' + rows.map((o) => o.text).join('\r\n');
    download(`dps150-script-${currentScriptName ?? 'out'}-history.csv`, csv);
    log(`${t('script.histExported').replace('{n}', String(rows.length))}`);
  });
  on(impBtn, 'click', () => {
    const input = h('input', { type: 'file', accept: '.txt,.dps', hidden: true }) as HTMLInputElement;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (f) ta.value = await f.text();
    };
    input.click();
  });

  async function renderList(): Promise<void> {
    listEl.textContent = '';
    let scripts: ScriptMeta[] = [];
    try {
      scripts = await listScripts();
    } catch {
      /* ignore */
    }
    if (!scripts.length) {
      listEl.append(h('div', { class: 'notice' }, t('script.empty')));
      return;
    }
    for (const sc of scripts) {
      const open = h('button', { style: 'margin-right:6px' }, sc.name);
      const del = h('button', { class: 'danger' }, t('script.delBtn'));
      on(open, 'click', () => {
        ta.value = sc.code;
        currentScriptId = sc.id;
        currentScriptName = sc.name;
        log(t('script.loaded').replace('{n}', sc.name));
      });
      on(del, 'click', async () => {
        const ok = await confirmDialog({ title: t('script.del.title'), body: t('script.del.body').replace('{n}', sc.name), okText: t('script.del.ok'), danger: true });
        if (!ok) return;
        await deleteScript(sc.id);
        if (currentScriptId === sc.id) {
          currentScriptId = null;
          currentScriptName = null;
        }
        await renderList();
      });
      listEl.append(h('div', { style: 'padding:2px 0;border-bottom:1px solid var(--border-soft)' }, open, del));
    }
  }
  void renderList();
}
