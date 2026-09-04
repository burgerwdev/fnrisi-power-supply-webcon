// UI full-feature suite against the REAL device (headed google-chrome in WSL).
// Manual step once: pick DPS-150 in the Web Serial chooser. Everything else auto:
// Meter reading/connection info -> set V·A readback -> output RUN-STOP (1V/50mA no-load) -> preset M1 -> protection OVP
// -> record + CSV export -> sequence (≤1V/50mA) -> scan (0.5..1.0V no-load) -> script sample -> settings/theme/recipe.
// Ends with full state tidy + per-feature PASS/FAIL table.
const { chromium } = require('playwright');

const PROXY = !!process.env.PROXY;
const BASE = process.env.URL || 'http://localhost:4173/';
const URL = PROXY ? BASE + '?proxy=ws://127.0.0.1:' + (process.env.WSPORT || 8787) : BASE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RES = [];
function rec(name, ok, detail = '') {
  RES.push({ name, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name} ${detail}`.trimEnd());
}
const logText = (page) => page.locator('#log').textContent().catch(() => '');
async function waitLog(page, kw, ms) {
  const t = Date.now() + ms;
  let last = '';
  while (Date.now() < t) {
    last = await logText(page);
    if (last.includes(kw)) return true;
    await sleep(250);
  }
  return false;
}
async function clickDialogButton(page, re) {
  const btn = page.locator('.dialog button', { hasText: re }).last();
  await btn.waitFor({ state: 'visible', timeout: 5000 });
  await btn.click();
}
async function switchTab(page, name) {
  await page.click(`button[data-tab="${name}"]`);
  await sleep(150);
}
async function stateApi(page) {
  return page.evaluate(() => ({
    connected: dps150.connected,
    out: dps150.state.status.output,
    prot: dps150.state.status.protection,
    mode: dps150.state.status.mode,
    setV: dps150.state.settings.voltageSet,
    setA: dps150.state.settings.currentSet,
    ovp: dps150.state.protections.ovp,
    m1v: dps150.state.presets[0].voltage,
    m1a: dps150.state.presets[0].current,
    model: dps150.state.info.modelName,
    fw: dps150.state.info.fwVersion,
    vin: dps150.state.telemetry.inputVoltage,
  }));
}
const closeTo = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) < tol;

(async () => {
  console.log('[boot] Launching real google-chrome…');
  const browser = await chromium.launch({
    channel: PROXY ? undefined : 'chrome',
    headless: PROXY,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...(PROXY ? [] : ['--start-maximized'])],
  });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1360, height: 940 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(URL, { waitUntil: 'networkidle' });
  if (!(await page.evaluate(() => !!navigator.serial))) throw new Error('Web Serial unavailable');

  console.log(PROXY ? '[connect] Connecting via local serial proxy…' : '[connect] Please pick DPS-150 in the system dialog…');
  await page.click('#btn-connect');
  if (!(await waitLog(page, '已收到设备数据,连接正常', 60000))) {
    console.log('!! connect got no data. Page log tail:\n' + (await logText(page)).slice(-2000));
    await browser.close();
    process.exit(2);
  }
  await sleep(1500);

  // ---- 1. dashboard ----
  let s = await stateApi(page);
  const meterText = (await page.locator('#meters').textContent()).replace(/\s+/g, ' ').trim();
  rec('Meter area has live reading (vin≈20)', /\d+\.\d+\s*V/.test(meterText) && closeTo(s.vin, 20, 2), `vin=${s.vin?.toFixed?.(2)}`);
  rec('Connection chip connected', (await page.locator('#lamp-link').textContent()).includes('已连接'));
  rec('Device info (model/firmware)', s.model === 'DPS-150P' && !!s.fw, JSON.stringify({ m: s.model, f: s.fw }));
  const BASE = { ovp: s.ovp, m1v: s.m1v, m1a: s.m1a, setV: s.setV, setA: s.setA };
  rec('Status lamp output STOP / protection OK', s.out === 'STOP' && s.prot === 'OK', JSON.stringify(s));

  // ---- 2. set V/A via UI with readback ----
  await page.locator('#in-v').fill('1.5');
  await page.locator('#in-a').fill('0.10');
  await page.click('#btn-set');
  await sleep(2200);
  s = await stateApi(page);
  rec('UI set V/A → API/FF readback', closeTo(s.setV, 1.5, 0.02) && closeTo(s.setA, 0.1, 0.005), `v=${s.setV} a=${s.setA}`);

  // ---- 3. output RUN/STOP (safe 1.0V/50mA no load) ----
  await page.locator('#in-v').fill('1.0');
  await page.locator('#in-a').fill('0.05');
  await page.click('#btn-set');
  await sleep(1200);
  await page.click('#btn-out');
  await clickDialogButton(page, /开启/);
  await sleep(2600);
  s = await stateApi(page);
  rec('Output RUN (UI+API)', s.out === 'RUN', s.out);
  rec('During RUN output mode is CV', s.mode === 'CV', s.mode);
  await page.click('#btn-out'); // now labeled "Turn Output Off"
  await clickDialogButton(page, /关闭/);
  await sleep(1200);
  s = await stateApi(page);
  rec('Output STOP', s.out === 'STOP', s.out);

  // ---- 4. preset M1 ----
  const m1v0 = s.m1v;
  await switchTab(page, 'preset');
  const pv = page.locator('#ps-grid > div').first().locator('input').nth(0);
  const pa = page.locator('#ps-grid > div').first().locator('input').nth(1);
  await pv.fill('2.5');
  await pa.fill('0.50');
  await page.locator('#ps-grid > div').first().locator('button', { hasText: '存入本组' }).click();
  await sleep(1800);
  s = await stateApi(page);
  rec('Preset M1 save (write/readback)', closeTo(s.m1v, 2.5, 0.02) && closeTo(s.m1a, 0.5, 0.01), `M1=${s.m1v}/${s.m1a}`);
  // Calling it up is now the meter-page "Quick Preset" toggle
  await switchTab(page, 'meter');
  await page.locator('#preset-quick .pq-btn').first().click();
  await sleep(1500);
  s = await stateApi(page);
  rec('Preset M1 quick-call into main setting', closeTo(s.setV, 2.5, 0.05), `mainV=${s.setV}`);

  // ---- 5. protection OVP ----
  const ovp0 = s.ovp;
  await switchTab(page, 'protect');
  const rows = page.locator('#tab-protect .row');
  const ovpInput = rows.nth(0).locator('input');
  const ovpTarget = closeTo(ovp0, 25, 0.1) ? 20 : 25; // avoid writing same value twice in a row
  await ovpInput.fill(String(ovpTarget));
  await rows.nth(0).locator('button', { hasText: '应用' }).click();
  await sleep(1800);
  s = await stateApi(page);
  rec('Protection OVP write/readback', closeTo(s.ovp, ovpTarget, 0.02), `ovp=${s.ovp}`);

  // ---- 6. record session + CSV export ----
  await switchTab(page, 'meter'); // Recording is merged into the meter page
  await page.click('#rc-start');
  await sleep(3500);
  await page.click('#rc-stop');
  await sleep(800);
  const sessText = await page.locator('#rc-sessions').textContent();
  rec('Record session generated', /session-/.test(sessText), sessText.trim().slice(0, 60));
  // The session list sits back under the chart area (visible by default); CSV export can be clicked directly
  const dl = page.waitForEvent('download', { timeout: 8000 });
  await page.locator('#rc-sessions .row button', { hasText: 'CSV' }).first().click();
  const download = await dl;
  rec('Session CSV export', (await download.suggestedFilename()).endsWith('.csv'), download.suggestedFilename());
  await sleep(300);

  // ---- 7. sequence runner (safe rows) ----
  await switchTab(page, 'sequence');
  const seq = page.locator('#tab-sequence textarea');
  await seq.fill('0.6, 0.02, 400\n1.0, 0.02, 400');
  await page.locator('#tab-sequence button', { hasText: '运行' }).click();
  await clickDialogButton(page, /开始运行/);
  const seqDone = await (async () => {
    const t = Date.now() + 25000;
    while (Date.now() < t) {
      const st = await page.locator('#sq-status').textContent();
      if (st && st.includes('完成')) return st;
      await sleep(300);
    }
    return (await page.locator('#sq-status').textContent()) || '';
  })();
  s = await stateApi(page);
  rec('Sequence finished and output off', seqDone.includes('完成') && s.out === 'STOP', `${seqDone.slice(0, 40)} | out=${s.out}`);

  // ---- 8. scan (0.5..1.0V empty) ----
  await switchTab(page, 'scan');
  // scan default kind=voltage; use explicit safe values via ids
  await page.locator('#sc-start').fill('0.5');
  await page.locator('#sc-stop').fill('1.0');
  await page.locator('#sc-step').fill('0.5');
  await page.locator('#sc-fixed').fill('0.02');
  await page.locator('#sc-settle').fill('150');
  await page.locator('#tab-scan button', { hasText: '开始扫描' }).click();
  await clickDialogButton(page, /开始扫描/);
  const scanDone = await (async () => {
    const t = Date.now() + 25000;
    while (Date.now() < t) {
      const st = await page.locator('#sc-status').textContent().catch(() => '');
      if (st && /完成|已停止/.test(st)) return st;
      await sleep(300);
    }
    return 'timeout';
  })();
  await sleep(1400); // wait for output-off to take effect after the scan finishes
  s = await stateApi(page);
  rec('Scan complete, result rows=2, output off', /完成|已停止/.test(scanDone) && s.out === 'STOP', `${scanDone.slice(0, 50)} out=${s.out}`);
  const gridRows = await page.locator('#tab-scan div[style*="grid-template-columns"] > div').count();
  rec('Scan result table generated (≥6 cells)', gridRows >= 6, `cells=${gridRows}`);

  // ---- 9. script sample ----
  await switchTab(page, 'script');
  await page.locator('#tab-script select').selectOption({ label: '入门:设定并打印状态' });
  await page.locator('#tab-script button', { hasText: '运行' }).click();
  await clickDialogButton(page, /运行/);
  const outOk = await (async () => {
    const t = Date.now() + 20000;
    let last = '';
    while (Date.now() < t) {
      last = (await page.locator('#tab-script .log').textContent()) || '';
      if (last.includes('—— 运行完成 ——')) return true;
      await sleep(300);
    }
    return last;
  })();
  rec('DSL script run output', outOk === true, typeof outOk === 'string' ? outOk.slice(-220) : '');

  // ---- 10. settings: theme + recipe ----
  await switchTab(page, 'settings');
  const themeBefore = await page.getAttribute('html', 'data-theme');
  await page.locator('#tab-settings select').first().selectOption({ label: themeBefore === 'dark' ? '亮色' : '暗色(荧光绿)' });
  const themeAfter = await page.getAttribute('html', 'data-theme');
  rec('Settings - theme switch', themeBefore !== themeAfter, `${themeBefore}->${themeAfter}`);
  const rname = page.locator('#tab-settings input[type="text"]');
  await rname.fill('ui-e2e');
  await page.locator('#tab-settings button', { hasText: '从设备保存' }).click();
  await clickDialogButton(page, /好/);
  await sleep(400);
  const recipeList = await page.locator('#tab-settings').textContent();
  rec('Recipe saved from device and listed', recipeList.includes('ui-e2e'), '');
  const delDl = page.waitForEvent('download', { timeout: 0 }).catch(() => null); // noop
  void delDl;

  // tidy: delete ui-e2e recipe (DOM click is deterministic; coordinate clicks can miss
  // the row because the settings info box re-renders on telemetry & shifts the row)
  const rowBtn = page.locator('#tab-settings .row', { hasText: 'ui-e2e' }).locator('button', { hasText: '删除' });
  if (await rowBtn.count()) {
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('#tab-settings .row')].find((r) => r.textContent.includes('ui-e2e'));
      const btn = row && [...row.querySelectorAll('button')].find((b) => b.textContent.includes('删除'));
      btn?.click();
    });
    await clickDialogButton(page, /删除/);
  }

  // ---- restore M1 & V/A & OVP baseline ----
  await page.evaluate((b) => dps150.setPreset(1, b.m1v, b.m1a), BASE);
  await sleep(1200);
  await switchTab(page, 'meter');
  await page.locator('#in-v').fill('0.5');
  await page.locator('#in-a').fill('0.05');
  await page.click('#btn-set');
  await switchTab(page, 'protect');
  const rows2 = page.locator('#tab-protect .row');
  await rows2.nth(0).locator('input').fill(String(ovp0));
  await rows2.nth(0).locator('button', { hasText: '应用' }).click();
  await sleep(1800);
  s = await stateApi(page);
  rec('Site restore (0.5V/0.05A, OVP original value)', closeTo(s.setV, 0.5, 0.02) && closeTo(s.ovp, ovp0, 0.1), `v=${s.setV} ovp=${s.ovp}`);

  await switchTab(page, 'meter');
  await page.click('#btn-disconnect');
  await sleep(800);
  const chip = await page.locator('#lamp-link').textContent();
  rec('After disconnect returns to not-connected', chip.includes('未连接'), chip.trim());
  rec('No page errors throughout', errs.length === 0, errs.slice(0, 3).join(' | '));

  await page.screenshot({ path: '/tmp/ui-full.png' });
  const passed = RES.filter((r) => r.ok).length;
  console.log(`\n===== UI full-feature verification: ${passed}/${RES.length} passed =====`);
  for (const r of RES) if (!r.ok) console.log(`  FAIL: ${r.name}  ${r.detail}`);
  await browser.close();
  process.exit(passed === RES.length ? 0 : 1);
})().catch((e) => {
  console.error('UI_FULL_CRASH', e);
  process.exit(2);
});
