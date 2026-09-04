#!/usr/bin/env python3
"""Serial <-> stdin/stdout hex-line pipe used by tools/bridge.cjs.
Reads /dev/ttyACM0, prints each RX chunk as one hex line (flush);
consumes hex lines from stdin and writes them to the serial port.
Usage: python3 tools/serialpipe.py [port] [baud]
"""
import binascii
import sys
import threading
import time

import serial


def main():
    port = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyACM0"
    baud = int(sys.argv[2]) if len(sys.argv) > 2 else 9600
    ser = serial.Serial(port, baud, timeout=0.1)
    sys.stdout.write(f"# serialpipe open {port} @ {baud}\n")
    sys.stdout.flush()

    def reader():
        while True:
            try:
                data = ser.read(4096)
            except Exception as e:
                sys.stdout.write(f"# serialpipe read error: {e}\n")
                sys.stdout.flush()
                break
            if data:
                sys.stdout.write(binascii.hexlify(data).decode() + "\n")
                sys.stdout.flush()

    threading.Thread(target=reader, daemon=True).start()
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            ser.write(binascii.unhexlify(line))
    finally:
        ser.close()


if __name__ == "__main__":
    main()
