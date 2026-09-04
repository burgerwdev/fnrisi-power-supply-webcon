// Capture UI review screenshots (real device via proxy) for the user.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const dir = path.join(__dirname, '..', 'docs', 'screens');
  fs.mkdirSync(dir, { recursive: true });
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1360, height: 2000 } });
  await p.goto('http://localhost:4173/?proxy=ws://127.0.0.1:8787', { waitUntil: 'networkidle' });
  await p.click('#btn-connect');
  for (let i = 0; i < 60; i++) {
    const t = await p.locator('#log').textContent().catch(() => '');
    if (t.includes('已收到设备数据')) break;
    await sleep(400);
  }
  await sleep(2500);
  const shots = [];
  async function snap(name, theme) {
    await p.evaluate((th) => {
      document.documentElement.setAttribute('data-theme', th);
    }, theme);
    await sleep(400);
    const file = path.join(dir, `${name}.png`);
    await p.screenshot({ path: file, fullPage: false });
    shots.push(file);
  }
  // meter tab dark
  await snap('01-dashboard-dark', 'dark');
  await snap('02-dashboard-light', 'light');
  await p.click('button[data-tab="preset"]'); await sleep(400);
  await snap('03-presets-dark', 'dark');
  await p.click('button[data-tab="scan"]'); await sleep(400);
  await snap('04-scan-dark', 'dark');
  await p.click('button[data-tab="script"]'); await sleep(400);
  await snap('05-script-dsl-dark', 'dark');
  await p.click('button[data-tab="settings"]'); await sleep(400);
  await snap('06-settings-dark', 'dark');
  await p.click('button[data-tab="meter"]'); await sleep(300);
  // EN interface: switch language (full reload) → reconnect (proxy) → dashboard screenshot
  await p.click('#btn-lang');
  await p.locator('.dialog button').filter({ hasText: /切换|Switch/ }).first().click();
  await p.waitForLoadState('networkidle', { timeout: 15000 });
  await p.click('#btn-connect');
  for (let i = 0; i < 50; i++) {
    const tt = await p.locator('#log').textContent().catch(() => '');
    if (tt.includes('transport open')) break;
    await sleep(400);
  }
  await sleep(2500);
  await snap('08-dashboard-en', 'dark');
  // hover over chart center (uPlot canvas)
  const holder = p.locator('#curve-area #rc-chart').first();
  if (await holder.count()) {
    const bb = await holder.boundingBox();
    if (bb) {
      await p.mouse.move(bb.x + bb.width * 0.55, bb.y + bb.height * 0.5);
      await sleep(600);
      await snap('07-chart-hover-dark', 'dark');
    }
  }
  await b.close();
  console.log('SCREENSHOTS', shots.join('\n'));
})().catch((e) => { console.error('SHOT_ERR', e); process.exit(2); });
