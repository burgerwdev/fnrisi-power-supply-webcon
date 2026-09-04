// describe.ts: human-readable frame summaries for the TX/RX debug log.
import { describe, expect, it } from 'vitest';
import { GROUP, HEADER_TX, REG } from './const';
import { describeFrame } from './describe';
import { encodeFrame, float32Bytes } from './frame';

describe('describeFrame', () => {
  it('decodes a TX set-voltage write with a readable payload', () => {
    const f = encodeFrame(HEADER_TX, GROUP.WRITE, REG.SET_VOLTAGE, float32Bytes(5.0));
    const s = describeFrame(f);
    expect(s).toContain('发');
    expect(s).toContain('设定电压');
    expect(s).toContain('5.0000');
  });

  it('marks a device->host frame as received', () => {
    const f = encodeFrame(0xf0, GROUP.READ, REG.MEAS, new Uint8Array(12));
    const s = describeFrame(f);
    expect(s).toContain('收');
    expect(s).toContain('输出电压/电流/功率');
  });

  it('names preset slots M1..M6', () => {
    const f = encodeFrame(HEADER_TX, GROUP.WRITE, 0xc5, float32Bytes(2.5));
    expect(describeFrame(f)).toContain('预设M1电压');
  });

  it('handles short frames gracefully', () => {
    expect(describeFrame(new Uint8Array([1, 2]))).toContain('短帧');
  });
});
