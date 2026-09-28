const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Where the crew board's shared data is persisted. Point DATA_DIR at a
// Railway volume mount so it survives redeploys, not just page refreshes.
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'board.json');

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* already exists */ }

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB is far more than the board will ever need

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function handleGetBoard(req, res) {
  fs.readFile(DATA_FILE, 'utf8', (err, data) => {
    if (err) { sendJSON(res, 200, { value: null }); return; }
    sendJSON(res, 200, { value: data });
  });
}

function handlePostBoard(req, res) {
  let body = '';
  let aborted = false;

  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end('Payload too large');
      req.destroy();
    }
  });

  req.on('end', () => {
    if (aborted) return;
    try {
      JSON.parse(body); // validate before persisting a bad write
    } catch (e) {
      sendJSON(res, 400, { error: 'Invalid JSON' });
      return;
    }
    fs.writeFile(DATA_FILE, body, 'utf8', (err) => {
      if (err) { sendJSON(res, 500, { error: 'Write failed' }); return; }
      sendJSON(res, 200, { ok: true });
    });
  });
}

http.createServer((req, res) => {
  const reqPath = decodeURIComponent(req.url.split('?')[0]);

  if (reqPath === '/api/board') {
    if (req.method === 'GET') return handleGetBoard(req, res);
    if (req.method === 'POST') return handlePostBoard(req, res);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }

  let filePathReq = reqPath;
  if (filePathReq === '/') filePathReq = '/index.html';

  const filePath = path.join(ROOT, filePathReq);

  // prevent path traversal outside the site root
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('NCD Internal site running on port ' + PORT);
});
