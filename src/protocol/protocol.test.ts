import { describe, expect, it } from 'vitest';
import { GROUP, HEADER_RX, HEADER_TX, REG } from './const';
import { checksum, encodeFrame, float32Bytes, hex, parseFrame, readFloat32 } from './frame';
import { FrameParser } from './parser';

describe('checksum', () => {
  it('matches rule (reg + len + sum(payload)) & 0xff', () => {
    // F1 B1 C1 04 CD CC 44 41 E3  (12.3V from cho45 live capture)
    expect(checksum(0xc1, [0xcd, 0xcc, 0x44, 0x41])).toBe(0xe3);
    // F1 B1 DB 01 01 DD (RUN)
    expect(checksum(0xdb, [0x01])).toBe(0xdd);
    // F1 B1 DB 01 00 DC (STOP)
    expect(checksum(0xdb, [0x00])).toBe(0xdc);
    // F1 C1 00 01 01 02 (session open)
    expect(checksum(0x00, [0x01])).toBe(0x02);
    // F1 A1 FF 01 00 00 (snapshot request, real device verified)
    expect(checksum(0xff, [0x00])).toBe(0x00);
  });
});

describe('encodeFrame', () => {
  it('encodes set-voltage frame (real capture)', () => {
    const f = encodeFrame(HEADER_TX, GROUP.WRITE, REG.SET_VOLTAGE, float32Bytes(12.3));
    expect(hex(f)).toBe('f1 b1 c1 04 cd cc 44 41 e3');
  });
  it('encodes output RUN/STOP frames', () => {
    expect(hex(encodeFrame(HEADER_TX, GROUP.WRITE, REG.OUTPUT, 1))).toBe('f1 b1 db 01 01 dd');
    expect(hex(encodeFrame(HEADER_TX, GROUP.WRITE, REG.OUTPUT, 0))).toBe('f1 b1 db 01 00 dc');
  });
  it('encodes session open/close frames', () => {
    expect(hex(encodeFrame(HEADER_TX, GROUP.SESSION, 0x00, 1))).toBe('f1 c1 00 01 01 02');
    expect(hex(encodeFrame(HEADER_TX, GROUP.SESSION, 0x00, 0))).toBe('f1 c1 00 01 00 01');
  });
  it('encodes E1 / DE / DF / E0 / FF zero-payload queries (official + CLI form)', () => {
    expect(hex(encodeFrame(HEADER_TX, GROUP.READ, REG.IDENT, 0))).toBe('f1 a1 e1 01 00 e2');
    expect(hex(encodeFrame(HEADER_TX, GROUP.READ, REG.MODEL_NAME, 0))).toBe('f1 a1 de 01 00 df');
    expect(hex(encodeFrame(HEADER_TX, GROUP.READ, REG.HW_VERSION, 0))).toBe('f1 a1 df 01 00 e0');
    expect(hex(encodeFrame(HEADER_TX, GROUP.READ, REG.FW_VERSION, 0))).toBe('f1 a1 e0 01 00 e1');
    expect(hex(encodeFrame(HEADER_TX, GROUP.READ, REG.SNAPSHOT, 0))).toBe('f1 a1 ff 01 00 00');
  });
  it('float LE bytes round trip', () => {
    expect(Array.from(float32Bytes(1.0))).toEqual([0x00, 0x00, 0x80, 0x3f]);
    const p = float32Bytes(1.23);
    expect(readFloat32(p, 0)).toBeCloseTo(1.23, 6);
  });
});

describe('parseFrame', () => {
  it('parses a telemetry frame with C3 payload (CLI self-test sample)', () => {
    const raw = new Uint8Array([0xf0, 0xa1, 0xc3, 0x0c, 0x00, 0x00, 0x80, 0x40, 0xe8, 0xaf, 0x6c, 0x3d, 0xe8, 0xaf, 0x6c, 0x3e, 0x10]);
    const f = parseFrame(raw);
    expect(f.header).toBe(0xf0);
    expect(f.reg).toBe(0xc3);
    expect(f.len).toBe(12);
    expect(f.checksumOk).toBe(true);
    expect(readFloat32(f.payload, 0)).toBeCloseTo(4.0, 6);
    expect(readFloat32(f.payload, 4)).toBeCloseTo(0.0577849, 6);
    expect(readFloat32(f.payload, 8)).toBeCloseTo(0.2311398, 6);
  });
});

describe('FrameParser', () => {
  const frames: Uint8Array[] = [
    encodeFrame(HEADER_RX, GROUP.READ, 0xc0, float32Bytes(20.06)),
    encodeFrame(HEADER_RX, GROUP.READ, 0xc3, new Uint8Array(float32Bytes(1.0).length * 3).fill(0)),
    encodeFrame(HEADER_RX, GROUP.READ, REG.SNAPSHOT, new Uint8Array(139)),
  ];

  it('parses frames split at arbitrary byte boundaries (stream)', () => {
    const stream = new Uint8Array(frames.reduce<number[]>((a, f) => a.concat(Array.from(f)), []));
    const got: number[] = [];
    const parser = new FrameParser();
    for (let i = 0; i < stream.length; i += 3) {
      parser.push(stream.subarray(i, i + 3), (f) => got.push(f.reg));
    }
    expect(got).toEqual([0xc0, 0xc3, 0xff]);
  });

  it('resyncs when garbage precedes frames', () => {
    const parser = new FrameParser();
    const got: number[] = [];
    // noise whose length byte yields a checksum failure, forcing byte-wise resync
    const garbage = new Uint8Array([0x55, 0xf0, 0xaa, 0x02, 0x00]);
    const all = new Uint8Array([...garbage, ...frames[0]]);
    parser.push(all, (f) => got.push(f.reg));
    expect(got).toEqual([0xc0]);
  });

  it('drops a frame with wrong checksum and resyncs on the next', () => {
    const parser = new FrameParser();
    const got: number[] = [];
    const bad = encodeFrame(HEADER_RX, GROUP.READ, 0xdd, [0x01]);
    bad[bad.length - 1] ^= 0xff; // corrupt checksum
    const all = new Uint8Array([...bad, ...frames[1]]);
    parser.push(all, (f) => got.push(f.reg));
    expect(got).toEqual([0xc3]);
  });

  it('ignores unknown-length frames safely', () => {
    const parser = new FrameParser();
    let n = 0;
    parser.push(new Uint8Array([0xf0, 0xa1, 0xff, 200]), () => n++);
    expect(n).toBe(0);
    expect(parser.pendingBytes).toBe(4);
  });
});
