import { describe, expect, it } from 'vitest';
import { decodeRx, decodeSnapshot } from './decode';
import { GROUP, HEADER_RX, REG } from './const';
import { encodeFrame } from './frame';

/** Golden FF snapshot captured on real DPS-150P (2026-09-03): Vin≈20.061V,
 *  Vset=0.5, Aset=0.05, Vout/Iout/Pout=0, temp≈30.07, M1..M6=5.0V/1.0A,
 *  OVP=31 OCP=5.1 OPP=155 OTP=80 LVP=4.8, bri=10 vol=2 meter=off,
 *  out=STOP prot=OK mode=CV, maxV≈19.86 maxA=5.1, rating=[30,5.1,153,99,30]. */
const GOLDEN_FF =
  '4c7aa0410000003fcdcc4c3d0000000000000000000000009489f0410000a0400000803f' +
  '0000a0400000803f0000a0400000803f0000a0400000803f0000a0400000803f0000a0400000803f' +
  '0000f8413333a34000001b430000a0429a9999400a020083ddae2d0000000000000101b2e09e41' +
  '3333a3400000f0413333a340000019430000c6420000f041';

function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('decodeRx telemetry', () => {
  it('decodes C0 input voltage', () => {
    const p = new Uint8Array([0x4c, 0x7a, 0xa0, 0x41]); // 20.061
    expect(decodeRx(REG.VIN, p).telemetry?.inputVoltage).toBeCloseTo(20.061, 2);
  });
  it('decodes C3 v/i/p', () => {
    const p = new Uint8Array([
      0x00, 0x00, 0x80, 0x40, // 4.0 V
      0xe8, 0xaf, 0x6c, 0x3d, // 0.0577849 A
      0xe8, 0xaf, 0x6c, 0x3e, // 0.2311398 W
    ]);
    const t = decodeRx(REG.MEAS, p).telemetry!;
    expect(t.outputVoltage).toBeCloseTo(4.0, 6);
    expect(t.outputCurrent).toBeCloseTo(0.0577849, 6);
    expect(t.outputPower).toBeCloseTo(0.2311398, 6);
  });
  it('decodes status bytes DB/DC/DD', () => {
    expect(decodeRx(REG.OUT_STATE, new Uint8Array([1])).status).toEqual({ output: 'RUN' });
    expect(decodeRx(REG.OUT_STATE, new Uint8Array([0])).status).toEqual({ output: 'STOP' });
    expect(decodeRx(REG.PROTECTION, new Uint8Array([0])).status).toEqual({ protection: 'OK' });
    expect(decodeRx(REG.PROTECTION, new Uint8Array([2])).status).toEqual({ protection: 'OCP' });
    expect(decodeRx(REG.PROTECTION, new Uint8Array([9])).status).toEqual({ protection: 'UNKNOWN' });
    expect(decodeRx(REG.MODE, new Uint8Array([0])).status).toEqual({ mode: 'CC' });
    expect(decodeRx(REG.MODE, new Uint8Array([1])).status).toEqual({ mode: 'CV' });
  });
  it('decodes info strings and identity', () => {
    const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    expect(decodeRx(REG.MODEL_NAME, enc('DPS-150P')).info).toEqual({ modelName: 'DPS-150P' });
    expect(decodeRx(REG.HW_VERSION, enc('V1.0')).info).toEqual({ hwVersion: 'V1.0' });
    expect(decodeRx(REG.FW_VERSION, enc('V1.6')).info).toEqual({ fwVersion: 'V1.6' });
    expect(decodeRx(REG.IDENT, new Uint8Array([1])).info).toEqual({ ident: 1 });
  });
});

describe('decodeSnapshot golden vector', () => {
  const snap = decodeSnapshot(hexToBytes(GOLDEN_FF));
  it('decodes measurements', () => {
    expect(snap.telemetry.inputVoltage).toBeCloseTo(20.06, 1);
    expect(snap.telemetry.outputVoltage).toBe(0);
    expect(snap.telemetry.temperature).toBeCloseTo(30.07, 1);
  });
  it('decodes setpoints', () => {
    expect(snap.settings.voltageSet).toBeCloseTo(0.5, 6);
    expect(snap.settings.currentSet).toBeCloseTo(0.05, 6);
    expect(snap.settings.brightness).toBe(10);
    expect(snap.settings.volume).toBe(2);
    expect(snap.settings.meteringOn).toBe(false);
  });
  it('decodes presets M1..M6', () => {
    expect(snap.presets).toHaveLength(6);
    for (const p of snap.presets) {
      expect(p.voltage).toBeCloseTo(5.0, 5);
      expect(p.current).toBeCloseTo(1.0, 5);
    }
  });
  it('decodes protections', () => {
    expect(snap.protections.ovp).toBeCloseTo(31.0, 5);
    expect(snap.protections.ocp).toBeCloseTo(5.1, 5);
    expect(snap.protections.opp).toBeCloseTo(155.0, 4);
    expect(snap.protections.otp).toBeCloseTo(80.0, 5);
    expect(snap.protections.lvp).toBeCloseTo(4.8, 5);
  });
  it('decodes status and limits', () => {
    expect(snap.status).toEqual({ output: 'STOP', protection: 'OK', mode: 'CV' });
    expect(snap.limits.maxVoltage).toBeCloseTo(19.86, 1);
    expect(snap.limits.maxCurrent).toBeCloseTo(5.1, 5);
  });
  it('decodes static rating constants', () => {
    const r = snap.rating;
    expect(r.ovpMax).toBeCloseTo(30, 4);
    expect(r.ocpMax).toBeCloseTo(5.1, 4);
    expect(r.oppMax).toBeCloseTo(153, 4);
    expect(r.otpMax).toBeCloseTo(99, 4);
    expect(r.lvpMax).toBeCloseTo(30, 4);
  });
  it('kind detection via decodeRx', () => {
    const frame = encodeFrame(HEADER_RX, GROUP.READ, REG.SNAPSHOT, hexToBytes(GOLDEN_FF));
    const r = decodeRx(REG.SNAPSHOT, frame.subarray(4, 4 + frame[3]));
    expect(r.kind).toBe('snapshot');
  });
});
