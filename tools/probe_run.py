#!/usr/bin/env python3
"""RUN/STOP observation probe (approved: 1.0V / 0.05A, no load, ~3s RUN).
Confirms: DB/DC/DD change-push frames, metering byte98 + D9/DA while RUN, cadence.
"""
import struct
import time

import serial

def frame(h0, h1, reg, payload=b""):
    chk = (reg + len(payload) + sum(payload)) & 0xFF
    return bytes([h0, h1, reg, len(payload)]) + payload + bytes([chk])

def f32(v):
    return struct.pack("<f", v)

def fl(p, o):
    return struct.unpack("<f", p[o:o + 4])[0]

def decode(b):
    cmd, ln = b[2], b[3]
    p = b[4:-1]
    if cmd == 0xC3 and len(p) == 12:
        v, i, w = struct.unpack("<3f", p)
        return f"C3 V={v:.3f} I={i:.4f} P={w:.4f}"
    if cmd == 0xC0 and len(p) == 4:
        return f"C0 Vin={struct.unpack('<f', p)[0]:.2f}"
    if cmd in (0xC4, 0xE2, 0xE3, 0xD9, 0xDA) and len(p) == 4:
        return f"{cmd:02X} ={struct.unpack('<f', p)[0]:.4f}"
    if cmd in (0xDB, 0xDC, 0xDD) and len(p) == 1:
        nm = {0xDB: "DB-out", 0xDC: "DC-prot", 0xDD: "DD-mode"}[cmd]
        return f"{nm}={p[0]}"
    return f"{cmd:02X} len={ln}"

class S:
    def __init__(self):
        self.ser = serial.Serial("/dev/ttyACM0", 9600, timeout=0.2)
        self.buf = bytearray()
        self.t0 = time.time()
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
                t = time.time() - self.t0
                tag = ""
                if c[2] in (0xDB, 0xDC, 0xDD):
                    tag = "  <<CHANGE-PUSH"
                print(f"[{t:7.2f}] RX {decode(c)}{tag}")
    def send(self, label, b, wait=0.6):
        print(f"[{time.time() - self.t0:7.2f}] TX {label}: {b.hex(' ').upper()}")
        self.ser.write(b)
        self.pump(wait)
    def snap(self):
        self.send("FF", frame(0xF1, 0xA1, 0xFF, b"\x00"))
        return self.last
    def close(self):
        self.ser.write(frame(0xF1, 0xC1, 0x00, b"\x00"))
        time.sleep(0.2)
        self.ser.close()

s = S()
try:
    s.send("session", frame(0xF1, 0xC1, 0x00, b"\x01"))
    s.send("V=1.0", frame(0xF1, 0xB1, 0xC1, f32(1.0)))
    s.send("A=0.05", frame(0xF1, 0xB1, 0xC2, f32(0.05)))
    s.send("meter on", frame(0xF1, 0xB1, 0xD8, b"\x01"), wait=1.0)
    print("-- RUN 1.0V/0.05A ~3s --")
    s.send("RUN", frame(0xF1, 0xB1, 0xDB, b"\x01"), wait=1.0)
    s.pump(3.0)
    s.send("STOP", frame(0xF1, 0xB1, 0xDB, b"\x00"), wait=1.0)
    s.send("meter off", frame(0xF1, 0xB1, 0xD8, b"\x00"), wait=0.5)
    print("-- restore --")
    s.send("V=0.5", frame(0xF1, 0xB1, 0xC1, f32(0.5)))
    s.send("A=0.05", frame(0xF1, 0xB1, 0xC2, f32(0.05)))
finally:
    s.close()
print("done")
