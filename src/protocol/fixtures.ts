// Shared binary fixtures (real-device captures).
// Golden FF snapshot (139 B) captured on DPS-150P: Vin≈20.06 V, Vset=0.5 A, Aset=0.05,
// M1..M6=5V/1A, OVP=31/OCP=5.1/OPP=155/OTP=80/LVP=4.8, bri=10 vol=2, out=STOP, prot=OK, mode=CV.

export const GOLDEN_FF_HEX =
  '4c7aa0410000003fcdcc4c3d0000000000000000000000009489f0410000a0400000803f' +
  '0000a0400000803f0000a0400000803f0000a0400000803f0000a0400000803f0000a0400000803f' +
  '0000f8413333a34000001b430000a0429a9999400a020083ddae2d0000000000000101b2e09e41' +
  '3333a3400000f0413333a340000019430000c6420000f041';

export function hexToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const GOLDEN_FF: Uint8Array = hexToBytes(GOLDEN_FF_HEX);
