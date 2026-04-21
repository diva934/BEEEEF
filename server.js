const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5501;
const ROOT = __dirname;

const MIME = {
  '.html':  'text/html',
  '.css':   'text/css',
  '.js':    'application/javascript',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
  '.woff2': 'font/woff2',
};

// ─────────────────────────────────────────────────────────────
//  WebRTC Signaling — SSE push + HTTP POST relay (no npm deps)
//  Room = debate ID  ·  Peer = random UUID per session
//  GET  /signal?room=X&peer=Y  → SSE stream (offer/answer/ice)
//  POST /signal                → JSON body relayed to target peer
// ─────────────────────────────────────────────────────────────
const rooms = new Map(); // roomId → Map<peerId, ServerResponse>

function sse(res, data) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(_){}
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function handleSignal(req, res, url) {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // ── SSE stream ───────────────────────────────────────────
  if (req.method === 'GET') {
    const room = url.searchParams.get('room');
    const peer = url.searchParams.get('peer');
    if (!room || !peer) { res.writeHead(400); return res.end('Missing room/peer'); }

    res.writeHead(200, {
      ...CORS,
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    if (!rooms.has(room)) rooms.set(room, new Map());
    const peers = rooms.get(room);

    // Notify existing peers ↔ new peer of each other
    peers.forEach((existingRes, existingId) => {
      sse(existingRes, { type: 'peer_joined', peerId: peer,       polite: false }); // existing = impolite initiator
      sse(res,         { type: 'peer_joined', peerId: existingId, polite: true  }); // newcomer  = polite responder
    });

    peers.set(peer, res);

    // Keep-alive ping every 20 s
    const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch(_){} }, 20000);

    req.on('close', () => {
      clearInterval(ping);
      peers.delete(peer);
      if (peers.size === 0) rooms.delete(room);
      peers.forEach(r => sse(r, { type: 'peer_left', peerId: peer }));
    });

    return;
  }

  // ── Signal relay ─────────────────────────────────────────
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const msg   = JSON.parse(body);
        const peers = rooms.get(msg.room);
        if (peers) {
          const target = peers.get(msg.to);
          if (target) sse(target, msg);
        }
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch(e) {
        res.writeHead(400); res.end('bad json');
      }
    });
    return;
  }

  res.writeHead(405); res.end('method not allowed');
}

// ─────────────────────────────────────────────────────────────
//  Static file server
// ─────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/signal') {
    return handleSignal(req, res, url);
  }

  let filePath = url.pathname === '/' ? '/index.html.html' : url.pathname;
  filePath = path.join(ROOT, decodeURIComponent(filePath));

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`BEEEF + WebRTC signaling → http://localhost:${PORT}`));
