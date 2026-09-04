// Diagnostic: is it cache/baud/device-stream vs Chrome read path?
// Attempts connect at 115200 then 9600. On silence while the port is open in Chrome,
// sniffs /dev/ttyACM0 from python to see whether the device is pushing at all.
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const URL = process.env.URL || 'http://localhost:4173/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logText = (page) => page.locator('#log').textContent().catch(() => '');
async function waitAny(page, kws, ms) {
  const t = Date.now() + ms;
  let last = '';
  while (Date.now() < t) {
    last = await logText(page);
    if (kws.some((k) => last.includes(k))) return { hit: kws.find((k) => last.includes(k)), log: last };
    await sleep(250);
  }
  return { hit: null, log: last };
}
function sniff(seconds = 2.5) {
  try {
    const out = execSync(
      `python3 -c "import serial,time; s=serial.Serial('/dev/ttyACM0',9600,timeout=0.2); t=time.time()+${seconds}; n=0
while time.time()<t:
 d=s.read(4096)
 if d: n+=len(d)
print('PY_SNIFF_BYTES', n)
s.close()"`,
      { encoding: 'utf-8', timeout: 10000 },
    );
    return out.trim();
  } catch (e) {
    return 'PY_SNIFF_ERR ' + String(e.message).slice(0, 200);
  }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage', '--start-maximized'] });
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerr ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push('console ' + m.text()));
  await page.goto(URL, { waitUntil: 'networkidle' });

  async function attempt(baud) {
    console.log(`\n===== Attempting ${baud} =====`);
    await page.locator('#sel-baud').selectOption(String(baud));
    console.log('Please pick DPS-150 in the system dialog…');
    await page.click('#btn-connect');
    const r = await waitAny(page, ['已收到设备数据', '自动执行一次', '仍未收到设备数据'], 20000);
    const opened = await logText(page);
    const hasRX = /RX reg=/.test(opened);
    console.log('  Keyword hit:', r.hit, '| RX reg frame seen:', hasRX);
    if (hasRX || r.hit === '已收到设备数据') {
      await sleep(1500);
      console.log('  RESULT: SUCCESS (received data)');
      const tail = (await logText(page)).split('\n').slice(-6).join('\n');
      console.log('  Log tail:\n' + tail);
      return true;
    }
    console.log('  Chrome silent. While still connected, side-channel sniff the device stream:');
    console.log('  ' + sniff());
    const tail = (await logText(page)).split('\n').slice(-6).join('\n');
    console.log('  Page log tail:\n' + tail);
    console.log('  Page errors:', errs.length ? errs.join(' | ') : '(none)');
    // disconnect for next attempt
    await page.click('#btn-disconnect').catch(() => {});
    await sleep(1500);
    return false;
  }

  const ok115 = await attempt(115200);
  const ok9600 = ok115 ? null : await attempt(9600);
  console.log('\n===== Summary =====');
  console.log('115200:', ok115 ? 'received data' : 'silent (see side-channel sniff above)');
  console.log('9600  :', ok9600 === null ? 'not retried' : ok9600 ? 'received data' : 'silent');
  await page.screenshot({ path: '/tmp/diag.png' });
  await browser.close();
  process.exit(ok115 || ok9600 ? 0 : 3);
})().catch((e) => {
  console.error('DIAG_CRASH', e);
  process.exit(2);
});
