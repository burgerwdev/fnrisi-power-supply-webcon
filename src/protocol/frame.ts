// Frame encode/decode + little-endian float helpers.
// Frame: [header][group][reg][len][payload...][chk]
// chk = (reg + len + sum(payload)) & 0xff  (first two bytes excluded)

export interface Frame {
  header: number;
  group: number;
  reg: number;
  payload: Uint8Array;
  /** length byte value */
  len: number;
  chk: number;
  checksumOk: boolean;
}

export function checksum(reg: number, payload: Uint8Array | number[]): number {
  let sum = (reg + payload.length) & 0xff;
  for (let i = 0; i < payload.length; i++) sum = (sum + payload[i]) & 0xff;
  return sum;
}

export function encodeFrame(
  header: number,
  group: number,
  reg: number,
  payload: Uint8Array | number[] | number = [],
): Uint8Array {
  const pl = payload instanceof Uint8Array ? payload : new Uint8Array(Array.isArray(payload) ? payload : [payload]);
  if (pl.length > 255) throw new Error(`payload too long: ${pl.length}`);
  const out = new Uint8Array(pl.length + 5);
  out[0] = header;
  out[1] = group;
  out[2] = reg;
  out[3] = pl.length;
  out.set(pl, 4);
  out[out.length - 1] = checksum(reg, pl);
  return out;
}

/** Parse one complete frame (exactly total bytes). Throws if length byte impossible. */
export function parseFrame(bytes: Uint8Array): Frame {
  if (bytes.length < 5) throw new Error(`frame too short: ${bytes.length}`);
  const len = bytes[3];
  if (bytes.length !== len + 5) throw new Error(`frame length mismatch: got ${bytes.length}, want ${len + 5}`);
  const payload = bytes.subarray(4, 4 + len);
  return {
    header: bytes[0],
    group: bytes[1],
    reg: bytes[2],
    len,
    payload,
    chk: bytes[bytes.length - 1],
    checksumOk: checksum(bytes[2], payload) === bytes[bytes.length - 1],
  };
}

// ---------- little-endian primitives ----------

export function float32Bytes(value: number): Uint8Array {
  const b = new ArrayBuffer(4);
  new DataView(b).setFloat32(0, value, true);
  return new Uint8Array(b);
}

export function readFloat32(payload: Uint8Array, offset = 0): number {
  if (offset + 4 > payload.length) throw new RangeError(`readFloat32 out of range: off=${offset} len=${payload.length}`);
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getFloat32(offset, true);
}

export function readUint8(payload: Uint8Array, offset: number): number {
  return payload[offset];
}

export function asciiString(payload: Uint8Array): string {
  let s = '';
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function hex(b: Uint8Array | number[]): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
}
