#!/usr/bin/env node
// Serial proxy bridge: WebSocket <-> /dev/ttyACM0 via tools/serialpipe.py.
// Purpose: let automated UI tests (and manual fallback) drive the real device through
// a stable local WebSocket, avoiding the WSL Chrome WebSerial read-channel hang.
// Browser usage: open the app with ?proxy=ws://127.0.0.1:8787
// Usage: node tools/bridge.cjs [baud] [wsPort]
const { spawn } = require('child_process');
const path = require('path');
const { WebSocketServer } = require('ws');

const baud = Number(process.argv[2] || process.env.BAUD || 9600);
const wsPort = Number(process.argv[3] || process.env.WSPORT || 8787);
const port = process.env.SERIAL || '/dev/ttyACM0';

const py = spawn('python3', [path.join(__dirname, 'serialpipe.py'), port, String(baud)], { stdio: ['pipe', 'pipe', 'pipe'] });
py.stdout.setEncoding('utf8');
py.stderr.setEncoding('utf8');

const wss = new WebSocketServer({ host: '127.0.0.1', port: wsPort });
const clients = new Set();

function sendHex(line) {
  if (py.stdin.writable) py.stdin.write(line + '\n');
}

py.stdout.on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      console.log(line.slice(1).trim());
      continue;
    }
    const buf = Buffer.from(line.trim(), 'hex');
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(buf);
    }
  }
});
py.stderr.on('data', (d) => console.error('[serialpipe]', String(d).trim()));

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('client connected, total', clients.size);
  ws.on('message', (data) => {
    if (typeof data === 'string') return; // ignore text frames
    sendHex(Buffer.from(data).toString('hex'));
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', (e) => console.error('ws error', e.message));
});

console.log(`[bridge] serial=${port}@${baud} ws=ws://127.0.0.1:${wsPort} (Ctrl+C to exit)`);
process.on('SIGINT', () => {
  py.kill();
  wss.close();
  process.exit(0);
});
py.on('exit', (c) => {
  console.error('[serialpipe] exited', c);
  process.exit(1);
});
