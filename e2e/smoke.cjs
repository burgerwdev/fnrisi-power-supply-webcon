// Headless browser smoke test against the built app (no device required).
// Verifies page mounts, no uncaught errors, tabs work, theme toggles, safe UI present.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });

  const title = await page.title();
  const meterCount = await page.locator('#meters .meter').count();
  const chips = await page.locator('.app-footer').textContent();

  // theme toggle
  const themeBefore = await page.getAttribute('html', 'data-theme');
  await page.click('#btn-theme');
  const themeAfter = await page.getAttribute('html', 'data-theme');

  // tab navigation to every section (should not throw; record tab mounts canvas etc.)
  const vis = {};
  for (const tab of ['preset', 'sequence', 'scan', 'script', 'settings', 'meter']) {
    await page.click(`button[data-tab="${tab}"]`);
    await page.waitForTimeout(160);
    vis[tab] = await page.isVisible(`#tab-${tab}`);
  }
  // Recording is merged into the meter page: #curve-area is embedded in #tab-meter
  const curveHost = await page.locator('#tab-meter #curve-area').count();
  const rcStart = await page.locator('#tab-meter #rc-start').count();
  const rcCanvas = await page.locator('#tab-meter canvas').count();
  const recordVisible = curveHost > 0 && rcStart > 0 && rcCanvas > 0;
  const scriptHasRunBtn = (await page.locator('#tab-script button', { hasText: '运行' }).count()) > 0;
  const settingsHasRecipes = (await page.locator('#tab-settings', { hasText: '配置管理' }).count()) > 0;
  const sessionsText = await page.locator('#curve-area').textContent();

  const out = {
    tabVisibility: vis,
    recordMergedIntoMeter: recordVisible,
    title,
    meterCount,
    chips: chips?.trim().slice(0, 80),
    theme: `${themeBefore} -> ${themeAfter}`,
    scanVisible: vis.scan ?? false,
    scriptHasRunBtn,
    settingsHasRecipes,
    sessionsHasEmptyNote: sessionsText?.includes('暂无会话'),
    errors,
  };
  console.log('SMOKE_RESULT ' + JSON.stringify(out, null, 2));

  await page.screenshot({ path: '/tmp/dps150-smoke.png', fullPage: false });
  await browser.close();

  const failed = errors.length > 0 || meterCount < 6 || title.indexOf('DPS-150') < 0 || !recordVisible || !vis.scan;
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('SMOKE_CRASH', e);
  process.exit(2);
});
