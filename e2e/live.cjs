// Live end-to-end drive of REAL google-chrome (WSL) against the REAL DPS-150.
// One manual step: pick the DPS-150 in the Web Serial chooser. Then:
// connect -> verify UI (meters/chips/statusbar/API state) -> safe write 3.3V/0.2A with
// FF read-back -> restore 0.5V/0.05A -> disconnect. Output stays OFF throughout.
const { chromium } = require('playwright');

const URL = process.env.URL || 'http://localhost:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function logText(page) {
  return (await page.locator('#log').textContent().catch(() => '')) || '';
}
async function waitLog(page, keyword, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await logText(page);
    if (last.includes(keyword)) return true;
    await sleep(250);
  }
  return false;
}

(async () => {
  console.log('[1/8] Launching real google-chrome (headed; a window appears for observation)…');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--start-maximized'],
  });
  const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console: ' + m.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  const serialOk = await page.evaluate(() => !!navigator.serial);
  console.log('[2/8] Page loaded; navigator.serial =', serialOk);
  if (!serialOk) throw new Error('Web Serial unavailable');

  console.log('[3/8] Clicking "Connect device"…\n>>> Please click DPS-150 (Artery AT32) in the system dialog; if already connected just continue.');
  await page.click('#btn-connect');
  const opened = await waitLog(page, '已收到设备数据,连接正常', 90000);
  if (!opened) {
    console.log('!! No data stream within 90s. Log tail:\n' + (await logText(page)).slice(-1200));
    throw new Error('no traffic');
  }
  console.log('[4/8] Data stream OK. Capturing page state…');
  await sleep(1500); // let a few telemetry bursts land

  const meterText = await page.locator('#meters').textContent();
  const chip = await page.locator('#chip-link').textContent();
  const statusbar = (await page.locator('.app-footer').textContent()).trim();
  const apiState = await page.evaluate(() => ({
    connected: dps150.connected,
    model: dps150.state.info.modelName,
    fw: dps150.state.info.fwVersion,
    vin: dps150.state.telemetry.inputVoltage,
    periodMs: dps150.state.telemetryPeriodMs,
  }));
  console.log('    Meter area text:', meterText.replace(/\s+/g, ' ').trim().slice(0, 160));
  console.log('    Connection chip:', chip.trim(), '| Status bar:', statusbar.slice(0, 140));
  console.log('    API state:', JSON.stringify(apiState));

  const meterOk =
    /\d+\.\d+/.test(meterText) && /已连接/.test(chip) && typeof apiState.vin === 'number' && apiState.vin > 10;

  console.log('[5/8] Safe write test (output stays OFF): set 3.3V / 0.2A (you can see the setpoint change on the device screen)…');
  await page.locator('#in-v').fill('3.3');
  await page.locator('#in-a').fill('0.2');
  await page.click('#btn-set');
  await sleep(2500);
  const after = await page.evaluate(() => ({
    setV: dps150.state.settings.voltageSet,
    setA: dps150.state.settings.currentSet,
    logTail: document.querySelector('#log').textContent.split('\n').slice(-8).join('\n'),
  }));
  console.log('    After write, API settings:', JSON.stringify({ v: after.setV, a: after.setA }));
  console.log('    Log tail:\n    ' + after.logTail);
  const writeOk =
    after.setV !== undefined &&
    Math.abs(after.setV - 3.3) < 0.02 &&
    Math.abs(after.setA - 0.2) < 0.005;

  console.log('[6/8] Restoring defaults 0.5V / 0.05A…');
  await page.locator('#in-v').fill('0.5');
  await page.locator('#in-a').fill('0.05');
  await page.click('#btn-set');
  await sleep(2000);
  const restored = await page.evaluate(() => dps150.state.settings.voltageSet);
  console.log('    After restore, API voltageSet =', restored);

  console.log('[7/8] Disconnecting…');
  await page.click('#btn-disconnect');
  await sleep(800);

  await page.screenshot({ path: '/tmp/live2.png' });
  console.log('[8/8] Done.');
  console.log('=== Summary ===');
  console.log('UI meter has reading  :', meterOk ? 'PASS' : 'FAIL', '(vin=' + apiState.vin + ')');
  console.log('Write device & FF readback:', writeOk ? 'PASS' : 'FAIL', '(v=' + after.setV + ' a=' + after.setA + ')');
  console.log('Restore defaults      :', Math.abs(restored - 0.5) < 0.02 ? 'PASS' : 'WARN(' + restored + ')');
  console.log('Page errors          :', pageErrors.length ? pageErrors.join(' | ') : '(none)');
  await browser.close();
  process.exit(meterOk && writeOk ? 0 : 1);
})().catch((e) => {
  console.error('LIVE_CRASH', e);
  process.exit(2);
});
