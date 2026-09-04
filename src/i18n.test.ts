// i18n: language-aware t(), fallback to key, and zh/en selection.
import { describe, expect, it } from 'vitest';

// Minimal localStorage stand-in (node env has no DOM/localStorage)
const mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = String(v);
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
} as unknown as Storage;

import { currentLang, setLang, t } from './i18n';

describe('i18n', () => {
  it('returns zh by default and en when language is en', () => {
    // clear stored lang -> default zh
    setLang('zh');
    expect(currentLang()).toBe('zh');
    expect(t('tab.meter')).toBe('仪表');
    setLang('en');
    expect(currentLang()).toBe('en');
    expect(t('tab.meter')).toBe('Meter');
  });

  it('falls back to the key for a missing translation', () => {
    expect(t('no.such.key')).toBe('no.such.key');
  });

  it('provides zh and en for chart and scan labels (used by new UI)', () => {
    setLang('en');
    expect(t('chart.vout')).toBe('Output V');
    expect(t('scan.fixedCurr')).toBe('Fixed current');
    expect(t('preset.quick')).toBe('Quick Presets');
    expect(t('lamp.connected')).toBe('Connected');
    setLang('zh');
    expect(t('scan.fixedCurr')).toBe('固定电流');
  });
});
