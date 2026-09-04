// WebSocket serial transport: connects to tools/bridge.cjs (local serial proxy).
// Used when the app is opened with ?proxy=ws://127.0.0.1:8787 — a stable automation
// path that bypasses the flaky Chrome WebSerial read channel on WSL.
import { t } from '../i18n';
import type { SerialTransport } from './transport';

export class WebSocketTransport implements SerialTransport {
  readonly kind = 'proxy-ws';
  onError?: (err: unknown) => void;
  onClose?: (reason: string) => void;
  private ws: WebSocket | null = null;
  private handler: ((data: Uint8Array) => void) | null = null;
  private closed = true;

  constructor(
    readonly url: string,
    readonly baudRate = 9600,
  ) {}

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closed = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => resolve();
      ws.onerror = () => {
        // open failure: report once through the rejection (no onError noise)
        if (!this.closed) reject(new Error(t('log.proxyFail').replace('{url}', this.url)));
      };
      ws.onclose = () => {
        if (!this.closed) this.onClose?.('proxy closed');
      };
      ws.onmessage = (ev) => {
        const data = ev.data as ArrayBuffer;
        if (data) this.handler?.(new Uint8Array(data));
      };
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('proxy not open');
    ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }

  setDataHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
