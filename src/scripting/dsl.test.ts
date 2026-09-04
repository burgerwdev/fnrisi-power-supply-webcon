import { describe, expect, it } from 'vitest';
import { DSL_HELP, DSL_SAMPLES, executeDsl, parseDsl, previewDsl, safeEval } from './dsl';
import type { Dps150Api } from '../api/facade';

describe('parseDsl', () => {
  it('parses basic commands with comments', () => {
    const code = `# 注释行
SET V A 12.5 0.5
SET A 0.3
WAIT 800ms
OUT ON
SAVE M3 5.0 1.0
PROT OVP 25
BRIGHT 10
SNAP
PRINT done`;
    const { lines, errors } = parseDsl(code);
    expect(errors).toEqual([]);
    const kinds = lines.map((l) => l.op.kind);
    expect(kinds).toEqual(['setVA', 'setA', 'wait', 'out', 'save', 'prot', 'bright', 'snap', 'print']);
    expect(lines[2].op).toEqual({ kind: 'wait', ms: 800 });
    expect(lines[4].op).toEqual({ kind: 'save', m: 3, v: 5.0, a: 1.0 });
  });

  it('supports REM comments and WAIT in seconds', () => {
    const { lines } = parseDsl('REM 说明\nWAIT 1.5');
    expect(lines.map((l) => l.op.kind)).toEqual(['wait']);
    expect((lines[0].op as { ms: number }).ms).toBe(1500);
  });

  it('reports errors with line numbers', () => {
    const { errors } = parseDsl('SET\nFROB 1\nOUT MAYBE');
    expect(errors.map((e) => e.line)).toEqual([1, 2, 3]);
    expect(errors[1].msg).toContain('未知指令');
  });

  it('parses variables, loops, conditions and expressions', () => {
    const code = `LET x = 1 + 2
IF x > 2
  ECHO x
ELSE
  PRINT no
END
FOR i = 0 TO 3 STEP 1
  SET V i
NEXT
WHILE x < 5
  LET x = x + 1
END`;
    const { lines, errors } = parseDsl(code);
    expect(errors).toEqual([]);
    const kinds = lines.map((l) => l.op.kind);
    expect(kinds).toEqual(['let', 'if', 'for', 'while']);
    const ifOp = lines[1].op as { kind: 'if'; then: { op: { kind: string } }[]; else: { op: { kind: string } }[] };
    expect(ifOp.then[0].op.kind).toBe('echo');
    expect(ifOp.else![0].op.kind).toBe('print');
  });

  it('reports unclosed blocks', () => {
    const { errors } = parseDsl('IF x > 1\nPRINT a\nLOOP');
    expect(errors.some((e) => e.msg.includes('块未闭合'))).toBe(true);
  });

  it('treats SET V A as a variable expression', () => {
    const { lines, errors } = parseDsl('SET V A\nSET V A 1 2');
    expect(errors).toEqual([]);
    expect((lines[0].op as { v: unknown }).v).toBe('A');
    expect((lines[1].op as { v: unknown; a: unknown }).v).toBe(1);
  });

  it('preview is readable and sample scripts all parse cleanly', () => {
    for (const s of DSL_SAMPLES) {
      const { errors } = parseDsl(s.code);
      expect(errors, s.name).toEqual([]);
    }
    expect(DSL_HELP.length).toBeGreaterThan(100);
    expect(previewDsl('SET V 5\n# c\nOUT OFF')).toContain('L1');
  });
});

describe('executeDsl', () => {
  it('runs commands against a fake api in order', async () => {
    const calls: string[] = [];
    const api = {
      setVoltage: async (v: number) => calls.push(`v${v}`),
      setCurrent: async (a: number) => calls.push(`a${a}`),
      setOutput: async (on: boolean) => calls.push(`out${on}`),
      setPreset: async () => calls.push('preset'),
      loadPreset: async () => calls.push('load'),
      setProtection: async () => calls.push('prot'),
      setBrightness: async () => calls.push('bri'),
      setVolume: async () => calls.push('vol'),
      setMetering: async () => calls.push('meter'),
      refresh: async () => calls.push('snap'),
    } as unknown as Dps150Api;
    const { lines } = parseDsl('SET V A 3.3 0.2\nOUT ON\nSNAP');
    const r = await executeDsl(lines, api, () => {}, () => false);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['v3.3', 'a0.2', 'outtrue', 'snap']);
  });

  it('aborts on stop request', async () => {
    const { lines } = parseDsl('WAIT 5000\nSET V 1');
    const r = await executeDsl(lines, {} as Dps150Api, () => {}, () => true);
    expect(r.ok).toBe(false);
  });

  it('runs variables, loops and conditions against a fake api', async () => {
    const calls: string[] = [];
    const api = { setVoltage: async (v: number) => calls.push(`v${v}`) } as unknown as Dps150Api;
    const code = `LET base = 0.5
FOR i = 0 TO 3 STEP 1
  LET v = base + i*0.5
  SET V v
NEXT
IF base < 1
  SET V 9
ELSE
  SET V 8
END`;
    const { lines, errors } = parseDsl(code);
    expect(errors).toEqual([]);
    const r = await executeDsl(lines, api, () => {}, () => false);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['v0.5', 'v1', 'v1.5', 'v2', 'v9']);
  });

  it('stops an infinite loop via the step/loop guard', async () => {
    const { lines } = parseDsl('WHILE 1\n  LET x = 1\nEND');
    const r = await executeDsl(lines, {} as Dps150Api, () => {}, () => false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/上限|死循环|步数|循环|时长/);
  });

  it('exposes device state as script variables (after SNAP)', async () => {
    const api = {
      refresh: async () => {},
      state: {
        telemetry: { outputVoltage: 12.3, outputCurrent: 0.5, outputPower: 6.15 },
        settings: { voltageSet: 5, currentSet: 0.5 },
        status: { mode: 'CV', output: 'RUN' },
      },
    } as unknown as Dps150Api;
    const logs: string[] = [];
    const { lines, errors } = parseDsl('SNAP\nLET v = vout\nECHO "vout=" + v\nECHO "mode=" + mode');
    expect(errors).toEqual([]);
    const r = await executeDsl(lines, api, (m) => logs.push(m), () => false);
    expect(r.ok).toBe(true);
    expect(logs.some((l) => l.includes('vout=12.3'))).toBe(true);
    expect(logs.some((l) => l.includes('mode=CV'))).toBe(true);
  });
});

describe('safeEval sandbox', () => {
  it('evaluates math, string, and regex helpers', () => {
    const s = new Map<string, unknown>([['x', 3]]);
    expect(safeEval('x + Math.pow(2,3)', s)).toBe(11);
    expect(JSON.stringify(safeEval('"v=1.00".match(/\\d+\\.\\d+/)', s))).toBe(JSON.stringify(['1.00']));
    expect(safeEval('"abc".toUpperCase()', s)).toBe('ABC');
  });
  it('rejects dangerous global escapes', () => {
    const s = new Map<string, unknown>();
    expect(() => safeEval('window', s)).toThrow();
    expect(() => safeEval('x.constructor', s)).toThrow();
    expect(() => safeEval('1;2', s)).toThrow();
    expect(() => safeEval('this', s)).toThrow();
  });
});
