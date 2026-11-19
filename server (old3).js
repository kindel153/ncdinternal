const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Where the crew board's shared data lives. Point DATA_DIR at a Railway volume
// mount so it survives redeploys, not just page refreshes.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'board.json');
const META_FILE = path.join(DATA_DIR, 'board-meta.json');
const HIST_DIR = path.join(DATA_DIR, 'history');
const HIST_INDEX = path.join(HIST_DIR, 'index.json');

// Version-history tuning (overridable so tests can run fast).
const BURST_GAP_MS = Number(process.env.BURST_GAP_MS) || 60 * 1000;        // pause that ends an editing burst
const MAX_BURST_MS = Number(process.env.MAX_BURST_MS) || 3 * 60 * 1000;    // longest stretch before a checkpoint
const MAX_AUTO_VERSIONS = Number(process.env.MAX_AUTO_VERSIONS) || 400;   // named versions are never pruned
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS) || 120;
const BIG_CHANGE_ASSIGNMENTS = 8;                                          // this many moves in one save = checkpoint first
const MAX_BODY_BYTES = 5 * 1024 * 1024;

try { fs.mkdirSync(HIST_DIR, { recursive: true }); } catch (e) { /* already exists */ }

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

// ---------- small helpers ----------
function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function sha(text) { return crypto.createHash('sha1').update(text).digest('hex'); }
function safeParse(t) { try { return JSON.parse(t); } catch (e) { return null; } }
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, res, cb) {
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
  req.on('end', () => { if (!aborted) cb(body); });
}

// ---------- current board state ----------
// text is the exact JSON the clients see; rev increases by one on every real change.
const current = { text: null, rev: 0, lastWriteTs: 0, burstStartTs: 0 };
try { current.text = fs.readFileSync(DATA_FILE, 'utf8'); } catch (e) { /* no board yet */ }
try {
  const m = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  current.rev = m.rev || 0;
  current.lastWriteTs = m.lastWriteTs || 0;
  current.burstStartTs = m.burstStartTs || 0;
} catch (e) { /* no meta yet */ }
if (current.text && !current.rev) {
  // Board saved by the older server: adopt it as revision 1.
  current.rev = 1;
  try { current.lastWriteTs = Math.round(fs.statSync(DATA_FILE).mtimeMs); } catch (e) { current.lastWriteTs = Date.now(); }
  current.burstStartTs = current.lastWriteTs;
}

function persistCurrent() {
  atomicWrite(DATA_FILE, current.text);
  atomicWrite(META_FILE, JSON.stringify({
    rev: current.rev, lastWriteTs: current.lastWriteTs, burstStartTs: current.burstStartTs,
  }));
}

// ---------- change summaries ----------
function idMap(arr) { return new Map((arr || []).filter(x => x && x.id).map(x => [x.id, x])); }

function diffCounts(a, b) {
  const c = {
    techsAdded: 0, techsRemoved: 0, techsEdited: 0,
    districtsAdded: 0, districtsRemoved: 0, districtsRenamed: 0,
    weeksAdded: 0, weeksRemoved: 0, weeksChanged: 0,
    assignments: 0, notes: 0, cellNotes: 0, archived: 0, archiveChanged: 0,
  };
  const ta = idMap(a.techs), tb = idMap(b.techs);
  tb.forEach((v, k) => {
    if (!ta.has(k)) c.techsAdded++;
    else if (JSON.stringify(ta.get(k)) !== JSON.stringify(v)) c.techsEdited++;
  });
  ta.forEach((v, k) => { if (!tb.has(k)) c.techsRemoved++; });

  const da = idMap(a.districts), db = idMap(b.districts);
  db.forEach((v, k) => {
    if (!da.has(k)) c.districtsAdded++;
    else if (da.get(k).label !== v.label) c.districtsRenamed++;
  });
  da.forEach((v, k) => { if (!db.has(k)) c.districtsRemoved++; });

  const wa = idMap(a.weeks), wb = idMap(b.weeks);
  wb.forEach((v, k) => {
    if (!wa.has(k)) c.weeksAdded++;
    else if (wa.get(k).date !== v.date) c.weeksChanged++;
  });
  wa.forEach((v, k) => { if (!wb.has(k)) c.weeksRemoved++; });

  // week-level assignments, only for weeks and techs that exist on both sides
  const pa = a.placements || {}, pb = b.placements || {};
  wb.forEach((w, wid) => {
    if (!wa.has(wid)) return;
    tb.forEach((t, tid) => {
      if (!ta.has(tid)) return;
      const x = (pa[wid] && pa[wid][tid]) || { districtId: 'bench', note: '' };
      const y = (pb[wid] && pb[wid][tid]) || { districtId: 'bench', note: '' };
      if (x.districtId !== y.districtId) c.assignments++;
      else if ((x.note || '') !== (y.note || '')) c.notes++;
    });
  });
  // day-level overrides
  const xa = a.dayPlacements || {}, xb = b.dayPlacements || {};
  new Set([...Object.keys(xa), ...Object.keys(xb)]).forEach(key => {
    const wid = key.split(':')[0];
    if (!wa.has(wid) || !wb.has(wid)) return;
    new Set([...Object.keys(xa[key] || {}), ...Object.keys(xb[key] || {})]).forEach(tid => {
      if (!ta.has(tid) || !tb.has(tid)) return;
      if (JSON.stringify((xa[key] || {})[tid] || null) !== JSON.stringify((xb[key] || {})[tid] || null)) c.assignments++;
    });
  });
  // district notes
  const na = a.cellNotes || {}, nb = b.cellNotes || {};
  new Set([...Object.keys(na), ...Object.keys(nb)]).forEach(key => {
    const wid = key.split(':')[0];
    if (!wa.has(wid) || !wb.has(wid)) return;
    new Set([...Object.keys(na[key] || {}), ...Object.keys(nb[key] || {})]).forEach(did => {
      if (((na[key] || {})[did] || '') !== ((nb[key] || {})[did] || '')) c.cellNotes++;
    });
  });
  // archive
  const arA = (a.archive || []).length, arB = (b.archive || []).length;
  if (arB > arA) { c.archived = arB - arA; c.weeksRemoved = Math.max(0, c.weeksRemoved - c.archived); }
  else if (arB < arA) c.archiveChanged = arA - arB;
  return c;
}

function describeCounts(c) {
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const parts = [];
  if (c.assignments) parts.push(plural(c.assignments, 'assignment') + ' changed');
  if (c.notes) parts.push(plural(c.notes, 'tech note') + ' edited');
  if (c.cellNotes) parts.push(plural(c.cellNotes, 'district note') + ' edited');
  if (c.techsAdded) parts.push(plural(c.techsAdded, 'tech') + ' added');
  if (c.techsRemoved) parts.push(plural(c.techsRemoved, 'tech') + ' removed');
  if (c.techsEdited) parts.push(plural(c.techsEdited, 'profile') + ' edited');
  if (c.districtsAdded) parts.push(plural(c.districtsAdded, 'district') + ' added');
  if (c.districtsRemoved) parts.push(plural(c.districtsRemoved, 'district') + ' removed');
  if (c.districtsRenamed) parts.push(plural(c.districtsRenamed, 'district') + ' renamed');
  if (c.weeksAdded) parts.push(plural(c.weeksAdded, 'week') + ' added');
  if (c.weeksRemoved) parts.push(plural(c.weeksRemoved, 'week') + ' removed');
  if (c.weeksChanged) parts.push(plural(c.weeksChanged, 'week date') + ' changed');
  if (c.archived) parts.push(plural(c.archived, 'week') + ' archived');
  if (c.archiveChanged) parts.push('archive changed');
  return parts.join(', ');
}

function diffSummary(aText, bText) {
  const a = safeParse(aText), b = safeParse(bText);
  if (!a || !b) return '';
  return describeCounts(diffCounts(a, b)) || 'Minor changes';
}

function isBigChange(c) {
  return c.techsRemoved > 0 || c.districtsRemoved > 0 || c.weeksRemoved > 0 || c.archived > 0 ||
    c.archiveChanged > 0 || c.assignments >= BIG_CHANGE_ASSIGNMENTS;
}

// ---------- version history ----------
// hist is kept oldest -> newest. Each entry's board text lives in its own file.
let hist = [];
try { hist = JSON.parse(fs.readFileSync(HIST_INDEX, 'utf8')); } catch (e) { hist = []; }
if (!Array.isArray(hist)) hist = [];

function histFile(id) { return path.join(HIST_DIR, id + '.board.json'); }
function saveHistIndex() { atomicWrite(HIST_INDEX, JSON.stringify(hist)); }
function validHistId(id) { return /^\d+-\d+(?:-\d+)?$/.test(id || ''); }

function pruneHistory() {
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  const drop = new Set();
  const autos = hist.filter(h => !h.named);
  autos.forEach(h => { if (h.ts < cutoff) drop.add(h.id); });
  const kept = autos.filter(h => !drop.has(h.id));
  for (let i = 0; i < kept.length - MAX_AUTO_VERSIONS; i++) drop.add(kept[i].id);
  if (drop.size) {
    hist = hist.filter(h => !drop.has(h.id));
    drop.forEach(id => { try { fs.unlinkSync(histFile(id)); } catch (e) { /* already gone */ } });
  }
}

// Records a version. Automatic ones are skipped when identical to the newest version.
function snapshot(text, ts, rev, opts) {
  opts = opts || {};
  const hash = sha(text);
  const newest = hist.length ? hist[hist.length - 1] : null;
  if (!opts.named && newest && newest.hash === hash) return null;

  ts = Math.round(ts);
  let id = ts + '-' + rev;
  for (let n = 1; hist.some(h => h.id === id); n++) id = ts + '-' + rev + '-' + n;

  let summary = 'Earliest saved version';
  if (newest) {
    try { summary = diffSummary(fs.readFileSync(histFile(newest.id), 'utf8'), text); } catch (e) { summary = ''; }
  }
  const entry = {
    id, ts, rev, hash,
    label: opts.label || '',
    named: !!opts.named,
    summary: summary || (opts.named ? 'No changes since the previous version' : 'Minor changes'),
  };
  fs.writeFileSync(histFile(id), text, 'utf8');
  hist.push(entry);
  pruneHistory();
  saveHistIndex();
  return entry;
}

// ---------- live updates (server-sent events) ----------
const clients = new Set();
function sseSend(res, event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
function broadcast(event, data) {
  clients.forEach(c => { try { sseSend(c, event, data); } catch (e) { clients.delete(c); } });
}
setInterval(() => {
  clients.forEach(c => { try { c.write(': ping\n\n'); } catch (e) { clients.delete(c); } });
}, 20000).unref();

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  sseSend(res, 'hello', { rev: current.rev, count: clients.size });
  broadcast('viewers', { count: clients.size });
  req.on('close', () => {
    clients.delete(res);
    broadcast('viewers', { count: clients.size });
  });
}

// ---------- committing a new board ----------
function commit(newText) {
  const now = Date.now();
  if (current.text) {
    const gap = now - current.lastWriteTs;
    let checkpoint = gap > BURST_GAP_MS || (now - current.burstStartTs) > MAX_BURST_MS;
    if (!checkpoint) {
      // a destructive or bulk change gets a checkpoint of the board as it was just before
      const a = safeParse(current.text), b = safeParse(newText);
      if (a && b && isBigChange(diffCounts(a, b))) checkpoint = true;
    }
    if (checkpoint) {
      snapshot(current.text, current.lastWriteTs || now, current.rev);
      current.burstStartTs = now;
    }
  } else {
    current.burstStartTs = now;
  }
  current.text = newText;
  current.rev += 1;
  current.lastWriteTs = now;
  persistCurrent();
  broadcast('rev', { rev: current.rev });
  return current.rev;
}

function validBoard(b) {
  return b && typeof b === 'object' && Array.isArray(b.techs) && Array.isArray(b.weeks) &&
    Array.isArray(b.districts) && b.placements && typeof b.placements === 'object';
}

// ---------- API ----------
function handleGetBoard(req, res) {
  sendJSON(res, 200, { value: current.text, rev: current.rev });
}

function handlePostBoard(req, res) {
  readBody(req, res, body => {
    const parsed = safeParse(body);
    if (!parsed || typeof parsed !== 'object') { sendJSON(res, 400, { error: 'Invalid JSON' }); return; }

    // Older pages post the bare board and always win; newer pages send { baseRev, board }.
    const legacy = Array.isArray(parsed.techs);
    const board = legacy ? parsed : parsed.board;
    if (!validBoard(board)) { sendJSON(res, 400, { error: 'Not a crew board' }); return; }
    const newText = JSON.stringify(board);

    if (!legacy && !parsed.force && parsed.baseRev !== current.rev) {
      if (newText === current.text) { sendJSON(res, 200, { ok: true, rev: current.rev }); return; }
      sendJSON(res, 409, { conflict: true, rev: current.rev, value: current.text });
      return;
    }
    if (newText === current.text) { sendJSON(res, 200, { ok: true, rev: current.rev, unchanged: true }); return; }
    try {
      const rev = commit(newText);
      sendJSON(res, 200, { ok: true, rev });
    } catch (e) {
      console.error('Write failed:', e);
      sendJSON(res, 500, { error: 'Write failed' });
    }
  });
}

function listHistory() {
  return hist.slice().reverse().map(h => ({
    id: h.id, ts: h.ts, label: h.label, named: h.named, summary: h.summary,
  }));
}

function handleHistory(req, res, reqPath) {
  const parts = reqPath.split('/').filter(Boolean); // ['api','history', id?, 'restore'?]
  const id = parts[2];

  if (!id) {
    if (req.method === 'GET') { sendJSON(res, 200, { versions: listHistory(), rev: current.rev }); return; }
    if (req.method === 'POST') {
      readBody(req, res, body => {
        const parsed = safeParse(body) || {};
        const label = String(parsed.label || '').trim().slice(0, 120);
        if (!label) { sendJSON(res, 400, { error: 'A name is required' }); return; }
        if (!current.text) { sendJSON(res, 400, { error: 'Nothing to save yet' }); return; }
        const entry = snapshot(current.text, Date.now(), current.rev, { named: true, label });
        sendJSON(res, 200, { ok: true, version: { id: entry.id, ts: entry.ts, label: entry.label, named: true, summary: entry.summary } });
      });
      return;
    }
  } else if (validHistId(id)) {
    const entry = hist.find(h => h.id === id);
    if (!entry) { sendJSON(res, 404, { error: 'Version not found' }); return; }
    if (parts[3] === 'restore' && req.method === 'POST') {
      let text;
      try { text = fs.readFileSync(histFile(id), 'utf8'); } catch (e) { sendJSON(res, 404, { error: 'Version data missing' }); return; }
      if (current.text) {
        const when = new Date(entry.ts).toISOString();
        snapshot(current.text, Date.now(), current.rev, { named: true, label: 'Before restoring the ' + when + ' version' });
      }
      current.lastWriteTs = 0; // make the restore start a fresh editing burst
      const rev = text === current.text ? current.rev : commit(text);
      sendJSON(res, 200, { ok: true, rev });
      return;
    }
    if (!parts[3] && req.method === 'GET') {
      let text;
      try { text = fs.readFileSync(histFile(id), 'utf8'); } catch (e) { sendJSON(res, 404, { error: 'Version data missing' }); return; }
      sendJSON(res, 200, { id: entry.id, ts: entry.ts, label: entry.label, named: entry.named, summary: entry.summary, value: text });
      return;
    }
  }
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
}

http.createServer((req, res) => {
  let reqPath;
  try { reqPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('Bad request'); return; }

  if (reqPath === '/api/board') {
    if (req.method === 'GET') return handleGetBoard(req, res);
    if (req.method === 'POST') return handlePostBoard(req, res);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }
  if (reqPath === '/api/events' && req.method === 'GET') return handleEvents(req, res);
  if (reqPath === '/api/history' || reqPath.indexOf('/api/history/') === 0) return handleHistory(req, res, reqPath);

  let filePathReq = reqPath;
  if (filePathReq === '/') filePathReq = '/index.html';
  const filePath = path.join(ROOT, filePathReq);

  // prevent path traversal outside the site root, and never serve the data folder
  if (!filePath.startsWith(ROOT) || filePath === DATA_DIR || filePath.startsWith(DATA_DIR + path.sep)) {
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
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('NCD Internal site running on port ' + PORT);
});
