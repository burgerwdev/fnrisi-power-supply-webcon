#!/usr/bin/env python3
"""DPS-150 real-device validation harness (protocol notes §10 matrix, passive-safe items).

Only passive / no-output operations by default:
  session enable, identity/info queries, FF snapshot (both payload variants),
  telemetry observation, C1(set voltage)/C2(set current) write-echo with output OFF,
  checksum/log capture for frame-sample vectors.

Run:  python3 tools/devtest.py [--port /dev/ttyACM0] [--baud 9600] [--seconds 8] [--active]
Use --active to additionally: D6 brightness set(12), DB output RUN/STOP at V=1.0/A=0.05 with no load.
"""
import argparse
import binascii
import struct
import sys
import time

import serial

# ---------- protocol primitives (mirror of the project docs) ----------

def frame(h0, h1, reg, payload=b""):
    chk = (reg + len(payload) + sum(payload)) & 0xFF
    return bytes([h0, h1, reg, len(payload)]) + payload + bytes([chk])

def f32(v):
    return struct.pack("<f", v)

def hexs(b):
    return " ".join(f"{x:02X}" for x in b)

class Parser:
    """Byte-stream frame parser (resync on bad checksum)."""
    def __init__(self):
        self.buf = bytearray()
    def feed(self, data, on_frame):
        self.buf += data
        while True:
            start = 0
            while start + 3 < len(self.buf):
                if self.buf[start] in (0xF0, 0xF1):
                    break
                start += 1
            if start:
                del self.buf[:start]
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
            on_frame(cand)
            del self.buf[:total]

# ---------- decode helpers ----------

def decode(cmd, payload):
    if cmd == 0xC0 and len(payload) == 4:
        return f"Vin={struct.unpack('<f', payload)[0]:.3f} V"
    if cmd == 0xC3 and len(payload) == 12:
        v, i, p = struct.unpack("<3f", payload)
        return f"Vout={v:.3f} V  Iout={i:.4f} A  Pout={p:.4f} W"
    if cmd in (0xC4, 0xD9, 0xDA, 0xE2, 0xE3) and len(payload) == 4:
        v = struct.unpack("<f", payload)[0]
        name = {0xC4: "Temp", 0xD9: "Ah", 0xDA: "Wh", 0xE2: "MaxV(E2)", 0xE3: "MaxA(E3)"}[cmd]
        unit = {"C4": "C", "D9": "Ah", "DA": "Wh", "E2": "V", "E3": "A"}[f"{cmd:02X}"]
        return f"{name}={v:.4f} {unit}"
    if cmd in (0xDB, 0xDC, 0xDD, 0xE1) and len(payload) == 1:
        names = {0xDB: "OutState(DB)", 0xDC: "Prot(0=OK 1=OVP 2=OCP 3=OPP 4=OTP 5=LVP)", 0xDD: "Mode(0=CC 1=CV)", 0xE1: "Ident(E1)"}
        return f"{names[cmd]}={payload[0]}"
    if cmd in (0xDE, 0xDF, 0xE0):
        name = {0xDE: "Model(DE)", 0xDF: "HWver(DF)", 0xE0: "FWver(E0)"}[cmd]
        raw = payload.decode("utf-8", "replace") if payload else ""
        return f"{name} string={raw!r} hex={hexs(payload)}"
    if cmd == 0xFF:
        return decode_ff(payload)
    return f"cmd={cmd:02X} len={len(payload)} hex={hexs(payload)}"

def decode_ff(p):
    if len(p) < 139:
        return f"FF short len={len(p)} hex={hexs(p)}"
    def fl(o):
        return struct.unpack("<f", p[o:o + 4])[0]
    return ("FF[139B] "
            f"Vin={fl(0):.2f} Vset={fl(4):.2f} Aset={fl(8):.3f} "
            f"Vout={fl(12):.2f} Iout={fl(16):.3f} Pout={fl(20):.2f} T={fl(24):.1f} "
            f"M1V={fl(28):.2f} M6V={fl(68):.2f} "
            f"OVP={fl(76):.2f} OCP={fl(80):.3f} OPP={fl(84):.1f} OTP={fl(88):.0f} LVP={fl(92):.2f} "
            f"bri={p[96]} vol={p[97]} metering={p[98]} Ah={fl(99):.4f} Wh={fl(103):.4f} "
            f"out={p[107]} prot={p[108]} mode={p[109]} ?110={p[110]} "
            f"maxV={fl(111):.2f} maxA={fl(115):.3f} r119={fl(119):.2f} r123={fl(123):.3f} "
            f"r127={fl(127):.2f} r131={fl(131):.2f} r135={fl(135):.2f}")

# ---------- main ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/ttyACM0")
    ap.add_argument("--baud", type=int, default=9600)
    ap.add_argument("--seconds", type=float, default=8.0)
    ap.add_argument("--active", action="store_true", help="allow safe active tests (D6 brightness + DB run at 1V/0.05A)")
    ap.add_argument("--capture", default=None, help="write raw RX bytes to file")
    args = ap.parse_args()

    ser = serial.Serial(args.port, args.baud, timeout=0.2)
    print(f"opened {args.port} @ {args.baud}")
    rx = open(args.capture, "wb") if args.capture else None
    parser = Parser()
    counts = {}
    ff_payload = None
    responses = {}  # pending query bookkeeping
    t0 = time.time()

    def on_frame(b):
        nonlocal ff_payload
        if rx:
            rx.write(b)
        h0, h1, reg, ln = b[0], b[1], b[2], b[3]
        payload = b[4:-1]
        counts[reg] = counts.get(reg, 0) + 1
        if reg == 0xFF and len(payload) >= 108:
            ff_payload = payload
        print(f"[{time.time() - t0:7.2f}] RX {h0:02X} {h1:02X} {reg:02X} len={ln} | {decode(reg, payload)}")

    def send(label, b, wait=0.3):
        print(f"\nTX {label}: {hexs(b)}")
        ser.write(b)
        time.sleep(wait)

    try:
        # 1. session enable (CMD_1)
        send("session-enable", frame(0xF1, 0xC1, 0x00, b"\x01"))
        time.sleep(0.5)
        # 2. E1 identity query (optional in CLI/cho45 but official flow)
        send("E1 ident", frame(0xF1, 0xA1, 0xE1, b"\x00"), wait=0.6)
        # 3. commandInit subset: DE/DF/E0 info + FF snapshot (payload variant A: len1 zero)
        send("query DE model", frame(0xF1, 0xA1, 0xDE, b"\x00"), wait=0.5)
        send("query DF hw", frame(0xF1, 0xA1, 0xDF, b"\x00"), wait=0.5)
        send("query E0 fw", frame(0xF1, 0xA1, 0xE0, b"\x00"), wait=0.5)
        send("query FF (len1 zero)", frame(0xF1, 0xA1, 0xFF, b"\x00"), wait=0.6)
        # 4. FF payload variant B: len0 (cho45 doc form)
        send("query FF (len0)", frame(0xF1, 0xA1, 0xFF, b""), wait=0.6)
        # drain with parse while sending periodic nothing (passive observe)
        print(f"\n-- passive telemetry observe {args.seconds}s --")
        drain_until = time.time() + args.seconds
        while time.time() < drain_until:
            data = ser.read(4096)
            if data:
                parser.feed(data, on_frame)
            else:
                time.sleep(0.02)
        # still drain left overs
        ser.timeout = 0.4
        data = ser.read(4096)
        if data:
            parser.feed(data, on_frame)

        # 5. set V with output OFF then echo check (safe) — only if output currently STOP
        print("\n-- safe set tests (require output OFF) --")
        out_now = ff_payload[107] if ff_payload and len(ff_payload) >= 108 else None
        if out_now == 1:
            print(f"!! WARNING: FF reports output RUN (byte107=1); skipping set tests to avoid touching a live output. ff_payload seen={ff_payload is not None}")
        else:
            send("set V=1.23 (out off)", frame(0xF1, 0xB1, 0xC1, f32(1.23)), wait=0.5)
            send("set A=0.100 (out off)", frame(0xF1, 0xB1, 0xC2, f32(0.100)), wait=0.5)
            send("query FF refresh", frame(0xF1, 0xA1, 0xFF, b"\x00"), wait=0.6)
            drain_until = time.time() + 1.5
            while time.time() < drain_until:
                data = ser.read(4096)
                if data:
                    parser.feed(data, on_frame)
            # restore modest defaults
            send("set V=0.5 restore", frame(0xF1, 0xB1, 0xC1, f32(0.5)), wait=0.3)
            send("set A=0.05 restore", frame(0xF1, 0xB1, 0xC2, f32(0.05)), wait=0.3)

        if args.active:
            print("\n-- ACTIVE: brightness 12 then RUN 1.0V/0.05A (no load) then STOP --")
            send("D6 brightness=12", frame(0xF1, 0xB1, 0xD6, b"\x0c"), wait=0.5)
            send("DB RUN", frame(0xF1, 0xB1, 0xDB, b"\x01"), wait=2.0)
            send("DB STOP", frame(0xF1, 0xB1, 0xDB, b"\x00"), wait=0.5)
            drain_until = time.time() + 2.0
            while time.time() < drain_until:
                data = ser.read(4096)
                if data:
                    parser.feed(data, on_frame)
    finally:
        # session close (CMD_2)
        send("session-close", frame(0xF1, 0xC1, 0x00, b"\x00"), wait=0.3)
        if rx:
            rx.close()
        ser.close()
        print("\nclosed. RX frame counts by reg:")
        for k in sorted(counts):
            print(f"  0x{k:02X}: {counts[k]}")

if __name__ == "__main__":
    main()
