// Legacy local static file server. Railway uses server.js at the repo root
// as a thin backend entrypoint.
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
//  Static file server
// ─────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  let filePath = url.pathname === '/' ? '/index.html.html' : url.pathname;
  filePath = path.join(ROOT, decodeURIComponent(filePath));

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`BEEEF static server → http://localhost:${PORT}`));
