// Robust byte-stream frame parser with checksum re-sync.
// Feed raw bytes from the serial port; complete valid frames are emitted in order.

import { parseFrame, type Frame } from './frame';

export const MAX_FRAME_LEN = 260; // payload <= 255

export class FrameParser {
  private buf: Uint8Array = new Uint8Array(0);

  /** @returns number of frames emitted */
  push(data: Uint8Array, onFrame: (f: Frame) => void): number {
    if (data.length === 0) return 0;
    const merged = new Uint8Array(this.buf.length + data.length);
    merged.set(this.buf);
    merged.set(data, this.buf.length);
    this.buf = merged;
    let emitted = 0;

    while (true) {
      // find plausible header start (device frames start 0xf0, host 0xf1)
      let start = 0;
      while (start + 3 < this.buf.length) {
        const b = this.buf[start];
        if (b === 0xf0 || b === 0xf1) break;
        start++;
      }
      if (start > 0) this.buf = this.buf.subarray(start);
      if (this.buf.length < 4) return emitted;
      const len = this.buf[3];
      const total = len + 5;
      if (total > MAX_FRAME_LEN || len > 255) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (this.buf.length < total) return emitted;
      const candidate = this.buf.subarray(0, total);
      const frame = parseFrame(candidate);
      if (!frame.checksumOk) {
        // false header alignment -> drop one byte and resync
        this.buf = this.buf.subarray(1);
        continue;
      }
      onFrame(frame);
      emitted++;
      this.buf = this.buf.subarray(total);
    }
  }

  get pendingBytes(): number {
    return this.buf.length;
  }
}
