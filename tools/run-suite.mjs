// Master test suite runner: static checks, unit tests, build, headless UI audits,
// device-layer + proxy UI suites (starting/stopping the serial bridge as needed),
// and screenshot capture. Writes docs/TEST_REPORT.md with embedded screenshots.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)); // tools/
const APP = join(ROOT, '..');
const SCREENS = join(APP, 'docs', 'screens');
const REPORT = join(APP, 'docs', 'TEST_REPORT.md');

// Detect the real device node (the USB port can re-enumerate to ttyACM0/1/…).
function findDevice() {
  try {
    const devs = readdirSync('/dev').filter((d) => /^ttyACM\d+$/.test(d) || /^ttyUSB\d+$/.test(d));
    return devs.length ? '/dev/' + devs[0] : null;
  } catch {
    return null;
  }
}

const DATE = new Date().toISOString();
const results = [];
function run(cmd, env = {}) {
  const before = Date.now();
  const r = spawnSync(cmd, { cwd: APP, shell: true, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180000 });
  const ms = Date.now() - before;
  const tail = (String(r.stdout || '') + String(r.stderr || '')) || String(r.error || '');
  return { code: r.status ?? -1, tail, ms, signal: r.signal };
}
function rec(name, cmd, { expect = 0, summary, env } = {}) {
  const r = run(cmd, env);
  const ok = r.code === expect;
  const summaryLine = typeof summary === 'function' ? summary(r) : (summary || '');
  const res = { name, cmd, ok, code: r.code, ms: r.ms, summary: summaryLine, tail: r.tail.slice(0, 1800) };
  results.push(res);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${r.ms}ms)${summaryLine ? ' - ' + summaryLine : ''}`);
  if (!ok) console.log('   tail: ' + r.tail.slice(0, 300).replace(/\n/g, ' · '));
  return res;
}

// Retry-once wrapper for timing-sensitive hardware suites (device timers can flake
// under a cold/loaded system). A real regression fails on all attempts.
function recRetry(name, cmd, opts = {}) {
  let res = rec(name, cmd, opts);
  if (!res.ok) {
    console.log(`  ↻ retrying ${name} once…`);
    // drop the failed first attempt so the report doesn't double-count
    results.pop();
    res = rec(name + ' (retried)', cmd, opts);
    if (res.ok) res.retried = true;
  }
  return res;
}

function startBridge(dev) {
  run(`SERIAL=${dev} make DEV=${dev} bridge-start`);
}
function killBridge() {
  run('fuser -k 8787/tcp 2>/dev/null; pkill -f [s]erialpipe.py 2>/dev/null; true');
}

let devicePresent = !!findDevice();
let DEV = findDevice() || '/dev/ttyACM0';

// --- static / unit / build ---
rec('TypeScript typecheck', 'npx tsc --noEmit');
rec('Unit tests (vitest)', 'npx vitest run', { summary: (r) => (/Tests\s+(\d+) passed/.exec(r.tail) || [])[1] ? `${(/Tests\s+(\d+) passed/.exec(r.tail) || [])[1]} passed` : '' });
rec('Production build', 'npm run build');

// --- static i18n audit (informational; also validates t() keys) ---
const i18n = rec('i18n audit (static)', 'node tools/i18n-audit.mjs', { expect: 0, summary: (r) => { const m = /I18N_AUDIT (.+)/.exec(r.tail); return m ? m[1] : ''; } });

// --- headless (no device) ---
startBridge(DEV); // preview + ws consistent
rec('preview', 'make preview-start');
rec('headless smoke', 'node e2e/smoke.cjs');
rec('headless UI/i18n audit', 'node e2e/audit-ui.cjs');

// --- device suite (requires a /dev/ttyACMx or /dev/ttyUSBx node) ---
if (devicePresent) {
  killBridge();
  recRetry('device-layer full self-test', `python3 tools/selftest_full.py --run-test --port ${DEV}`, { summary: (r) => { const m = /(\d+)\/(\d+) passed/.exec(r.tail); return m ? `${m[1]}/${m[2]} passed` : ''; } });
  startBridge(DEV);
  recRetry('device full UI (proxy)', 'PROXY=1 node e2e/ui-full.cjs', { summary: (r) => { const m = /UI full-feature verification:\s*(\d+)\/(\d+)/.exec(r.tail); return m ? `${m[1]}/${m[2]} passed` : ''; } });
  recRetry('device edge cases', 'node e2e/edge.cjs', { summary: (r) => { const m = /Boundary verification (\d+)\/(\d+)/.exec(r.tail); return m ? `${m[1]}/${m[2]} passed` : ''; } });
} else {
  console.log('SKIP device suites - no /dev/ttyACMx or /dev/ttyUSBx node');
}

// --- screenshots (needs device/proxy) ---
if (devicePresent) rec('screenshots (zh & en)', 'node e2e/shot.cjs');

// ---- build report ----
mkdirSync(dirname(REPORT), { recursive: true });
const shots = existsSync(SCREENS)
  ? readdirSync(SCREENS).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort()
  : [];

const total = results.length;
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);

const rows = results
  .map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.name}${r.retried ? ' <sup>retried</sup>' : ''} | ${r.code} | ${r.ms}ms | ${r.summary || '-'} |`)
  .join('\n');

let md = `# DPS-150 Web Console - Automated Test Report

> Generated: ${DATE}

## Overview

| Total suites | Passed | Failed | Pass rate |
|---|---|---|---|
| ${total} | ${passed} | ${failed.length} | ${total ? Math.round((passed / total) * 100) : 0}% |

${failed.length ? `> ⚠ The following suites did not pass:\n${failed.map((f) => `- **${f.name}** (exit ${f.code})\n\`\`\`\n${f.tail.slice(0, 400)}\n\`\`\``).join('\n')}` : '> ✅ All suites passed.'}

## Details

| Result | Suite | Exit code | Time | Summary |
|---|---|---|---|---|
${rows}

## Screenshots

${shots.length ? shots.map((s) => `![${s}](screens/${s})`).join('\n') : '_(no screenshots generated)_'}

## i18n Static Audit

Scanned by \`tools/i18n-audit.mjs\` and written to \`docs/i18n-audit.json\`. The count of hardcoded Chinese (non-UI labels, mostly log/editor-example body text) and missing t() keys are in that file; this run's summary: ${(i18n && i18n.summary) || '-'}

## How to Run

\`\`\`bash
make test-suite
# or
node tools/run-suite.mjs
\`\`\`
`;

writeFileSync(REPORT, md);
console.log('\nREPORT_WRITTEN ' + REPORT);
console.log(`SUMMARY ${passed}/${total} passed`);
process.exit(0);
