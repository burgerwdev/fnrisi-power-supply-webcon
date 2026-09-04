// Serial transport abstraction so protocol/UI code can run against WebSerial,
// and tests / future transports can supply bytes without a browser device.

export interface SerialTransport {
  readonly kind: string;
  /** actual baud rate the transport opened with (used for B0 announce + logs) */
  readonly baudRate: number;
  open(): Promise<void>;
  close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  /** register one reader; at most one active reader at a time */
  setDataHandler(handler: ((data: Uint8Array) => void) | null): void;
  onError?: (err: unknown) => void;
  onClose?: (reason: string) => void;
}

/** Returns true when the Web Serial API is available in this browser. */
export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export class WebSerialTransport implements SerialTransport {
  readonly kind = 'webserial';
  onError?: (err: unknown) => void;
  onClose?: (reason: string) => void;
  private port: SerialPort;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private handler: ((data: Uint8Array) => void) | null = null;
  private closed = false;
  /** diagnostics */
  rxBytes = 0;
  rxChunks = 0;
  readLoops = 0;
  flowControlUsed: 'hardware' | 'none' = 'hardware';

  constructor(port: SerialPort, readonly baudRate = 9600) {
    this.port = port;
  }

  static async requestPort(): Promise<SerialPort> {
    return navigator.serial.requestPort();
  }

  static async listPorts(): Promise<SerialPort[]> {
    return navigator.serial.getPorts();
  }

  async open(): Promise<void> {
    // Kernel-level tests show this device streams with plain 8N1 (RTS/CLOCAL do not
    // gate its TX), so 'none' is the safe default; 'hardware' is kept as fallback
    // for platforms where that matches the driver better (e.g. some Windows stacks).
    const base = {
      baudRate: this.baudRate,
      dataBits: 8 as const,
      stopBits: 1 as const,
      parity: 'none' as const,
      bufferSize: 1024,
    };
    for (const flowControl of ['none', 'hardware'] as const) {
      try {
        await this.port.open({ ...base, flowControl });
        this.flowControlUsed = flowControl;
        this.closed = false;
        // give the driver a moment to settle line states before we write/read
        await new Promise((r) => setTimeout(r, 80));
        this.startReadLoop();
        return;
      } catch (err) {
        if (flowControl === 'hardware') {
          this.onError?.(err);
          throw err;
        }
        // 'none' unsupported on this platform: retry with hardware flow
      }
    }
  }

  private async startReadLoop(): Promise<void> {
    this.readLoops++;
    let failStreak = 0;
    // Resilient: keep trying until close(); if port.readable is momentarily
    // unavailable (or a reader dies) we retry instead of silently exiting.
    while (!this.closed) {
      if (!this.port.readable) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      try {
        this.reader = this.port.readable.getReader();
      } catch (err) {
        if (++failStreak >= 4) {
          if (!this.closed) {
            this.onError?.(err instanceof Error ? err : new Error(`read stream failed: ${String(err)}`));
          }
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) {
            this.rxBytes += value.length;
            this.rxChunks++;
            failStreak = 0;
            this.handler?.(value);
          }
        }
      } catch (err) {
        if (!this.closed) {
          if (++failStreak >= 4) {
            this.onError?.(err instanceof Error ? err : new Error(`read stream failed: ${String(err)}`));
            break;
          }
          // wait a beat before retrying the stream
          await new Promise((r) => setTimeout(r, 120));
        }
      } finally {
        try {
          this.reader.releaseLock();
        } catch {
          /* ignore */
        }
        this.reader = null;
      }
    }
    if (!this.closed) this.onClose?.('read loop ended');
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.port.writable) throw new Error('port not writable');
    this.writer = this.port.writable.getWriter();
    try {
      await this.writer.write(bytes);
    } finally {
      this.writer.releaseLock();
      this.writer = null;
    }
  }

  setDataHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    this.reader = null;
    try {
      await this.writer?.close();
    } catch {
      /* ignore */
    }
    this.writer = null;
    // wait for the read loop to exit before closing the port
    await new Promise((r) => setTimeout(r, 80));
    try {
      if (this.port.writable || this.port.readable) {
        await this.port.close();
      }
    } catch (err) {
      this.onError?.(err);
    }
  }
}
