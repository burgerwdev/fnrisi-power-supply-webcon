// App entry: wires theme, connection, dashboard, output controls and log.
import './style.css';
import { createApi } from './api/facade';
import { DeviceController } from './device/controller';
import { initRecordTab } from './ui/tabs/record';
import { initPresetTab, initProtectTab } from './ui/tabs/presetProtect';
import { initSequenceTab } from './ui/tabs/sequence';
import { initScanTab } from './ui/tabs/scan';
import { initScriptTab } from './ui/tabs/script';
import { initSettingsTab } from './ui/tabs/settings';
import { WebSocketTransport } from './serial/proxy';
import { WebSerialTransport, webSerialSupported } from './serial/transport';
import { loadSettings, loadTransportPrefs, saveSettings, saveTransportPrefs, type AppSettings } from './storage/settings';
import { applyStatic, currentLang, setLang, t } from './i18n';
import { fmtCurrSplit, fmtEnergy, fmtField, fmtVolt2 } from './ui/format';
import { describeFrame } from './protocol/describe';
import { FloatingKeypad } from './ui/keypad';
import { uiGate } from './app/activity';
import { checkCurrent, checkVoltage } from './scripting/validators';
import { confirmDialog } from './ui/confirm';
import { $, h, on } from './ui/dom';

let settings: AppSettings = loadSettings();
document.documentElement.setAttribute('data-theme', settings.theme);
document.documentElement.lang = currentLang();

const device = new DeviceController(settings.baud);
const state = device.getState();

// Full-capability automation API for console / scripts (see docs/API.md)
window.dps150 = createApi(device);

// ---------- elements ----------
const $btnConnect = $('#btn-connect') as HTMLButtonElement;
const $btnDisconnect = $('#btn-disconnect') as HTMLButtonElement;
const $btnLock = $('#btn-lock') as HTMLButtonElement;
let panelLocked = true; // session enabled after connecting (= panel locked) by default
const $btnOut = $('#btn-out') as HTMLButtonElement;
const $btnSet = $('#btn-set') as HTMLButtonElement;
const $selBaud = $('#sel-baud') as HTMLSelectElement;
const $selTransport = $('#sel-transport') as HTMLSelectElement;
const $inProxy = $('#in-proxy') as HTMLInputElement;
const $inV = $('#in-v') as HTMLInputElement;
const $inA = $('#in-a') as HTMLInputElement;
const $meters = $('#meters');
const $ft = { model: $('#ft-model'), hw: $('#ft-hw'), fw: $('#ft-fw'), ver: $('#ft-ver') };
const $dashStatus = $('#dash-status') as HTMLElement;

// ===== protocol log floating window (hidden by default; opened by Debug button, draggable/resizable/closable) =====
function buildLogWindow(): { win: HTMLElement; log: HTMLElement } {
  const win = h('div', { class: 'dbg-log floating', hidden: '' },
    h('div', { class: 'dbg-head' },
      h('span', { class: 'dbg-title', 'data-i18n': 'log.title' }, '协议日志 (RX/TX)'),
      h('button', { id: 'dbg-close', class: 'danger', title: t('log.close') }, '×')),
    h('div', { class: 'dbg-controls' },
      h('label', {}, h('input', { type: 'checkbox', id: 'chk-logrx', checked: '' }), ' RX'),
      h('label', {}, h('input', { type: 'checkbox', id: 'chk-logtx', checked: '' }), ' TX'),
      h('label', {}, h('input', { type: 'checkbox', id: 'chk-logscroll', checked: '' }), t('log.auto')),
      h('span', { class: 'spacer' }),
      h('button', { id: 'btn-logclear', 'data-i18n': 'log.clear' }, '清空')),
    h('div', { class: 'log', id: 'log' }),
  );
  document.body.append(win);
  return { win: win as HTMLElement, log: win.querySelector('#log') as HTMLElement };
}
const { win: dbgWin, log: $log } = buildLogWindow();
const $chkRx = dbgWin.querySelector('#chk-logrx') as HTMLInputElement;
const $chkTx = dbgWin.querySelector('#chk-logtx') as HTMLInputElement;
const $chkScroll = dbgWin.querySelector('#chk-logscroll') as HTMLInputElement;

const transportPrefs = loadTransportPrefs();
$selTransport.value = transportPrefs.mode;
$inProxy.value = transportPrefs.wsUrl;
$inProxy.hidden = transportPrefs.mode !== 'ws';

// ---------- meters (rows by importance: actual output / setpoint / aux) ----------
const meterEls: Record<string, { val: HTMLElement; unit?: HTMLElement }> = {};

function buildMeters(): void {
  $meters.textContent = '';
  const box = (label: string, key: string, unit: string, init: string, cls: string): HTMLElement => {
    const val = h('span', { class: 'mv' }, init);
    const uel = h('span', { class: 'u' }, unit);
    meterEls[key] = { val, unit: uel };
    const vb = h('div', { class: 'valuebox' }, val, uel);
    return h('div', { class: cls }, h('div', { class: 'mk' }, label), vb);
  };

  const sec = (title: string, row: HTMLElement, cls = ''): HTMLElement =>
    h('div', { class: `meter-sec ${cls}` }, h('div', { class: 'msec-title' }, title), row);

  $meters.append(
    sec(t('m.sec.actual'), h('div', { class: 'meter-row actual' },
      box(t('m.vout'), 'vout', 'V', '--.--', 'meter big volt'),
      box(t('m.iout'), 'iout', '', '--', 'meter big amp'),
      box(t('m.pout'), 'pout', 'W', '--', 'meter big watt'),
    ), 'actual-bg'),
  );
  // Set values moved up (consistent with the right-side input); not duplicated here to avoid redundant placeholders.
  const limNote = h('div', { class: 'limit-note', id: 'limit-note' }, '');
  $meters.append(limNote);
  $meters.append(
    sec(t('m.sec.aux'), h('div', { class: 'meter-row aux' },
      box(t('m.temp'), 'temp', '°C', '--', 'meter smallv'),
      box(t('m.ah'), 'ah', 'Ah', '--', 'meter smallv'),
      box(t('m.wh'), 'wh', 'Wh', '--', 'meter smallv'),
    )),
  );
}

function fmt(v: number | undefined, digits = 3): string {
  return v === undefined || !Number.isFinite(v) ? '--' : v.toFixed(digits);
}

// Input box read-back: format to a sensible precision and strip trailing zeros (avoid long tails like "1.2345678").
function fmtSetVal(v: number | undefined, isVolt: boolean): string {
  if (v === undefined || !Number.isFinite(v)) return '';
  return String(Number(v.toFixed(isVolt ? 2 : 3)));
}

function refreshMeters(): void {
  const st = device.getState();
  const tel = st.telemetry;
  const set = st.settings;
  meterEls.vout.val.textContent = fmtVolt2(tel.outputVoltage);
  const [iText, iUnit] = fmtCurrSplit(tel.outputCurrent);
  meterEls.iout.val.textContent = iText;
  if (meterEls.iout.unit) meterEls.iout.unit.textContent = iUnit;
  meterEls.pout.val.textContent = fmtField(tel.outputPower, 'pout');
  const setVEl = document.getElementById('set-v');
  const setAEl = document.getElementById('set-a');
  if (setVEl) setVEl.textContent = `${fmtVolt2(set.voltageSet)} V`;
  if (setAEl) setAEl.textContent = `${fmtField(set.currentSet, 'seta')} A`;
  meterEls.temp.val.textContent = fmtField(tel.temperature, 'temp');
  meterEls.ah.val.textContent = fmtEnergy(tel.capacityAh);
  meterEls.wh.val.textContent = fmtEnergy(tel.energyWh);
  const lim = st.limits;
  const note = document.getElementById('limit-note');
  if (note) {
    const per = st.telemetryPeriodMs ? t('limit.note.push').replace('{ms}', String(st.telemetryPeriodMs)) : '';
    note.textContent =
      (lim.maxVoltage !== undefined || lim.maxCurrent !== undefined
        ? t('limit.note.upper').replace('{v}', fmt(lim.maxVoltage, 2)).replace('{a}', fmt(lim.maxCurrent, 3)) + ' '
        : '') + per;
  }
  // Input voltage: the status lamp carries lamp-vin (same row as lamp-out, same style)
  const vinLamp = document.getElementById('lamp-vin');
  if (vinLamp) vinLamp.textContent = t('log.inputVin').replace('{v}', fmtVolt2(tel.inputVoltage));
  // Input voltage (deco strip)
  const vinEl = document.getElementById('deco-vin-val');
  if (vinEl) vinEl.textContent = tel.inputVoltage !== undefined ? fmtField(tel.inputVoltage, 'vin') + ' V' : '-- V';
}

function refreshStatusbar(): void {
  const st = device.getState();
  // Version comes from build injection (__APP_VERSION__), VER prefix + author link.
  $ft.ver.innerHTML = `VER ${__APP_VERSION__} <span class="ft-by">by <a class="version-tag-link" href="https://space.bilibili.com/28447213" target="_blank" rel="noopener" title="${t('foot.author')}">${t('foot.author')}</a></span>`;
  // Device model in the top-bar brand: shows "Power Supply" when disconnected, the actual model when connected.
  const modelEl = document.getElementById('brand-model');
  if (modelEl) modelEl.textContent = st.connected && st.info.modelName ? st.info.modelName : t('brand.model');
  if (st.connected) {
    $ft.model.textContent = `${t('foot.model')}: ${st.info.modelName ?? '--'}`;
    $ft.hw.textContent = `HW ${st.info.hwVersion ?? '--'}`;
    $ft.fw.textContent = `FW ${st.info.fwVersion ?? '--'}`;
  } else {
    $ft.model.textContent = t('foot.modelHint');
    $ft.hw.textContent = 'HW --';
    $ft.fw.textContent = 'FW --';
  }
}

const PROT_HINT: Record<string, string> = {
  OK: t('prot.hint.OK'),
  OVP: t('prot.hint.OVP'),
  OCP: t('prot.hint.OCP'),
  OPP: t('prot.hint.OPP'),
  OTP: t('prot.hint.OTP'),
  LVP: t('prot.hint.LVP'),
  REP: t('prot.hint.REP'),
  UNKNOWN: t('prot.hint.UNKNOWN'),
};
const MODE_HINT: Record<string, string> = {
  CC: t('mode.hint.CC'),
  CV: t('mode.hint.CV'),
};

function refreshLamps(): void {
  const st = device.getState();
  const connected = st.connected;
  const alarm = connected && st.status.protection !== 'OK' && st.status.protection !== 'UNKNOWN';
  // Mode "trigger" check: output on and strictly **greater than** the limit — CV voltage > set voltage, CC current > current limit (exclusive).
  const over = (a: number | undefined, b: number | undefined): boolean => !!a && !!b && a > b;
  // Mode lamp trigger (red breathing): always based on the mode reported by the device —
  //   · CC: triggers when device reports CC (current at limit);
  //   · CV: static orange, turns to red blinking only when measured output voltage > set voltage.
  const modeAtLimit =
    connected &&
    st.status.output === 'RUN' &&
    (st.status.mode === 'CC' ? true : st.status.mode === 'CV' && over(st.telemetry.outputVoltage, st.settings.voltageSet));
  const tiles: { el: string; text: string; tip: string; cls: string }[] = [
    { el: 'lamp-link', text: connected ? t('lamp.connected') : t('lamp.notconn'), tip: connected ? t('lamp.linkok.tip') : t('lamp.notconn.tip'), cls: connected ? 'ok' : 'off' },
    { el: 'lamp-out', text: connected ? `${t('lamp.out')} ${st.status.output}` : t('lamp.outdash'), tip: !connected ? t('lamp.notconn.tip') : st.status.output === 'RUN' ? t('lamp.outrun.tip') : t('lamp.outstop.tip'), cls: connected && st.status.output === 'RUN' ? 'run' : 'off' },
    { el: 'lamp-mode', text: connected ? `${t('lamp.mode')} ${st.status.mode}` : t('lamp.modedash'), tip: !connected ? t('lamp.notconn.tip') : MODE_HINT[st.status.mode] ?? '', cls: !connected ? 'off' : alarm ? 'alarm-off' : `${st.status.mode === 'CC' ? 'cc' : 'cv'}${modeAtLimit ? ' active' : ''}` },
    { el: 'lamp-prot', text: !connected ? t('lamp.protdash') : alarm ? `${t('lamp.prot')} ${st.status.protection}` : t('lamp.protOK'), tip: !connected ? t('lamp.notconn.tip') : PROT_HINT[st.status.protection] ?? '', cls: !connected ? 'off' : alarm ? 'err alarm' : 'ok' },
  ];
  for (const t of tiles) {
    const el = document.getElementById(t.el);
    if (el) {
      el.className = `lamp ${t.cls}`;
      el.textContent = t.text;
      el.title = t.tip;
    }
  }
  $dashStatus.classList.toggle('alarm', alarm);
  const note = document.getElementById('out-note');
  if (note) {
    if (!connected) {
      note.textContent = t('outnote.dash');
      note.className = '';
    } else if (alarm) {
      note.textContent = t('outnote.alarm').replace('{o}', st.status.output).replace('{m}', st.status.mode).replace('{h}', PROT_HINT[st.status.protection] ?? st.status.protection);
      note.className = 'err-text';
    } else {
      note.textContent = t('outnote.normal').replace('{o}', st.status.output).replace('{m}', st.status.mode).replace('{h}', MODE_HINT[st.status.mode] ?? '');
      note.className = '';
    }
  }
}

function buildLamps(): void {
  $dashStatus.textContent = '';
  const mk = (id: string, cls = 'off'): HTMLElement => {
    const t = h('div', { id, class: `lamp ${cls}` }, '');
    const w = h('div', { class: 'lamp-cell' }, t);
    return w;
  };
  $dashStatus.append(mk('lamp-link'), mk('lamp-vin', 'vin'), mk('lamp-out'), mk('lamp-mode'), mk('lamp-prot'));
  refreshLamps();
}

// ---------- log ----------
function appendLog(level: string, text: string, frame?: Uint8Array): void {
  if (level === 'tx' && !$chkTx.checked) return;
  if (level === 'rx' && !$chkRx.checked) return;
  let body = text;
  if (frame) body = describeFrame(frame);
  const line = h('div', { class: level }, body);
  if (frame) line.title = t('log.rawFrame').replace('{h}', Array.from(frame, (x) => x.toString(16).padStart(2, '0')).join(' '));
  $log.appendChild(line);
  while ($log.childNodes.length > 400) $log.removeChild($log.firstChild!);
  if ($chkScroll.checked) $log.scrollTop = $log.scrollHeight;
}

device.on('state', () => {
  refreshMeters();
  refreshStatusbar();
  refreshLamps();
  refreshOutButton();
});
device.on('telemetry', () => {
  refreshMeters();
  refreshLamps();
  refreshOutButton();
});
device.on('log', (e) => appendLog(e.level, e.text, e.frame));
device.on('error', (e) => {
  appendLog('error', `ERR ${e.message}`);
});

// ---------- actions ----------
// Output button state: ON (output on, green highlight pulse) / OFF (stopped, blue). Shows "turn on output" when disconnected.
function refreshOutButton(): void {
  const on = state.connected && state.status.output === 'RUN';
  $btnOut.textContent = on ? t('out.off') : t('out.on');
  $btnOut.classList.remove('out-on', 'out-off');
  $btnOut.classList.add(on ? 'out-on' : 'out-off');
  $btnOut.title = on ? t('lamp.outstop.tip') : t('lamp.outrun.tip');
}

function setConnectedUi(on: boolean): void {
  $btnConnect.disabled = on;
  $btnDisconnect.disabled = !on;
  $btnOut.disabled = !on;
  $btnSet.disabled = !on;
  $selBaud.disabled = on;
  $btnLock.disabled = !on;
  paintLock();
  refreshOutButton();
}

// ---------- preset quick select (toggle highlights the one matching current input) ----------
function buildPresetQuick(): void {
  const host = document.getElementById('preset-quick');
  if (!host) return;
  const epsV = 0.005; // voltage-match tolerance (V)
  const epsA = 0.0005; // current-match tolerance (A)
  const matches = (iv: number, ia: number, p: { voltage: number; current: number } | undefined): boolean =>
    !!p && Math.abs(iv - p.voltage) <= epsV && Math.abs(ia - p.current) <= epsA;
  const render = (): void => {
    const st = device.getState();
    const iv = parseFloat($inV.value);
    const ia = parseFloat($inA.value);
    const okV = Number.isFinite(iv);
    const okA = Number.isFinite(ia);
    host.textContent = '';
    for (let i = 0; i < 6; i++) {
      const p = st.presets[i];
      const matchOn = okV && okA && matches(iv, ia, p);
      const b = h('button', { type: 'button', class: 'pq-btn' + (matchOn ? ' on' : ''), title: `M${i + 1}: ${fmtVolt2(p?.voltage)} V / ${fmtField(p?.current, 'seta')} A` },
        h('span', { class: 'pq-idx' }, `M${i + 1}`),
        h('span', { class: 'pq-val' }, `${fmtVolt2(p?.voltage)}V / ${p ? fmtField(p.current, 'seta') : '--'}A`));
      on(b, 'click', async () => {
        if (!device.isOpen()) {
          appendLog('warn', t('log.connectFirst'));
          return;
        }
        if (!uiGate.canManual()) {
          appendLog('warn', t('log.autoTaskSetPreset').replace('{label}', uiGate.current().label ?? ''));
          return;
        }
        const running = device.getState().status.output === 'RUN';
        if (running) {
          const ok = await confirmDialog({ title: t('log.switchPreset.title').replace('{n}', String(i + 1)), body: t('log.switchPreset.body'), okText: t('log.switchPreset.ok'), danger: true });
          if (!ok) return;
        }
        await device.loadPreset(i + 1);
        const st2 = device.getState();
        $inV.value = fmtSetVal(st2.settings.voltageSet, true);
        $inA.value = fmtSetVal(st2.settings.currentSet, false);
        appendLog('info', t('log.presetLoaded').replace('{n}', String(i + 1)).replace('{v}', fmtVolt2(st2.settings.voltageSet)).replace('{a}', fmtField(st2.settings.currentSet, 'seta')));
      });
      host.append(b);
    }
  };
  device.on('state', render);
  on($inV, 'input', render);
  on($inA, 'input', render);
  render();
}

on($btnConnect, 'click', async () => {
  if (!uiGate.canConnect()) {
    appendLog('warn', t('log.otherTask').replace('{label}', uiGate.current().label ?? t('log.know')));
    return;
  }
  uiGate.beginConnecting();
  setConnectedUi(false);
  try {
    if (!webSerialSupported()) {
      await confirmDialog({
        title: t('log.noWebSerial.title'),
        body: t('log.noWebSerial.body'),
        okText: t('log.know'),
      });
      return;
    }
    const baud = Number($selBaud.value);
    if ($selTransport.value === 'ws') {
      const url = $inProxy.value.trim();
      appendLog('info', t('log.proxyMode').replace('{url}', url));
      await device.connect(new WebSocketTransport(url, baud));
    } else {
      const port = await WebSerialTransport.requestPort();
      if (!port) return;
      const t = new WebSerialTransport(port, baud);
      await device.connect(t);
    }
    setConnectedUi(true);
    await device.refreshSnapshot();
    await device.refreshSnapshot();
  } catch (err) {
    appendLog('error', t('log.connectFailed').replace('{e}', (err as Error).message));
    await device.disconnect('connect-failed').catch(() => undefined);
    setConnectedUi(false);
  } finally {
    uiGate.endConnecting();
  }
});

on($btnDisconnect, 'click', async () => {
  if (uiGate.isAuto()) {
    appendLog('info', t('log.stopAutoFirst').replace('{label}', uiGate.current().label ?? ''));
    uiGate.requestStop();
    await new Promise((r) => setTimeout(r, 400));
  }
  await device.disconnect();
  setConnectedUi(false);
});

// Panel lock toggle: locked = session enabled (panel not operable, web controls); unlocked = session closed (panel operable, web data stops).
function paintLock(): void {
  $btnLock.textContent = panelLocked ? '🔒' : '🔓';
  $btnLock.title = t('conn.lock.title');
}
on($btnLock, 'click', async () => {
  if (!device.isOpen()) return;
  panelLocked = !panelLocked;
  paintLock();
  try {
    await device.setPanelLock(panelLocked);
    appendLog('info', panelLocked ? t('log.locked') : t('log.unlocked'));
  } catch (err) {
    appendLog('error', t('log.lockFailed').replace('{e}', (err as Error).message));
    panelLocked = !panelLocked;
    paintLock();
  }
});

async function applySet(): Promise<void> {
  if (!uiGate.canManual()) {
    appendLog('warn', t('log.autoTaskSet').replace('{label}', uiGate.current().label ?? ''));
    return;
  }
  if (!device.isOpen()) {
    appendLog('warn', t('log.notConn'));
    return;
  }
  const vv = validateInput(true);
  const aa = validateInput(false);
  const v = Number($inV.value);
  const a = Number($inA.value);
  if (vv.bad || aa.bad) {
    appendLog('error', t('log.inputInvalid').replace('{v}', vv.msg).replace('{a}', aa.msg || ''));
    return;
  }
  if (!Number.isFinite(v) || !Number.isFinite(a)) {
    appendLog('error', t('log.invalidNum'));
    return;
  }
  try {
    await device.setVoltage(v);
    await device.setCurrent(a);
    const snap = state.settings;
    $inV.value = snap.voltageSet !== undefined ? fmtSetVal(snap.voltageSet, true) : $inV.value;
    $inA.value = snap.currentSet !== undefined ? fmtSetVal(snap.currentSet, false) : $inA.value;
  } catch (err) {
    appendLog('error', (err as Error).message);
  }
}

on($btnSet, 'click', applySet);
on($inV, 'keydown', (e) => e.key === 'Enter' && applySet());
on($inA, 'keydown', (e) => e.key === 'Enter' && applySet());

on($btnOut, 'click', async () => {
  if (!uiGate.canManual()) {
    appendLog('warn', t('log.autoTaskOut').replace('{label}', uiGate.current().label ?? ''));
    return;
  }
  if (!device.isOpen()) {
    appendLog('warn', t('log.notConn'));
    return;
  }
  const st = device.getState();
  const wantRun = st.status.output !== 'RUN';
  // Only use the "applied" params: read the applied voltage/current setpoints, not the input box.
  const v = st.settings.voltageSet;
  const a = st.settings.currentSet;
  // No "too high" judgment (can't decide what's too high for the user); only a general safety reminder; no repeated body when turning off.
  const detail = wantRun ? t('out.confirmOn.detail') : '';
  if (settings.confirmDanger || wantRun) {
    const ok = await confirmDialog({
      title: wantRun ? t('out.confirmOn.title') : t('out.confirmOff.title'),
      body: wantRun ? t('out.confirmOn.body') : t('out.confirmOff.body'),
      okText: wantRun ? t('out.confirmOn.ok') : t('out.confirmOff.ok'),
      danger: wantRun,
      detail,
    });
    if (!ok) return;
  }
  try {
    await device.setOutput(wantRun);
    if (wantRun) {
      // official behaviour: re-assert setpoint after enabling output
      if (v !== undefined && Number.isFinite(v)) await device.setVoltage(v);
      if (a !== undefined && Number.isFinite(a)) await device.setCurrent(a);
    }
    setConnectedUi(true);
  } catch (err) {
    appendLog('error', (err as Error).message);
  }
});

// Language switch: save and reload the whole page to rebuild the UI in the chosen language
on($('#btn-lang'), 'click', async () => {
  const next = currentLang() === 'zh' ? 'en' : 'zh';
  const ok = await confirmDialog({ title: t('lang.confirm.title'), body: t('lang.confirm.body'), okText: t('lang.confirm.ok') });
  if (!ok) return;
  setLang(next);
  location.reload();
});

on($('#btn-theme'), 'click', () => {
  const next = settings.theme === 'dark' ? 'light' : 'dark';
  settings.theme = next;
  document.documentElement.setAttribute('data-theme', next);
  saveSettings(settings);
});

on($('#btn-logclear'), 'click', () => {
  $log.textContent = '';
});

// connection transport switch
on($selTransport, 'change', () => {
  $inProxy.hidden = $selTransport.value !== 'ws';
  saveTransportPrefs({ mode: $selTransport.value as 'usb' | 'ws', wsUrl: $inProxy.value.trim() || 'ws://127.0.0.1:8787' });
});
on($inProxy, 'change', () => {
  saveTransportPrefs({ mode: $selTransport.value as 'usb' | 'ws', wsUrl: $inProxy.value.trim() });
});

// ---------- tabs (only dashboard active in MVP) ----------
on($('#tabs'), 'click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-tab]') as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;
  document.querySelectorAll('button[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
  const name = btn.dataset.tab!;
  for (const sec of document.querySelectorAll<HTMLElement>('section.tabpage')) sec.hidden = true;
  const target = document.getElementById(`tab-${name}`);
  if (target) target.hidden = false;
});

// ---------- tab content modules ----------
// curve/record embedded into the dashboard page (merged single page); each tab init wrapped defensively, errors logged instead of silent blank
const tabInits: [string, () => void][] = [
  [
    'record(仪表内嵌)',
    () =>
      initRecordTab($('#curve-area'), {
        device,
        samplePeriodMs: () => loadSettings().samplePeriodMs,
        sessionCapPoints: () => loadSettings().sessionCapPoints,
      }),
  ],
  ['preset', () => initPresetTab($('#tab-preset'), device)],
  ['sequence', () => initSequenceTab($('#tab-sequence'), device, () => loadSettings())],
  ['scan', () => initScanTab($('#tab-scan'), device)],
  ['protect', () => initProtectTab($('#tab-protect'), device)],
  ['script', () => initScriptTab($('#tab-script'), () => window.dps150 ?? null)],
  ['settings', () =>
    initSettingsTab(
      $('#tab-settings'),
      device,
      () => loadSettings(),
      (t) => {
        settings.theme = t;
        document.documentElement.setAttribute('data-theme', t);
        saveSettings(settings);
      },
      () => {
        settings = loadSettings();
        refreshStatusbar();
      },
      () => location.reload(),
    )],
];
for (const [label, fn] of tabInits) {
  try {
    fn();
  } catch (err) {
    appendLog('error', t('log.initFailed').replace('{label}', label).replace('{e}', (err as Error).message));
  }
}


// ---------- output control: step / common steps / virtual keypad ----------
const $decV = $('#dec-v') as HTMLButtonElement;
const $incV = $('#inc-v') as HTMLButtonElement;
const $decA = $('#dec-a') as HTMLButtonElement;
const $incA = $('#inc-a') as HTMLButtonElement;
const $stepV = $('#step-v') as HTMLInputElement;
const $stepA = $('#step-a') as HTMLInputElement;
const $chipsV = $('#chips-v') as HTMLElement;
const $chipsA = $('#chips-a') as HTMLElement;

function clampByUnit(v: number, isVolt: boolean): number {
  const lim = device.getState().limits;
  const hi = isVolt ? lim.maxVoltage : lim.maxCurrent;
  if (hi !== undefined && v > hi) v = hi;
  if (v < 0) v = 0;
  return v;
}
// Decimal digits of a value string (keeps the addend's decimal precision in step arithmetic).
function decCount(v: number | string): number {
  const s = String(v);
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(6, s.length - i - 1);
}
function nudge(isVolt: boolean, dir: 1 | -1): void {
  const inp = (isVolt ? $inV : $inA) as HTMLInputElement;
  const stepIn = (isVolt ? $stepV : $stepA) as HTMLInputElement;
  const cur = Number(inp.value);
  const base = Number(stepIn.value);
  const step = isFinite(base) && base > 0 ? base : isVolt ? 0.1 : 0.01;
  // Keep the current value's decimal digits (e.g. 2.1 + step 1 → 3.1, not rounded to 3 by step precision).
  const dec = Math.max(decCount(inp.value), decCount(step));
  const nextUnclamped = (isFinite(cur) ? cur : 0) + dir * step;
  const next = clampByUnit(Number(nextUnclamped.toFixed(dec)), isVolt);
  inp.value = String(next);
  const st = device.getState();
  const max = isVolt ? st.limits.maxVoltage : st.limits.maxCurrent;
  if (max !== undefined && next >= max) appendLog('warn', t('log.atLimit').replace('{u}', isVolt ? t('val.voltage') : t('val.current')).replace('{max}', String(max)));
}
function buildChips(host: HTMLElement, steps: number[], stepIn: HTMLInputElement): void {
  for (const v of steps) {
    const b = h('button', { type: 'button', class: 'step-chip', title: t('log.pickStep').replace('{v}', String(v)) }, String(v));
    on(b, 'click', () => {
      stepIn.value = String(v);
      host.querySelectorAll('.step-chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    });
    if (String(v) === stepIn.value) b.classList.add('on');
    host.append(b);
  }
}
on($decV, 'click', () => nudge(true, -1));
on($incV, 'click', () => nudge(true, 1));
on($decA, 'click', () => nudge(false, -1));
on($incA, 'click', () => nudge(false, 1));
buildChips($chipsV, [0.001, 0.01, 0.1, 1, 5], $stepV);
buildChips($chipsA, [0.001, 0.01, 0.05, 0.1, 1], $stepA);

// Instant input-validity check (defensive)
const $hintV = $('#hint-v') as HTMLElement;
const $hintA = $('#hint-a') as HTMLElement;
function validateInput(isVolt: boolean): { bad: boolean; msg: string } {
  const inp = (isVolt ? $inV : $inA) as HTMLInputElement;
  const hint = (isVolt ? $hintV : $hintA) as HTMLElement;
  const v = Number(inp.value);
  const st = device.getState();
  const checks = isVolt
    ? checkVoltage(v, { connected: true, maxVoltage: st.limits.maxVoltage })
    : checkCurrent(v, { connected: true, maxCurrent: st.limits.maxCurrent });
  const err = checks.find((c) => c.level === 'error');
  const warn = checks.find((c) => c.level === 'warn');
  inp.classList.toggle('invalid', !!err);
  inp.title = err ? err.msg : '';
  hint.textContent = err ? '⚠ ' + err.msg : warn ? '⚠ ' + warn.msg : '';
  hint.classList.toggle('warn-msg', !!warn && !err);
  hint.classList.toggle('err-msg', !!err);
  return { bad: !!err, msg: err ? err.msg : '' };
}
on($inV, 'input', () => validateInput(true));
on($inA, 'input', () => validateInput(false));

// Floating number keypad (draggable/closable/semi-transparent). kbd-toggle is the "master switch": when enabled,
// clicking the input box summons the keypad; when disabled it does not. Closing the keypad does not change the master switch state.
const kbdToggle = $('#kbd-toggle') as HTMLButtonElement;
const kbd = new FloatingKeypad($inV, $inA);
let kbdEnabled = false;
function setKbdEnabled(on: boolean): void {
  kbdEnabled = on;
  kbdToggle.classList.toggle('on', on);
  kbdToggle.title = on ? t('log.kbdEnabled') : t('log.kbdDisabled');
  if (!on) kbd.hide();
}
on($inV, 'focus', () => { if (kbdEnabled) kbd.show(); $inV.select(); });
on($inA, 'focus', () => { if (kbdEnabled) kbd.show(); $inA.select(); });
on(kbdToggle, 'click', () => setKbdEnabled(!kbdEnabled));


// ===== Debug button → protocol log floating window (created at top; this only handles show/hide/drag/close) =====
const btnDebug = $('#btn-debug') as HTMLButtonElement;
const dbgDrag = { on: false, dx: 0, dy: 0 };
let dbgOn = false;
function setDbg(on: boolean): void {
  dbgOn = on;
  dbgWin.classList.toggle('open', on);
  dbgWin.hidden = !on;
}
on(btnDebug, 'click', () => setDbg(!dbgOn));
on(dbgWin.querySelector('#dbg-close') as HTMLButtonElement, 'click', () => setDbg(false));
const dbgHead = dbgWin.querySelector('.dbg-head') as HTMLElement;
dbgHead.addEventListener('pointerdown', (e: PointerEvent) => {
  if ((e.target as HTMLElement).tagName === 'BUTTON') return;
  e.preventDefault();
  dbgDrag.on = true;
  const r = dbgWin.getBoundingClientRect();
  dbgDrag.dx = e.clientX - r.left;
  dbgDrag.dy = e.clientY - r.top;
  const move = (ev: PointerEvent): void => {
    if (!dbgDrag.on) return;
    const left = Math.min(Math.max(4, ev.clientX - dbgDrag.dx), window.innerWidth - 160);
    const top = Math.min(Math.max(4, ev.clientY - dbgDrag.dy), window.innerHeight - 60);
    dbgWin.style.left = `${left}px`;
    dbgWin.style.top = `${top}px`;
    dbgWin.style.right = 'auto';
    dbgWin.style.bottom = 'auto';
  };
  const up = (): void => {
    dbgDrag.on = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// polite disconnect on page unload / reload / close
window.addEventListener('beforeunload', () => {
  void device.disconnect('page-unload').catch(() => undefined);
});

// Disable manual buttons while busy (tied to the activity-gate state)
const refreshBusy = (): void => {
  const conn = device.isOpen();
  const busy = !uiGate.canManual();
  $btnSet.disabled = busy || !conn;
  $btnOut.disabled = busy || !conn;
  $btnSet.title = busy ? t('log.autoTaskTitle').replace('{label}', uiGate.current().label ?? '') : '';
  $btnOut.title = busy ? t('log.autoTaskTitle').replace('{label}', uiGate.current().label ?? '') : '';
};
uiGate.on(refreshBusy);
device.on('state', refreshBusy);

// initial paint
buildLamps();
buildPresetQuick();
buildMeters();
refreshMeters();
refreshStatusbar();
setConnectedUi(false);
appendLog('info', t('log.ready'));
applyStatic();
