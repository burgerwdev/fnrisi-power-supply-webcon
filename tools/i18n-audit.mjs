// Static i18n audit: scan src for CJK string literals that are NOT in the i18n
// dictionary (src/i18n.ts). These are strings that would remain Chinese in the
// English UI — mostly content/diagnostic text (log messages, DSL keywords, editor
// examples) rather than UI labels. Reported as an informational metric.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'docs', 'i18n-audit.json');

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const cjk = /[\u4e00-\u9fff]/;
const findings = [];
const dict = new Set();
const isTest = (rel) => /\.test\.ts$/.test(rel) || /\.spec\.ts$/.test(rel);
// the dictionary file itself is the source of truth; skip it, test files, and data-only files
for (const f of walk(SRC)) {
  if (!/\.ts$/.test(f)) continue;
  const rel = f.slice(ROOT.length);
  if (rel.endsWith('i18n.ts') || isTest(rel)) continue;
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/['"`]([^'"`]*)['"`]/g)) {
      if (cjk.test(m[1])) {
        findings.push({ file: rel.slice(1), line: i + 1, text: m[1].slice(0, 80) });
      }
    }
  });
}

// Also verify every key used via t('...') exists in the dictionary (a real bug detector).
const tUses = [];
for (const f of walk(SRC)) {
  if (!/\.ts$/.test(f)) continue;
  const rel = f.slice(ROOT.length);
  if (rel.endsWith('i18n.ts') || isTest(rel)) continue;
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\bt\(['"]([A-Za-z0-9_.]+)['"]\)/g)) tUses.push({ file: rel.slice(1), line: i + 1, key: m[1] });
  });
}

const result = {
  generatedAt: new Date().toISOString(),
  hardcodedCjk: { count: findings.length, byFile: {} },
  missingTKeys: [],
};
for (const f of findings) {
  result.hardcodedCjk.byFile[f.file] = (result.hardcodedCjk.byFile[f.file] || 0) + 1;
}

// Read the dictionary keys (zh/en entries) to validate t() usage
const dictText = readFileSync(join(SRC, 'i18n.ts'), 'utf8');
const used = new Set([...dictText.matchAll(/'([A-Za-z0-9_.]+)':\s*\{/g)].map((m) => m[1]));
const seen = new Set();
for (const u of tUses) {
  if (!used.has(u.key) && !seen.has(u.key)) {
    seen.add(u.key);
    result.missingTKeys.push({ key: u.key, file: u.file, line: u.line });
  }
}

writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log('I18N_AUDIT ' + JSON.stringify({ hardcodedCjk: result.hardcodedCjk.count, missingTKeys: result.missingTKeys.length }));
// exit 0 = informational
