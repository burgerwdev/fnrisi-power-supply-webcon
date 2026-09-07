// Command DSL for the DPS-150 scripting area — line-based, learnable, with
// variables, loops/conditionals, and safe access to common JS functions.
// Grammar (case-insensitive; '#' or REM starts a comment):
//   LET name = <js-expr>      variable/expression evaluation (can call Math/RegExp/string/array methods etc.)
//   SET V 12.5 | SET A 0.5 | SET V A 12.5 0.5   set voltage/current (params can be variables or expressions)
//   OUT ON | OFF
//   WAIT 1.5 | WAIT 800ms
//   SAVE M3 5.0 1.0 | LOAD M3
//   PROT OVP 25 | BRIGHT 10 | VOL 3 | METER ON | OFF | SNAP
//   PRINT any text | ECHO <js-expr>   print
//   IF <cond> ... ELSE ... END | FOR i = a TO b [STEP s] ... NEXT | WHILE <cond> ... END
//   BREAK | CONTINUE
// Safety: expressions are evaluated in a restricted sandbox (window/document/eval/constructor etc. are banned),
// with caps on instruction count, single-loop iterations and total runtime, preventing infinite loops/hangs.
import type { Dps150Api, ProtectionKind } from '../api/facade';
import { t } from '../i18n';
import {
  checkConnected,
  checkCurrent,
  checkDelayMs,
  checkPresetValue,
  checkProtection,
  checkVoltage,
  type Check,
  type LimitCtx,
} from './validators';

/** Numeric param: number literal or expression/variable (evaluated at runtime) */
export type Valu = number | string;

export type Op =
  | { kind: 'setV'; v: Valu }
  | { kind: 'setA'; a: Valu }
  | { kind: 'setVA'; v: Valu; a: Valu }
  | { kind: 'out'; on: boolean }
  | { kind: 'wait'; ms: Valu }
  | { kind: 'save'; m: number; v: Valu; a: Valu }
  | { kind: 'load'; m: number }
  | { kind: 'prot'; which: ProtectionKind; v: Valu }
  | { kind: 'bright'; v: Valu }
  | { kind: 'vol'; v: Valu }
  | { kind: 'meter'; on: boolean }
  | { kind: 'snap' }
  | { kind: 'print'; text: string }
  | { kind: 'let'; name: string; expr: string }
  | { kind: 'echo'; expr: string }
  | { kind: 'if'; cond: string; then: DslLine[]; else?: DslLine[] }
  | { kind: 'for'; var: string; from: Valu; to: Valu; step: Valu; body: DslLine[] }
  | { kind: 'while'; cond: string; body: DslLine[] }
  | { kind: 'break' }
  | { kind: 'continue' };

export interface DslLine {
  line: number; // 1-based
  raw: string;
  op: Op;
}

export interface DslError {
  line: number;
  msg: string;
}

const PROT: Record<string, ProtectionKind> = { OVP: 'ovp', OCP: 'ocp', OPP: 'opp', OTP: 'otp', LVP: 'lvp' };

/** Numeric literal → number; otherwise treated as expression/variable (string, evaluated at runtime). */
function valu(s: string): Valu {
  const t = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);
  return t;
}

// ---------- restricted expression sandbox ----------
// Only whitelisted globals are accessible; any other name throws. Using Proxy + with, undefined identifiers
// cannot escape to global (has always true); a cache avoids recompiling the same expression (frequent loop evaluation stays fast).
const ALLOWED = new Set(['Math', 'Number', 'String', 'Boolean', 'Array', 'JSON', 'RegExp', 'Object', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'Date', 'Infinity', 'NaN', 'undefined']);
const DENY = /(?:constructor|prototype|__proto__|import\s*\(|\brequire\b|\bprocess\b|\bglobalThis\b|\bwindow\b|\bdocument\b|\bglobal\b|\bfetch\b|\bXMLHttpRequest\b|`|\beval\b|\bFunction\b|\bthis\b|;)/i;
const evalCache = new Map<string, (...a: unknown[]) => unknown>();
function compileEval(expr: string): (...a: unknown[]) => unknown {
  let f = evalCache.get(expr);
  if (!f) {
    f = new Function('__p', `with(__p){ return (${expr}); }`) as (...a: unknown[]) => unknown;
    evalCache.set(expr, f);
  }
  return f;
}
const sandboxProxy = (scope: ReadonlyMap<string, unknown>): unknown =>
  new Proxy(Object.create(null), {
    has: (_t, k) => typeof k !== 'symbol',
    get: (_t, k): unknown => {
      if (typeof k !== 'string') return undefined; // symbol keys (internal probes) are not intercepted; let default behavior handle them
      if (ALLOWED.has(k)) return (globalThis as Record<string, unknown>)[k];
      if (scope.has(k)) return scope.get(k);
      throw new Error(t('dsl.undefinedName').replace('{name}', k));
    },
    set: () => {
      throw new Error(t('dsl.assignDenied'));
    },
  });

/** Evaluate an expression in a restricted sandbox; scope is the variable map. Throwing means the expression is illegal. */
export function safeEval(expr: string, scope: ReadonlyMap<string, unknown>): unknown {
  const e = String(expr).trim();
  if (!e) throw new Error(t('dsl.exprEmpty'));
  if (e.length > 500) throw new Error(t('dsl.exprLong'));
  if (DENY.test(e)) throw new Error(t('dsl.exprDenied'));
  return compileEval(e)(sandboxProxy(scope));
}

// ---------- run guards: prevent infinite loops/hangs ----------
const MAX_STEPS = 2000000; // total instruction-step limit
const MAX_LOOP = 1000000; // single-loop iteration limit
const MAX_RUNTIME_MS = 20000; // total runtime limit
export class DslRuntimeError extends Error {}

interface Budget {
  steps: number;
  loops: number;
  start: number;
}
function step(b: Budget, abort: () => boolean): void {
  if (abort()) throw new DslRuntimeError(t('dsl.userStop'));
  b.steps++;
  if (b.steps > MAX_STEPS) throw new DslRuntimeError(t('dsl.stepsLimit').replace('{n}', String(MAX_STEPS)));
  if (Date.now() - b.start > MAX_RUNTIME_MS) throw new DslRuntimeError(t('dsl.timeLimit').replace('{s}', String(MAX_RUNTIME_MS / 1000)));
}
function loopTick(b: Budget): void {
  b.loops++;
  if (b.loops > MAX_LOOP) throw new DslRuntimeError(t('dsl.loopLimit'));
  step(b, () => false);
}

/** Get a numeric param: a number is returned directly, a string is sandbox-evaluated then converted to number. */
function numVal(v: Valu, scope: ReadonlyMap<string, unknown>): number {
  if (typeof v === 'number') return v;
  const r = safeEval(v, scope);
  const n = Number(r);
  if (!Number.isFinite(n)) throw new DslRuntimeError(t('dsl.notNumber').replace('{expr}', v).replace('{val}', String(r)));
  return n;
}
function boolVal(expr: string, scope: ReadonlyMap<string, unknown>): boolean {
  return Boolean(safeEval(expr, scope));
}

// ================= parse =================
interface Frame {
  type: 'if' | 'for' | 'while';
  op: Op;
  target: DslLine[];
}

const KW = new Set(['LET', 'IF', 'ELSE', 'END', 'ENDIF', 'FOR', 'NEXT', 'WHILE', 'BREAK', 'CONTINUE', 'ECHO', 'SET', 'OUT', 'WAIT', 'SAVE', 'LOAD', 'PROT', 'BRIGHT', 'VOL', 'METER', 'SNAP', 'PRINT']);

/** Parse script text into a flat top-level line list (blocks are nested inside their op). */
export function parseDsl(code: string): { lines: DslLine[]; errors: DslError[] } {
  const root: DslLine[] = [];
  const errors: DslError[] = [];
  const stack: Frame[] = [];
  const cur = (): DslLine[] => (stack.length ? stack[stack.length - 1].target : root);
  const push = (line: number, raw: string, op: Op): void => {
    cur().push({ line, raw, op });
  };
  const rawLines = code.split(/\r?\n/);
  rawLines.forEach((raw, idx) => {
    const line = idx + 1;
    const noComment = raw.replace(/(^|\s)#.*$/, '').replace(/^\s*REM\s+/i, '').trim();
    if (!noComment) return;
    const ly = noComment.replace(/\s+/g, ' ').trim();
    const parts = ly.split(' ');
    const p0 = parts[0].toUpperCase();
    try {
      // ---- control flow ----
      if (p0 === 'LET') {
        const m = ly.match(/^LET\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/i);
        if (!m) { errors.push({ line, msg: t('dsl.letUsage') }); return; }
        push(line, raw, { kind: 'let', name: m[1], expr: m[2].trim() });
        return;
      }
      if (p0 === 'IF') {
        const cond = ly.slice(2).trim();
        if (!cond) { errors.push({ line, msg: t('dsl.ifCond') }); return; }
        const op = { kind: 'if' as const, cond, then: [] as DslLine[] };
        push(line, raw, op);
        stack.push({ type: 'if', op, target: op.then });
        return;
      }
      if (p0 === 'ELSE') {
        const f = stack[stack.length - 1];
        if (!f || f.type !== 'if') { errors.push({ line, msg: t('dsl.elseNoMatch') }); return; }
        const op = f.op as Extract<Op, { kind: 'if' }>;
        op.else = [];
        f.target = op.else;
        return;
      }
      if (p0 === 'END' || p0 === 'ENDIF') {
        const f = stack.pop();
        if (!f) { errors.push({ line, msg: t('dsl.endNoMatch').replace('{p}', p0) }); return; }
        if (p0 === 'ENDIF' && f.type !== 'if') errors.push({ line, msg: t('dsl.endifOnlyIf') });
        return;
      }
      if (p0 === 'FOR') {
        const m = ly.match(/^FOR\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?)\s+TO\s+(.+?)(?:\s+STEP\s+(.+))?$/i);
        if (!m) { errors.push({ line, msg: t('dsl.forUsage') }); return; }
        const op = { kind: 'for' as const, var: m[1], from: valu(m[2]), to: valu(m[3]), step: valu(m[4] ?? '1'), body: [] as DslLine[] };
        push(line, raw, op);
        stack.push({ type: 'for', op, target: op.body });
        return;
      }
      if (p0 === 'NEXT') {
        const f = stack.pop();
        if (!f || f.type !== 'for') { errors.push({ line, msg: t('dsl.nextNoMatch') }); return; }
        return;
      }
      if (p0 === 'WHILE') {
        const cond = ly.slice(5).trim();
        if (!cond) { errors.push({ line, msg: t('dsl.whileCond') }); return; }
        const op = { kind: 'while' as const, cond, body: [] as DslLine[] };
        push(line, raw, op);
        stack.push({ type: 'while', op, target: op.body });
        return;
      }
      if (p0 === 'BREAK' || p0 === 'CONTINUE') {
        push(line, raw, { kind: p0.toLowerCase() as 'break' | 'continue' });
        return;
      }
      if (!([...KW].includes(p0))) {
        errors.push({ line, msg: t('dsl.unknownCmd').replace('{p}', p0) });
        return;
      }
      if (p0 === 'ECHO') {
        push(line, raw, { kind: 'echo', expr: ly.slice(4).trim() });
        return;
      }
      // ---- device commands ----
      if (p0 === 'SET') {
        const what = parts[1]?.toUpperCase();
        if (what === 'V' && parts[2]?.toUpperCase() === 'A' && parts.length >= 4) {
          // SET V A <V> <A>: V/A each is one token (for expressions with spaces, use SET V / SET A separately)
          push(line, raw, { kind: 'setVA', v: valu(parts[3]), a: valu(parts.slice(4).join(' ')) });
        } else if (what === 'V') {
          push(line, raw, { kind: 'setV', v: valu(parts.slice(2).join(' ')) });
        } else if (what === 'A') {
          push(line, raw, { kind: 'setA', a: valu(parts.slice(2).join(' ')) });
        } else {
          errors.push({ line, msg: t('dsl.setUsage') });
        }
        return;
      }
      if (p0 === 'OUT') {
        const on = parts[1]?.toUpperCase();
        if (on === 'ON' || on === 'OFF') push(line, raw, { kind: 'out', on: on === 'ON' });
        else errors.push({ line, msg: t('dsl.outUsage') });
        return;
      }
      if (p0 === 'WAIT') {
        const v = parts[1];
        if (v === undefined) { errors.push({ line, msg: t('dsl.waitUsage') }); return; }
        if (/ms$/i.test(v)) {
          // explicit milliseconds
          push(line, raw, { kind: 'wait', ms: valu(v.replace(/ms$/i, '')) });
        } else {
          // numeric literal treated as seconds; expression/variable treated as ms (see executor/HELP)
          const val = valu(v);
          push(line, raw, { kind: 'wait', ms: typeof val === 'number' ? val * 1000 : val });
        }
        return;
      }
      if (p0 === 'SAVE' || p0 === 'LOAD') {
        const m = parts[1]?.toUpperCase().replace('M', '');
        const mi = m ? parseInt(m, 10) : NaN;
        if (!Number.isFinite(mi) || mi < 1 || mi > 6) { errors.push({ line, msg: t('dsl.saveLoadUsage').replace('{p}', p0) }); return; }
        if (p0 === 'LOAD') push(line, raw, { kind: 'load', m: mi });
        else push(line, raw, { kind: 'save', m: mi, v: valu(parts[2]), a: valu(parts.slice(3).join(' ')) });
        return;
      }
      if (p0 === 'PROT') {
        const which = (parts[1] || '').toUpperCase();
        if (!(which in PROT)) { errors.push({ line, msg: t('dsl.protUsage') }); return; }
        push(line, raw, { kind: 'prot', which: PROT[which], v: valu(parts.slice(2).join(' ')) });
        return;
      }
      if (p0 === 'BRIGHT' || p0 === 'VOL') {
        push(line, raw, p0 === 'BRIGHT' ? { kind: 'bright', v: valu(parts.slice(1).join(' ')) } : { kind: 'vol', v: valu(parts.slice(1).join(' ')) });
        return;
      }
      if (p0 === 'METER') {
        const on = parts[1]?.toUpperCase();
        if (on === 'ON' || on === 'OFF') push(line, raw, { kind: 'meter', on: on === 'ON' });
        else errors.push({ line, msg: t('dsl.meterUsage') });
        return;
      }
      if (p0 === 'SNAP') { push(line, raw, { kind: 'snap' }); return; }
      if (p0 === 'PRINT') { push(line, raw, { kind: 'print', text: ly.slice('PRINT'.length).trim() }); return; }
    } catch (e) {
      errors.push({ line, msg: t('dsl.parseError').replace('{e}', (e as Error).message) });
    }
  });
  if (stack.length) {
    for (const f of stack) errors.push({ line: 0, msg: t('dsl.blockUnclosed').replace('{b}', f.type === 'for' ? 'FOR needs NEXT' : f.type === 'while' ? 'WHILE needs END' : 'IF needs END') });
  }
  return { lines: root, errors };
}

export function previewDsl(code: string): string {
  const { lines, errors } = parseDsl(code);
  if (errors.length) return errors.map((e) => (e.line ? t('log.linePrefix').replace('{n}', String(e.line)) + ': ' + e.msg : e.msg)).join('\n');
  return lines.map((l) => `L${l.line}  ${l.raw.trim()}`).join('\n');
}

export const DSL_HELP = t('dsl.help');

export interface DslSample {
  name: string;
  code: string;
  danger?: boolean;
}

export const DSL_SAMPLES: DslSample[] = [
  {
    name: t('dsl.s1.name'),
    code: `# ${t('dsl.s1.c1')}
SET V A 1.0 0.05
WAIT 0.3
SNAP
PRINT ${t('dsl.s1.p1')}`,
  },
  {
    name: t('dsl.s2.name'),
    danger: true,
    code: `# ${t('dsl.s2.c1')}
LET base = 0.5
OUT ON
FOR i = 0 TO 2
  LET v = base + i*0.5
  SET V v
  SET A 0.05
  WAIT 800ms
NEXT
OUT OFF
PRINT ${t('dsl.s2.p1')}`,
  },
  {
    name: t('dsl.s3.name'),
    code: `# ${t('dsl.s3.c1')}
LET x = Math.sqrt(16)
IF x >= 4
  ECHO "sqrt(16)=" + x + ",${t('dsl.s3.printOk')}"
ELSE
  PRINT x ${t('dsl.s3.printSmall')}
END
LET m = "v=1.00".match(/\\d+\\.\\d+/)
ECHO "regex:" + m`,
  },
  {
    name: t('dsl.s4.name'),
    code: `# ${t('dsl.s4.c1')}
SAVE M1 5.0 1.0
SNAP
PRINT ${t('dsl.s4.p1')}`,
  },
  {
    name: t('dsl.s5.name'),
    code: `# ${t('dsl.s5.c1')}
SNAP
ECHO "vout=" + vout + " iout=" + iout
ECHO "setv=" + setv + " seta=" + seta
ECHO "state.vin=" + state.telemetry.inputVoltage`,
  },
];

/** Validate literal values before running (check syntax with parseDsl first). Returns error/warn checks.
 *  Only statically-detectable literals are validated; expression/variable params are clamped by the device at runtime. */
export function validateDsl(lines: DslLine[], ctx: LimitCtx): { errors: Check[]; warnings: Check[] } {
  const errors: Check[] = [];
  const warnings: Check[] = [];
  errors.push(...checkConnected(ctx));
  const at = (line: number, raw: string) => (c: Check): void => {
    const box = c.level === 'error' ? errors : warnings;
    box.push({ ...c, msg: `${t('log.linePrefix').replace('{n}', String(line))} ${raw.trim()}: ${c.msg}` });
  };
  const walk = (nodes: DslLine[]): void => {
    for (const l of nodes) {
      const op = l.op;
      const a = at(l.line, l.raw);
      switch (op.kind) {
        case 'setV':
          if (typeof op.v === 'number') checkVoltage(op.v, ctx).forEach(a);
          break;
        case 'setA':
          if (typeof op.a === 'number') checkCurrent(op.a, ctx).forEach(a);
          break;
        case 'setVA':
          if (typeof op.v === 'number') checkVoltage(op.v, ctx).forEach(a);
          if (typeof op.a === 'number') checkCurrent(op.a, ctx).forEach(a);
          break;
        case 'wait':
          if (typeof op.ms === 'number') checkDelayMs(op.ms).forEach(a);
          break;
        case 'save':
          if (typeof op.v === 'number' && typeof op.a === 'number') checkPresetValue(op.v, op.a, ctx).forEach(a);
          break;
        case 'prot':
          if (typeof op.v === 'number') checkProtection(op.which, op.v).forEach(a);
          break;
        case 'bright':
          if (typeof op.v === 'number' && (op.v < 0 || op.v > 31)) a({ level: 'warn', msg: t('dsl.brightnessHint') });
          break;
        case 'vol':
          if (typeof op.v === 'number' && (op.v < 0 || op.v > 10)) a({ level: 'warn', msg: t('dsl.volumeHint') });
          break;
        case 'if':
          walk(op.then);
          if (op.else) walk(op.else);
          break;
        case 'for':
          walk(op.body);
          break;
        case 'while':
          walk(op.body);
          break;
        default:
          break;
      }
    }
  };
  walk(lines);
  return { errors, warnings };
}

// ================= execute =================
type RunResult = { ok: boolean; error?: string };

// Expose device state as script-readable readonly variables (state is a live object; the rest are convenience values refreshed on SNAP).
export function syncStateVars(scope: Map<string, unknown>, api: Dps150Api): void {
  const root = (api.state ?? ({} as unknown as Dps150Api['state'])) as Dps150Api['state'];
  const t = (root.telemetry ?? {}) as unknown as Record<string, unknown>;
  const s = (root.settings ?? {}) as unknown as Record<string, unknown>;
  const st = (root.status ?? {}) as unknown as Record<string, unknown>;
  scope.set('vout', t.outputVoltage);
  scope.set('iout', t.outputCurrent);
  scope.set('pout', t.outputPower);
  scope.set('vin', t.inputVoltage);
  scope.set('temp', t.temperature);
  scope.set('setv', s.voltageSet);
  scope.set('seta', s.currentSet);
  scope.set('mode', st.mode);
  scope.set('out', st.output);
  scope.set('state', api.state);
}

export async function executeDsl(
  lines: DslLine[],
  api: Dps150Api,
  log: (msg: string) => void,
  abort: () => boolean,
  echo?: (msg: string) => void,
): Promise<RunResult> {
  const budget: Budget = { steps: 0, loops: 0, start: Date.now() };
  const scope = new Map<string, unknown>();
  syncStateVars(scope, api);
  const lv = (v: Valu): number => numVal(v, scope);
  try {
    const signal = await runNodes(lines, { api, log, echo: echo ?? log, abort, budget, scope, lv });
    if (signal === 'break' || signal === 'continue') {
      return { ok: false, error: signal === 'break' ? t('dsl.breakOutside') : t('dsl.continueOutside') };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof DslRuntimeError) return { ok: false, error: e.message };
    return { ok: false, error: t('dsl.exprError').replace('{e}', (e as Error).message) };
  }
}

interface Ctx {
  api: Dps150Api;
  log: (msg: string) => void;
  echo: (msg: string) => void;
  abort: () => boolean;
  budget: Budget;
  scope: Map<string, unknown>;
  lv: (v: Valu) => number;
}

const isBreak = (s: string): boolean => s === 'break' || s === 'continue';

async function runNodes(nodes: DslLine[], c: Ctx): Promise<string> {
  for (const l of nodes) {
    step(c.budget, c.abort);
    const op = l.op;
    const ld = `L${l.line} `;
    switch (op.kind) {
      case 'setV':
        await c.api.setVoltage(c.lv(op.v));
        c.log(`${ld}SET V = ${c.lv(op.v)} V`);
        break;
      case 'setA':
        await c.api.setCurrent(c.lv(op.a));
        c.log(`${ld}SET A = ${c.lv(op.a)} A`);
        break;
      case 'setVA': {
        const v = c.lv(op.v);
        const a = c.lv(op.a);
        await c.api.setVoltage(v);
        await c.api.setCurrent(a);
        c.log(`${ld}SET V=${v} A=${a}`);
        break;
      }
      case 'out':
        await c.api.setOutput(op.on);
        c.log(`${ld}OUT ${op.on ? 'ON' : 'OFF'}`);
        break;
      case 'wait': {
        const ms = c.lv(op.ms);
        const until = Date.now() + ms;
        while (Date.now() < until) {
          if (c.abort()) throw new DslRuntimeError(t('dsl.userStop'));
          await new Promise((r) => setTimeout(r, 60));
        }
        break;
      }
      case 'save':
        await c.api.setPreset(op.m, c.lv(op.v), c.lv(op.a));
        c.log(`${ld}SAVE M${op.m} = ${c.lv(op.v)}V / ${c.lv(op.a)}A`);
        break;
      case 'load':
        await c.api.loadPreset(op.m);
        c.log(`${ld}${t('dsl.loadedToMain').replace('{m}', String(op.m))}`);
        break;
      case 'prot':
        await c.api.setProtection(op.which, c.lv(op.v));
        c.log(`${ld}PROT ${op.which.toUpperCase()} = ${c.lv(op.v)}`);
        break;
      case 'bright':
        await c.api.setBrightness(c.lv(op.v));
        c.log(`${ld}BRIGHT = ${c.lv(op.v)}`);
        break;
      case 'vol':
        await c.api.setVolume(c.lv(op.v));
        c.log(`${ld}VOL = ${c.lv(op.v)}`);
        break;
      case 'meter':
        await c.api.setMetering(op.on);
        c.log(`${ld}METER ${op.on ? 'ON' : 'OFF'}`);
        break;
      case 'snap':
        await c.api.refresh();
        c.log(`${ld}${t('dsl.snapDone')}`);
        syncStateVars(c.scope, c.api);
        break;
      case 'print':
        c.log(op.text);
        break;
      case 'let':
        c.scope.set(op.name, safeEval(op.expr, c.scope));
        break;
      case 'echo': {
        const r = safeEval(op.expr, c.scope);
        c.echo(String(r));
        break;
      }
      case 'if': {
        const t = boolVal(op.cond, c.scope);
        const { then, else: els } = op;
        const s = t ? await runNodes(then, c) : els ? await runNodes(els, c) : 'ok';
        if (isBreak(s)) return s;
        break;
      }
      case 'for': {
        const from = c.lv(op.from);
        const to = c.lv(op.to);
        const stepV = Math.abs(c.lv(op.step)) || 1;
        const sgn = from > to ? -1 : 1;
        for (let i = from; sgn > 0 ? i <= to : i >= to; i += sgn * stepV) {
          loopTick(c.budget);
          c.scope.set(op.var, i);
          const s = await runNodes(op.body, c);
          if (s === 'break') break;
          if (s === 'continue') continue;
        }
        break;
      }
      case 'while':
        while (boolVal(op.cond, c.scope)) {
          loopTick(c.budget);
          const s = await runNodes(op.body, c);
          if (s === 'break') break;
          if (s === 'continue') continue;
        }
        break;
      case 'break':
        return 'break';
      case 'continue':
        return 'continue';
    }
  }
  return 'ok';
}
