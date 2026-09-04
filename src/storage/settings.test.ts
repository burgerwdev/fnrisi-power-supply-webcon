// storage/settings: defaults, merge, and chart-prefs round-trip (with a fake localStorage).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_CHART_PREFS,
  DEFAULT_SETTINGS,
  loadChartPrefs,
  loadSettings,
  saveChartPrefs,
  saveSettings,
} from './settings';

const mem: Record<string, string> = {};
const shim = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
} as unknown as Storage;

describe('storage/settings', () => {
  beforeEach(() => {
    Object.keys(mem).forEach((k) => delete mem[k]);
    globalThis.localStorage = shim;
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('returns defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(loadChartPrefs()).toEqual(DEFAULT_CHART_PREFS);
  });

  it('merges partial settings over defaults', () => {
    saveSettings({ ...DEFAULT_SETTINGS, theme: 'light', baud: 9600 });
    const s = loadSettings();
    expect(s.theme).toBe('light');
    expect(s.baud).toBe(9600);
    expect(s.language).toBe('zh'); // untouched default
  });

  it('round-trips chart prefs and clamps an empty visible list to the default', () => {
    saveChartPrefs({ visible: ['vout'], primary: 'iout', smooth: true, windowMs: 120000 });
    expect(loadChartPrefs()).toEqual({ visible: ['vout'], primary: 'iout', smooth: true, windowMs: 120000 });
    saveChartPrefs({ visible: [], primary: 'vout', smooth: false, windowMs: 60000 });
    // an empty visible list falls back to the default three channels
    expect(loadChartPrefs().visible).toEqual(DEFAULT_CHART_PREFS.visible);
  });
});
