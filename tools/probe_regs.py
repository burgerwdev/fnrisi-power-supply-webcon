#!/usr/bin/env python3
"""DPS-150 write->FF-readback matrix probe (safe: output must be OFF; restores all values).

Covers protocol notes verification items:
  #3 D9/DA require metering(D8)  #4 strings verified elsewhere
  #6 no C1/C2 echo  #7 D7 volume  #8 CMD_15   #10 FF field semantics (protections/limits/brightness/volume)
Plus: protection write range clamp, preset slots, metering toggle.
"""
import struct
import sys
import time

import serial

BAUD = 9600

def frame(h0, h1, reg, payload=b""):
    chk = (reg + len(payload) + sum(payload)) & 0xFF
    return bytes([h0, h1, reg, len(payload)]) + payload + bytes([chk])

def f32(v):
    return struct.pack("<f", v)

class Session:
    def __init__(self, port):
        self.ser = serial.Serial(port, BAUD, timeout=0.25)
        self.buf = bytearray()
        self.last_ff = None
        self.all = []

    def pump(self, duration=0.0):
        end = time.time() + duration
        while True:
            if duration > 0 and time.time() > end:
                break
            d = self.ser.read(4096)
            if not d:
                if duration <= 0:
                    break
                continue
            self._feed(d)

    def _feed(self, data):
        self.buf += data
        while True:
            if len(self.buf) < 4:
                return
            ln = self.buf[3]
            total = ln + 5
            if total > 260:
                del self.buf[:1]
                continue
            if len(self.buf) < total:
                return
            cand = bytes(self.buf[:total])
            if ((cand[2] + ln + sum(cand[4:total - 1])) & 0xFF) != cand[total - 1]:
                del self.buf[:1]
                continue
            del self.buf[:total]
            self._on(cand)

    def _on(self, b):
        self.all.append(b)
        if b[2] == 0xFF and b[3] >= 139:
            self.last_ff = b[4:-1]

    def send(self, label, b, settle=0.5):
        print(f"  TX {label:28s} {b.hex(' ').upper()}")
        self.ser.write(b)
        self.pump(settle)

    def snap(self, label="snap"):
        self.send(f"FF {label}", frame(0xF1, 0xA1, 0xFF, b"\x00"), settle=0.5)
        if self.last_ff is None:
            self.pump(0.5)
        return self.last_ff

    def close(self):
        self.send("session-close", frame(0xF1, 0xC1, 0x00, b"\x00"), settle=0.2)
        self.ser.close()

def fl(p, o):
    return struct.unpack("<f", p[o:o + 4])[0]

def describe(p, tag=""):
    if p is None:
        return f"{tag}: no FF"
    return (f"{tag} Vin={fl(p,0):.2f} Vset={fl(p,4):.2f} Aset={fl(p,8):.3f} "
            f"| M1={fl(p,28):.2f}/{fl(p,32):.3f} M2={fl(p,36):.2f}/{fl(p,40):.3f} "
            f"| OVP={fl(p,76):.2f} OCP={fl(p,80):.3f} OPP={fl(p,84):.1f} OTP={fl(p,88):.0f} LVP={fl(p,92):.2f} "
            f"| bri={p[96]} vol={p[97]} meter={p[98]} Ah={fl(p,99):.4f} Wh={fl(p,103):.4f} "
            f"| out={p[107]} prot={p[108]} mode={p[109]} b110={p[110]} "
            f"| maxV={fl(p,111):.2f} maxA={fl(p,115):.3f} "
            f"| f119={fl(p,119):.2f} f123={fl(p,123):.3f} f127={fl(p,127):.2f} f131={fl(p,131):.2f} f135={fl(p,135):.2f}")

def diff_fields(before, after, regs):
    for o, nm, fmt in regs:
        if before is None or after is None:
            continue
        a, b = (struct.unpack(fmt, before[o:o + struct.calcsize(fmt)])[0],
                struct.unpack(fmt, after[o:o + struct.calcsize(fmt)])[0])
        if a != b:
            print(f"    changed {nm}: {a} -> {b}")

def main():
    port = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyACM0"
    s = Session(port)
    print(f"opened {port} @ {BAUD}")
    try:
        s.send("session-enable", frame(0xF1, 0xC1, 0x00, b"\x01"))
        base = s.snap("baseline")
        print("  ", describe(base, "BASE"))
        if base is None or base[107] != 0:
            print("!! output RUN or no FF; aborting write matrix (safety).")
            return
        regs = [
            (0, "Vin", "<f"), (4, "Vset", "<f"), (8, "Aset", "<f"),
            (28, "M1V", "<f"), (32, "M1A", "<f"), (36, "M2V", "<f"), (40, "M2A", "<f"),
            (76, "OVP", "<f"), (80, "OCP", "<f"), (84, "OPP", "<f"), (88, "OTP", "<f"), (92, "LVP", "<f"),
            (96, "bri", "<B"), (97, "vol", "<B"), (98, "meter", "<B"), (99, "Ah", "<f"), (103, "Wh", "<f"),
            (107, "out", "<B"), (108, "prot", "<B"), (109, "mode", "<B"), (110, "b110", "<B"),
            (111, "maxV", "<f"), (115, "maxA", "<f"),
            (119, "f119", "<f"), (123, "f123", "<f"), (127, "f127", "<f"), (131, "f131", "<f"), (135, "f135", "<f"),
        ]
        def probe(label, tx, watch=regs, settle=0.6):
            before = s.last_ff
            s.send(label, tx, settle=settle)
            after = s.snap(label)
            print("   ", describe(after, "AFTER"))
            diff_fields(before, after, watch)
            return after

        # --- protections D1..D5 (safe writes; restore original after each) ---
        probe("D1 OVP -> 20.0", frame(0xF1, 0xB1, 0xD1, f32(20.0)))
        probe("D1 OVP restore", frame(0xF1, 0xB1, 0xD1, f32(fl(base, 76))))
        probe("D2 OCP -> 4.0", frame(0xF1, 0xB1, 0xD2, f32(4.0)))
        probe("D2 OCP restore", frame(0xF1, 0xB1, 0xD2, f32(fl(base, 80))))
        probe("D3 OPP -> 100", frame(0xF1, 0xB1, 0xD3, f32(100.0)))
        probe("D3 OPP restore", frame(0xF1, 0xB1, 0xD3, f32(fl(base, 84))))
        probe("D4 OTP -> 60", frame(0xF1, 0xB1, 0xD4, f32(60.0)))
        probe("D4 OTP restore", frame(0xF1, 0xB1, 0xD4, f32(fl(base, 88))))
        probe("D5 LVP -> 12.0", frame(0xF1, 0xB1, 0xD5, f32(12.0)))
        probe("D5 LVP restore", frame(0xF1, 0xB1, 0xD5, f32(fl(base, 92))))

        # --- system: brightness/volume ---
        probe("D6 bri -> 12", frame(0xF1, 0xB1, 0xD6, bytes([12])))
        probe("D6 bri restore", frame(0xF1, 0xB1, 0xD6, bytes([base[96]])))
        probe("D7 vol -> 3", frame(0xF1, 0xB1, 0xD7, bytes([3])))
        probe("D7 vol restore", frame(0xF1, 0xB1, 0xD7, bytes([base[97]])))

        # --- metering D8: expect byte98 flips + D9/DA frames appear ---
        print("  -- metering ON (watch for D9/DA) --")
        s.send("D8 meter on", frame(0xF1, 0xB1, 0xD8, bytes([1])), settle=1.5)
        s.pump(3.0)
        has_d9da = [b for b in s.all if b[2] in (0xD9, 0xDA)]
        print(f"    D9/DA frames seen after enable: {len(has_d9da)}; last_ff: {describe(s.last_ff, 'AFTER') if s.last_ff else 'none'}")
        for b in has_d9da[-4:]:
            print("    e.g.", b.hex(" ").upper())
        s.send("D8 meter off", frame(0xF1, 0xB1, 0xD8, bytes([0])), settle=1.0)
        n0 = len([b for b in s.all if b[2] in (0xD9, 0xDA)])
        s.pump(2.5)
        n1 = len([b for b in s.all if b[2] in (0xD9, 0xDA)])
        print(f"    D9/DA frame count grew after OFF: {n0} -> {n1}")

        # --- preset slot C5/C6 (M1) write: does it mirror main C1/C2? ---
        probe("C5 M1V -> 6.66", frame(0xF1, 0xB1, 0xC5, f32(6.66)))
        probe("C6 M1A -> 2.22", frame(0xF1, 0xB1, 0xC6, f32(2.22)))
        probe("C5/C6 restore", frame(0xF1, 0xB1, 0xC5, f32(fl(base, 28))) + frame(0xF1, 0xB1, 0xC6, f32(fl(base, 32))), settle=0.8)

        # --- C1/C2 echo check ---
        before_c = list(s.all)
        s.send("C1 set 1.1 (echo?)", frame(0xF1, 0xB1, 0xC1, f32(1.1)), settle=0.6)
        echoes = [b for b in s.all[len(before_c):] if b[2] in (0xC1, 0xC2)]
        print(f"    standalone C1/C2 echo frames: {len(echoes)}")
        s.send("C1 restore", frame(0xF1, 0xB1, 0xC1, f32(fl(base, 4))))
    finally:
        s.close()

if __name__ == "__main__":
    main()
