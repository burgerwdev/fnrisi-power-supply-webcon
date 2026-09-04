// Device-free headless audit: renders the app in zh & en, asserts key labels render,
// checks scan-wizard tooltips/labels, theme toggle, and that there are no console/page
// errors. Captures screenshots for the test report. No serial device required.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENS = path.join(__dirname, '..', 'docs', 'screens');
(async () => {
  fs.mkdirSync(SCREENS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));

  const URL = 'http://localhost:4173/';
  await page.goto(URL, { waitUntil: 'networkidle' });

  const out = { pass: [], fail: [] };
  const ok = (name, cond, detail = '') => (cond ? out.pass.push(name) : out.fail.push(`${name} ${detail}`));

  async function assertText(sel, needle, enName) {
    const txt = (await page.locator(sel).first().textContent()) || '';
    ok(`${enName}: has "${needle}"`, txt.includes(needle), `got="${txt.trim().slice(0, 40)}"`);
  }
  async function assertAny(sel, needles, enName) {
    const txt = (await page.locator(sel).first().textContent()) || '';
    const hit = needles.find((n) => txt.includes(n));
    ok(`${enName}: has [${needles.join('|')}]`, !!hit, `got="${txt.trim().slice(0, 40)}"`);
  }

  // ---- zh ----
  await assertAny('nav.tabs', ['仪表', '预设', '序列', '扫描'], 'zh tabs');
  await assertAny('.set-panel', ['应用设定', '开启输出', '设定'], 'zh set panel');
  await assertAny('#meters', ['实际输出', '电压', '电流', '功率'], 'zh meters');
  await assertAny('.preset-quick-panel', ['预设快速选择'], 'zh quick presets');
  await assertAny('.session-section', ['会话记录'], 'zh sessions');

  // scan tab (zh)
  await page.click('button[data-tab="scan"]');
  await page.waitForTimeout(200);
  await assertAny('#tab-scan', ['扫描向导', '扫描轴', '起始', '结束', '步进', '固定电流', '稳定(ms)', '开始扫描', '扫描实时曲线'], 'zh scan labels');
  const hasTitles = await page.evaluate(() =>
    ['#sc-start', '#sc-stop', '#sc-step', '#sc-fixed', '#sc-settle'].every((id) => {
      const el = document.querySelector(id);
      return el && el.getAttribute('title') && el.getAttribute('title').length > 2;
    }),);
  ok('zh scan inputs have hover tooltips', hasTitles);
  const kind = await page.locator('#sc-kind').inputValue();
  ok('zh scan default kind is voltage', kind === 'voltage');
  await page.screenshot({ path: path.join(SCREENS, 'audit-scan-zh.png') });

  // back to meter
  await page.click('button[data-tab="meter"]');
  await page.waitForTimeout(200);

  // on-screen keypad: must first enable the kbd-toggle master switch, focus the current box → select-all →
  // press keys to write into the current rather than voltage; the decimal point can be entered normally
  await page.click('#in-a');
  await page.waitForTimeout(200);
  const kbdOffVisible = await page.locator('.kbd.float').isVisible().catch(() => false);
  ok('keypad: hidden when toggle off', !kbdOffVisible);
  await page.click('#kbd-toggle');
  await page.waitForTimeout(200);
  const kbdOn = await page.evaluate(() => document.getElementById('kbd-toggle').classList.contains('on'));
  ok('keypad: toggle enabled', kbdOn);
  await page.click('#in-a');
  await page.waitForTimeout(250);
  const activeA = await page.evaluate(() => document.activeElement && document.activeElement.id);
  ok('keypad: A input focused on click', activeA === 'in-a', `active=${activeA}`);
  const selA = await page.evaluate(() => { const el = document.getElementById('in-a'); return { s: el.selectionStart, e: el.selectionEnd, v: el.value }; });
  ok('keypad: A select-all on focus', selA.s === 0 && selA.e === selA.v.length, JSON.stringify(selA));
  await page.click('.kbd-grid .kbd-key:has-text("7")');
  await page.waitForTimeout(60);
  const aVal = await page.inputValue('#in-a');
  ok('keypad: typing goes to current (not voltage)', aVal === '7', `in-a=${aVal}`);
  // voltage box: decimal input (focus select-all first, then press "." and "7")
  await page.click('#in-v');
  await page.waitForTimeout(200);
  await page.click('.kbd-grid .kbd-key:has-text(".")');
  await page.waitForTimeout(50);
  await page.click('.kbd-grid .kbd-key:has-text("7")');
  await page.waitForTimeout(60);
  const vVal = await page.inputValue('#in-v');
  ok('keypad: decimal entry works (no clear)', vVal === '.7', `in-v=${vVal}`);
  // restore values to avoid affecting later steps
  await page.evaluate(() => { document.getElementById('in-v').value = '0.5'; document.getElementById('in-a').value = '0.05'; });

  // stepper: decimal + integer step must keep the decimal (2.1 + 1 → 3.1, not 3)
  await page.evaluate(() => { document.getElementById('in-v').value = '2.1'; document.getElementById('step-v').value = '1'; });
  await page.click('#inc-v');
  await page.waitForTimeout(60);
  const stepVal = await page.inputValue('#in-v');
  ok('stepper: 2.1 + step 1 -> 3.1', stepVal === '3.1', `in-v=${stepVal}`);
  await page.evaluate(() => { document.getElementById('in-v').value = '0.5'; document.getElementById('step-v').value = '0.1'; });

  // theme toggle
  const theme0 = await page.getAttribute('html', 'data-theme');
  await page.click('#btn-theme');
  const theme1 = await page.getAttribute('html', 'data-theme');
  ok('theme toggles', theme0 !== theme1, `${theme0}->${theme1}`);
  await page.screenshot({ path: path.join(SCREENS, 'audit-meter-zh.png') });

  // ---- switch to English (reloads the page) ----
  await page.evaluate(() => localStorage.setItem('dps150.settings.v1', JSON.stringify({ ...JSON.parse(localStorage.getItem('dps150.settings.v1') || '{}'), language: 'en' })));
  await page.reload({ waitUntil: 'networkidle' });
  await assertAny('nav.tabs', ['Meter', 'Preset', 'Sequence', 'Scan'], 'en tabs');
  await assertAny('.set-panel', ['Apply', 'Output', 'SET'], 'en set panel');
  await assertAny('#meters', ['Actual Output', 'Voltage', 'Current', 'Power'], 'en meters');
  await assertAny('.preset-quick-panel', ['Quick Presets'], 'en quick presets');
  await assertAny('.session-section', ['Sessions'], 'en sessions');
  await page.screenshot({ path: path.join(SCREENS, 'audit-meter-en.png') });

  // scan tab (en)
  await page.click('button[data-tab="scan"]');
  await page.waitForTimeout(200);
  await assertAny('#tab-scan', ['Scan', 'Sweep axis', 'Start', 'End', 'Step', 'Fixed', 'Settle', 'Scan live curve'], 'en scan labels');
  await page.screenshot({ path: path.join(SCREENS, 'audit-scan-en.png') });

  // instrument a lightweight "no untranslated CJK in primary chrome" scan:
  // (covers the topbar/tabs only, which must be fully localized)
  const topbarCjk = await page.evaluate(async () => {
    const el = document.querySelector('nav.tabs');
    return /[\u4e00-\u9fff]/.test((el && el.textContent) || '');
  });
  ok('en topbar has no Chinese leftovers', !topbarCjk, topbarCjk ? 'found CJK in tabs' : '');

  // reset language to zh so following runs are deterministic
  await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('dps150.settings.v1') || '{}'); s.language = 'zh'; localStorage.setItem('dps150.settings.v1', JSON.stringify(s)); });
  await page.reload({ waitUntil: 'networkidle' });

  ok('no console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  const failed = out.fail.length;
  console.log('AUDIT_RESULT ' + JSON.stringify({ pass: out.pass, fail: out.fail }, null, 2));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('AUDIT_CRASH', e);
  process.exit(2);
});
