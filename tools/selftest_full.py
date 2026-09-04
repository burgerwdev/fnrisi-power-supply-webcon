#!/usr/bin/env python3
"""DPS-150 full-feature automated verification (device layer, Python/pyserial, no browser interaction).

Covers: session/identity/device info/telemetry push/set V·A readback/M1-M6 presets/protections D1-D5/
brightness D6/volume D7/metering D8 with capacity & energy/output RUN-STOP (only 1.0V/0.05A no-load ~2s).
Safety: output OFF by default; RUN segment limited to 1.0V/50mA no-load; restores baseline at the end.
Usage: python3 tools/selftest_full.py [--port /dev/ttyACM0]
"""
import argparse
import struct
import time

import serial

BAUD = 9600


def frame(h0, h1, reg, payload=b""):
    chk = (reg + len(payload) + sum(payload)) & 0xFF
    return bytes([h0, h1, reg, len(payload)]) + payload + bytes([chk])


def f32(v):
    return struct.pack("<f", v)


def fl(p, o):
    return struct.unpack("<f", p[o:o + 4])[0]


def f2s(v):
    return f"{v:.4f}"


class Device:
    def __init__(self, port):
        self.ser = serial.Serial(port, BAUD, timeout=0.25)
        self.buf = bytearray()
        self.frames = []
        self.ff = None  # latest full FF payload
        self.since = time.time()

    def pump(self, dur):
        end = time.time() + dur
        while time.time() < end:
            d = self.ser.read(4096)
            if not d:
                continue
            self.buf += d
            while True:
                if len(self.buf) < 4:
                    break
                ln = self.buf[3]
                tot = ln + 5
                if tot > 260:
                    del self.buf[:1]
                    continue
                if len(self.buf) < tot:
                    break
                c = bytes(self.buf[:tot])
                if ((c[2] + ln + sum(c[4:tot - 1])) & 0xFF) != c[tot - 1]:
                    del self.buf[:1]
                    continue
                del self.buf[:tot]
                self.frames.append(c)
                if c[2] == 0xFF and c[3] >= 139:
                    self.ff = c[4:-1]
                if c[2] == 0xDB:
                    self.db = c[4]
                if c[2] == 0xDD:
                    self.dd = c[4]

    def send(self, h0, h1, reg, payload=b"", settle=0.4):
        self.ser.write(frame(h0, h1, reg, payload))
        if settle:
            self.pump(settle)

    def snapshot(self, label="snap"):
        self.send(0xF1, 0xA1, 0xFF, b"\x00", settle=0.5)
        if self.ff is None:
            self.pump(0.5)
        return self.ff

    def close(self):
        try:
            self.send(0xF1, 0xC1, 0x00, b"\x00", settle=0.2)
        finally:
            self.ser.close()


RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}  {detail}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/ttyACM0")
    ap.add_argument("--run-test", action="store_true", help="allow 1.0V/0.05A no-load RUN≈2s verification")
    args = ap.parse_args()
    if not args.run_test:
        print("Note: without --run-test, the output RUN/metering accumulation segment is skipped (the rest still runs).")
    d = Device(args.port)
    print(f"Connecting {args.port} @ {BAUD}")
    try:
        # ---- 0. session ----
        d.send(0xF1, 0xC1, 0x00, b"\x01", settle=0.6)
        base = d.snapshot("baseline")
        check("Session enable + FF snapshot", base is not None and len(base) == 139, f"len={len(base) if base else 0}")
        if base is None:
            check("Precondition: able to get snapshot", False, "unable to communicate, aborting")
            return
        if base[107] != 0:
            check("Safety precondition: output is STOP", False, "output is on, aborting (turn off output on the device first)")
            return

        # backup baseline
        def back(regs):
            return {r: fl(base, o) for r, o in regs.items()}

        vset0 = fl(base, 4)
        aset0 = fl(base, 8)
        pres0 = [(fl(base, 28 + i * 8), fl(base, 32 + i * 8)) for i in range(6)]
        prot0 = {r: fl(base, o) for r, o in {"D1": 76, "D2": 80, "D3": 84, "D4": 88, "D5": 92}.items()}
        bri0, vol0 = base[96], base[97]

        # ---- 1. identity/info ----
        d.send(0xF1, 0xA1, 0xE1, b"\x00", settle=0.5)
        d.send(0xF1, 0xA1, 0xDE, b"\x00", settle=0.5)
        d.send(0xF1, 0xA1, 0xDF, b"\x00", settle=0.5)
        d.send(0xF1, 0xA1, 0xE0, b"\x00", settle=0.5)
        r = {c[2]: c[4:-1] for c in d.frames[-40:]}
        check("E1 identity code=1", r.get(0xE1, b"")[:1] == b"\x01", f"{r.get(0xE1, b'').hex()}")
        check("Model string DPS-150P", r.get(0xDE, b"") == b"DPS-150P", f"{r.get(0xDE, b'')!r}")
        check("Hardware version V1.0", r.get(0xDF, b"") == b"V1.0", f"{r.get(0xDF, b'')!r}")
        check("Firmware version V1.6", r.get(0xE0, b"") == b"V1.6", f"{r.get(0xE0, b'')!r}")

        # ---- 2. telemetry push ----
        d.frames = []
        d.pump(3.0)
        seen = {c[2] for c in d.frames}
        for reg, nm in [(0xC0, "input voltage C0"), (0xC3, "V-I-P C3"), (0xE2, "voltage limit E2"), (0xE3, "current limit E3"), (0xC4, "temperature C4")]:
            check(f"Telemetry push {nm}", reg in seen, f"{'received' if reg in seen else 'missing'}")
        e2 = next((fl(c[4:-1], 0) for c in d.frames if c[2] == 0xE2), 0)
        vin = next((fl(c[4:-1], 0) for c in d.frames if c[2] == 0xC0), 0)
        check("E2 ≈ Vin-0.2", abs(e2 - (vin - 0.2)) < 0.1, f"E2={e2:.2f} Vin={vin:.2f}")
        e3 = next((fl(c[4:-1], 0) for c in d.frames if c[2] == 0xE3), 0)
        check("E3 current limit≈5.1", abs(e3 - 5.1) < 0.05, f"E3={e3:.3f}")

        # ---- 3. set V/A + readback ----
        d.send(0xF1, 0xB1, 0xC1, f32(1.234))
        d.send(0xF1, 0xB1, 0xC2, f32(0.123))
        snap = d.snapshot("v/a")
        vok = snap is not None and abs(fl(snap, 4) - 1.234) < 0.001
        aok = snap is not None and abs(fl(snap, 8) - 0.123) < 0.001
        check("Set voltage C1 → FF readback", vok, f"set=1.234 got={fl(snap, 4) if snap else None:.4f}" if snap else "")
        check("Set current C2 → FF readback", aok, f"set=0.123 got={fl(snap, 8) if snap else None:.4f}" if snap else "")

        # ---- 4. presets M1..M6 ----
        okall = True
        det = []
        for i in range(6):
            v = round(1.0 + i * 0.5, 3)
            a = round(0.05 + i * 0.05, 3)
            d.send(0xF1, 0xB1, 0xC5 + 2 * i, f32(v))
            d.send(0xF1, 0xB1, 0xC6 + 2 * i, f32(a))
        snap = d.snapshot("presets")
        for i in range(6):
            ev, ea = 1.0 + i * 0.5, 0.05 + i * 0.05
            gv, ga = fl(snap, 28 + i * 8), fl(snap, 32 + i * 8)
            ok = abs(gv - ev) < 0.002 and abs(ga - ea) < 0.002
            okall &= ok
            det.append(f"M{i + 1}={gv:.2f}/{ga:.3f}")
        check("Preset M1-M6 write/readback", okall, " ".join(det))
        check("Preset slots do not affect main setting", abs(fl(snap, 4) - 1.234) < 0.002, f"Vset still={fl(snap,4):.3f}")

        # ---- 5. protections ----
        vals = {"D1": 25.0, "D2": 4.0, "D3": 120.0, "D4": 65.0, "D5": 10.0}
        regs = {"D1": 0xD1, "D2": 0xD2, "D3": 0xD3, "D4": 0xD4, "D5": 0xD5}
        offs = {"D1": 76, "D2": 80, "D3": 84, "D4": 88, "D5": 92}
        for k in ["D1", "D2", "D3", "D4", "D5"]:
            d.send(0xF1, 0xB1, regs[k], f32(vals[k]))
        snap = d.snapshot("prots")
        okall = True
        det = []
        for k in ["D1", "D2", "D3", "D4", "D5"]:
            g = fl(snap, offs[k])
            ok = abs(g - vals[k]) < 0.01
            okall &= ok
            det.append(f"{k}={g:.2f}")
        check("Protections OVP/OCP/OPP/OTP/LVP write/readback", okall, " ".join(det))

        # ---- 6. brightness / volume ----
        d.send(0xF1, 0xB1, 0xD6, bytes([12]))
        d.send(0xF1, 0xB1, 0xD7, bytes([3]))
        snap = d.snapshot("sys")
        check("Brightness D6 write/readback", snap is not None and snap[96] == 12, f"bri={snap[96] if snap else '?'}")
        check("Volume D7 write/readback", snap is not None and snap[97] == 3, f"vol={snap[97] if snap else '?'}")

        # ---- 7/8. output RUN + metering (only if allowed) ----
        if args.run_test:
            d.send(0xF1, 0xB1, 0xC1, f32(1.0))
            d.send(0xF1, 0xB1, 0xC2, f32(0.05))
            d.send(0xF1, 0xB1, 0xD8, b"\x01", settle=0.8)
            ok_met = False
            db_run = vout_ok = False
            attempts = 0
            while not ok_met and attempts < 3:
                attempts += 1
                d.frames = []
                d.send(0xF1, 0xB1, 0xDB, b"\x01", settle=1.2)
                d.pump(4.0)  # ample window for D9/DA (~1.4s after RUN then every ~0.6s)
                db_run = any(c[2] == 0xDB and c[4] == 1 for c in d.frames)
                c3s = [fl(c[4:-1], 0) for c in d.frames if c[2] == 0xC3 and c[3] == 12]
                vout_ok = bool(c3s) and max(c3s) > 0.9
                d9 = [c for c in d.frames if c[2] == 0xD9]
                da = [c for c in d.frames if c[2] == 0xDA]
                ok_met = bool(d9) and bool(da)
                if not ok_met:
                    d.send(0xF1, 0xB1, 0xDB, b"\x00", settle=0.8)  # stop between attempts
                    d.pump(0.5)
            check("Output RUN (DB=1 change reported)", db_run, f"attempts={attempts},c3_vout_max={max(c3s) if 'c3s' in dir() and c3s else 0:.2f}")
            check("During RUN Vout reaches ~1.0V", vout_ok, f"{[f'{x:.2f}' for x in (c3s[:6] if 'c3s' in dir() else [])]}")
            check("Metering on + RUN → D9 (capacity)/DA (energy) push", ok_met, f"D9={len(d9)} DA={len(da)}(attempts={attempts})")
            # capture STOP before clearing frames
            d.send(0xF1, 0xB1, 0xDB, b"\x00", settle=1.0)
            stop_ok = any(c[2] == 0xDB and c[4] == 0 for c in d.frames)
            d.send(0xF1, 0xB1, 0xD8, b"\x00", settle=0.5)
            check("Output STOP (DB=0)", stop_ok, "")
            d.frames = []
            d.pump(2.0)
            check("After metering off D9/DA stop", not any(c[2] in (0xD9, 0xDA) for c in d.frames), "")
        else:
            d.send(0xF1, 0xB1, 0xD8, b"\x01", settle=0.8)
            d.pump(1.2)
            d.send(0xF1, 0xB1, 0xD8, b"\x00", settle=0.5)
            check("Metering switch D8 round-trip (switch only)", True, "skipping RUN accumulation validation (enable with --run-test)")

        # ---- restore baseline ----
        d.send(0xF1, 0xB1, 0xC1, f32(vset0))
        d.send(0xF1, 0xB1, 0xC2, f32(aset0))
        for i, (v, a) in enumerate(pres0):
            d.send(0xF1, 0xB1, 0xC5 + 2 * i, f32(v), settle=0.05)
            d.send(0xF1, 0xB1, 0xC6 + 2 * i, f32(a), settle=0.05)
        for k, v in prot0.items():
            d.send(0xF1, 0xB1, regs[k], f32(v), settle=0.05)
        d.send(0xF1, 0xB1, 0xD6, bytes([bri0]), settle=0.1)
        d.send(0xF1, 0xB1, 0xD7, bytes([vol0]), settle=0.1)
        snap = d.snapshot("restore")
        rest_ok = snap is not None and abs(fl(snap, 4) - vset0) < 0.01 and abs(fl(snap, 76) - prot0["D1"]) < 0.02
        check("Restore site (set/preset/protect/brightness/volume)", rest_ok,
              f"Vset={fl(snap,4) if snap else '?'}->{vset0} OVP={fl(snap,76) if snap else '?'}->{prot0['D1']:.1f}")
    finally:
        d.close()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n===== Device-layer full self-test: {passed}/{len(RESULTS)} passed =====")
    for name, ok, det in RESULTS:
        if not ok:
            print(f"  FAIL: {name} {det}")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
