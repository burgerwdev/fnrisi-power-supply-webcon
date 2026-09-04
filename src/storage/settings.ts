// localStorage-backed app configuration and recipes with safe, undo-friendly access.
// Recipes: JSON bundles of {presets, protections, brightness, ...}. Stored under one key;
// destructive ops require explicit confirm at the UI layer, here we just keep an undo slot.

export interface RecipeV1 {
  version: 1;
  name: string;
  updatedAt: string;
  presets: { voltage: number; current: number }[]; // M1..M6
  protections: { ovp: number; ocp: number; opp: number; otp: number; lvp: number };
  brightness?: number;
  volume?: number;
}

export interface AppSettings {
  baud: number;
  theme: 'dark' | 'light';
  language: 'zh' | 'en';
  /** default fastest sample rate = device push rate; samplePeriodMs > 0 overrides to slow down */
  samplePeriodMs: number; // 0 = every push (fastest)
  sessionCapPoints: number;
  confirmDanger: boolean; // extra confirmations for dangerous actions
  autoRunInterrupt: 'prompt' | 'pause' | 'stop'; // device issue during auto run
  lastRecipeName?: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baud: 115200,
  theme: 'dark',
  language: 'zh',
  samplePeriodMs: 0,
  sessionCapPoints: 200000,
  confirmDanger: true,
  autoRunInterrupt: 'pause',
};

const KEY = 'dps150.settings.v1';
const RECIPES_KEY = 'dps150.recipes.v1';
const UNDO_KEY = 'dps150.recipe.undo';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function defaultRecipe(name = 'default'): RecipeV1 {
  return {
    version: 1,
    name,
    updatedAt: new Date().toISOString(),
    presets: Array.from({ length: 6 }, () => ({ voltage: 5.0, current: 1.0 })),
    protections: { ovp: 31.0, ocp: 5.1, opp: 155.0, otp: 80, lvp: 4.8 },
    brightness: 10,
    volume: 2,
  };
}

export function listRecipes(): { name: string; updatedAt: string }[] {
  try {
    const raw = localStorage.getItem(RECIPES_KEY);
    if (!raw) return [];
    const all = JSON.parse(raw) as Record<string, RecipeV1>;
    return Object.entries(all).map(([name, r]) => ({ name, updatedAt: r.updatedAt }));
  } catch {
    return [];
  }
}

export function getRecipe(name: string): RecipeV1 | null {
  try {
    const all = JSON.parse(localStorage.getItem(RECIPES_KEY) ?? '{}') as Record<string, RecipeV1>;
    return all[name] ?? null;
  } catch {
    return null;
  }
}

/** saves a recipe; pushes previous content into an undo slot (single-level undo) */
export function putRecipe(recipe: RecipeV1): void {
  try {
    const all = JSON.parse(localStorage.getItem(RECIPES_KEY) ?? '{}') as Record<string, RecipeV1>;
    const prev = all[recipe.name];
    if (prev) localStorage.setItem(UNDO_KEY, JSON.stringify(prev));
    all[recipe.name] = { ...recipe, updatedAt: new Date().toISOString() };
    localStorage.setItem(RECIPES_KEY, JSON.stringify(all));
  } catch (err) {
    console.warn('putRecipe failed', err);
  }
}

export function deleteRecipe(name: string): RecipeV1 | null {
  try {
    const all = JSON.parse(localStorage.getItem(RECIPES_KEY) ?? '{}') as Record<string, RecipeV1>;
    const prev = all[name];
    if (!prev) return null;
    localStorage.setItem(UNDO_KEY, JSON.stringify(prev));
    delete all[name];
    localStorage.setItem(RECIPES_KEY, JSON.stringify(all));
    return prev;
  } catch {
    return null;
  }
}

/** restore last overwritten/deleted recipe (name collision-safe: keeps original name if free) */
export function undoRecipeOp(): RecipeV1 | null {
  try {
    const raw = localStorage.getItem(UNDO_KEY);
    if (!raw) return null;
    const recipe = JSON.parse(raw) as RecipeV1;
    const all = JSON.parse(localStorage.getItem(RECIPES_KEY) ?? '{}') as Record<string, RecipeV1>;
    if (!all[recipe.name]) all[recipe.name] = recipe;
    else {
      // keep original and store restored copy with suffix
      let n = recipe.name;
      let i = 2;
      while (all[n]) n = `${recipe.name} (restored ${i++})`;
      all[n] = { ...recipe, name: n };
    }
    localStorage.setItem(RECIPES_KEY, JSON.stringify(all));
    localStorage.removeItem(UNDO_KEY);
    return recipe;
  } catch {
    return null;
  }
}

export interface TransportPrefs {
  mode: 'usb' | 'ws';
  wsUrl: string;
}

export function loadTransportPrefs(): TransportPrefs {
  const d: TransportPrefs = { mode: 'usb', wsUrl: 'ws://127.0.0.1:8787' };
  try {
    const raw = localStorage.getItem('dps150.transport.v1');
    if (raw) Object.assign(d, JSON.parse(raw) as Partial<TransportPrefs>);
  } catch {
    /* ignore */
  }
  // URL params take precedence (backward-compatible)
  const params = new URLSearchParams(location.search);
  const proxy = params.get('proxy');
  if (proxy) {
    d.mode = 'ws';
    d.wsUrl = proxy;
  }
  return d;
}

export function saveTransportPrefs(p: TransportPrefs): void {
  try {
    localStorage.setItem('dps150.transport.v1', JSON.stringify({ mode: p.mode, wsUrl: p.wsUrl }));
  } catch {
    /* ignore */
  }
}

// -------- chart prefs (curve visibility / primary series / smoothing / window) — remembered, still effective after reload --------
export interface ChartPrefs {
  visible: string[]; // displayed series ids
  primary: string; // emphasized / primary-axis series id
  smooth: boolean;
  windowMs: number;
}

export const DEFAULT_CHART_PREFS: ChartPrefs = {
  visible: ['vout', 'iout', 'pout'], // default shows only the three output channels; vin/temp can be enabled manually (avoids the range being raised by temperature/input voltage)
  primary: 'vout',
  smooth: false,
  windowMs: 60_000,
};

const CHART_KEY = 'dps150.chart.v1';

export function loadChartPrefs(): ChartPrefs {
  try {
    const raw = localStorage.getItem(CHART_KEY);
    if (!raw) return { ...DEFAULT_CHART_PREFS };
    const p = JSON.parse(raw) as Partial<ChartPrefs>;
    return { ...DEFAULT_CHART_PREFS, ...p, visible: Array.isArray(p.visible) && p.visible.length ? p.visible : [...DEFAULT_CHART_PREFS.visible] };
  } catch {
    return { ...DEFAULT_CHART_PREFS };
  }
}

export function saveChartPrefs(p: ChartPrefs): void {
  try {
    localStorage.setItem(CHART_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export { KEY as SETTINGS_KEY, RECIPES_KEY, UNDO_KEY };
