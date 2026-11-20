#!/usr/bin/env node
/* CTRL-ALT-DEFEAT LAN server — zero dependencies.
 * Serves the game files and relays WebSocket messages between a room's
 * host (the tab running the simulation) and its clients.
 * Usage: node server.js [port]   (default 8091)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2] || '8091', 10);
const ROOT = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json' };

/* ---------------- highscores (stored in data/highscores.json) ---------------- */
const DATA_DIR = path.join(ROOT, 'data');
const HS_FILE = path.join(DATA_DIR, 'highscores.json');
const HS_MAX = 20;
const CLASSES = ['sysadmin', 'helpdesk', 'devops'];
let hs = { solo: [], multi: [] };
try {
  const d = JSON.parse(fs.readFileSync(HS_FILE, 'utf8'));
  if (Array.isArray(d.solo) && Array.isArray(d.multi)) hs = d;
} catch (e) { if (e.code !== 'ENOENT') console.error('highscores unreadable, starting fresh:', e.message); }
function saveHs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = HS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(hs, null, 1));
  fs.renameSync(tmp, HS_FILE);                      // atomic replace
}
const hsSort = (a, b) => (b.time - a.time) || (b.kills - a.kills) || (a.date - b.date);
const seenRuns = new Set(), lastPost = new Map();
const RATE_MS = +(process.env.HS_RATE_MS || 3000);   // min. gap between score posts per IP
function validRun(r) {
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.runId !== 'string' || !/^[a-z0-9]{8,32}$/.test(r.runId)) return null;
  if (!int(r.time, 10, 6 * 3600) || !int(r.kills, 0, 1e6) || !int(r.level, 1, 999) || !int(r.bosses, 0, 999)) return null;
  if (!Array.isArray(r.players) || r.players.length < 1 || r.players.length > 4) return null;
  const players = [];
  for (const p of r.players) {
    if (!p || typeof p.n !== 'string' || !CLASSES.includes(p.c)) return null;
    const n = p.n.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16) || 'Admin';
    players.push({ n, c: p.c });
  }
  return { id: r.runId, time: r.time, kills: r.kills, level: r.level, bosses: r.bosses, players, date: Date.now() };
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function handleApi(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, hs);
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
  const ip = req.socket.remoteAddress || '?', now = Date.now();
  if (now - (lastPost.get(ip) || 0) < RATE_MS) return sendJson(res, 429, { error: 'slow down' });
  lastPost.set(ip, now);
  let body = '', tooBig = false;
  req.on('data', c => { body += c; if (body.length > 4096) { tooBig = true; req.destroy(); } });
  req.on('end', () => {
    if (tooBig) return;
    let r; try { r = validRun(JSON.parse(body)); } catch (e) { r = null; }
    if (!r) return sendJson(res, 400, { error: 'invalid run' });
    if (seenRuns.has(r.id)) return sendJson(res, 409, { error: 'already submitted' });
    seenRuns.add(r.id);
    const list = r.players.length > 1 ? 'multi' : 'solo';
    hs[list].push(r); hs[list].sort(hsSort); hs[list] = hs[list].slice(0, HS_MAX);
    const rank = hs[list].findIndex(e => e.id === r.id) + 1 || null;
    if (rank) { try { saveHs(); } catch (e) { console.error('highscore save failed:', e.message); } }
    console.log(`score ${list} ${r.time}s ${r.kills} kills [${r.players.map(p => p.n).join(', ')}] -> ${rank ? '#' + rank : 'not ranked'}`);
    sendJson(res, 200, { ok: true, list, rank, id: r.id, ...hs });
  });
}

/* ---------------- HTTP: API + static (only the game page is served) ---------------- */
const PUBLIC = new Set(['/index.html']);
const server = http.createServer((req, res) => {
  let p; try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); return res.end('bad url'); }
  if (p === '/api/highscores') return handleApi(req, res);
  if (p === '/') p = '/index.html';
  if (!PUBLIC.has(p)) { res.writeHead(404); return res.end('not found'); }
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

/* ---------------- WebSocket framing ---------------- */
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_BIN = 0x2, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA;
function encodeFrame(buf, opcode) {
  const len = buf.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, buf]);
}
function makeParser(onFrame) {
  let chunks = [], total = 0;
  return (buf) => {
    chunks.push(buf); total += buf.length;
    let pos = 0;
    for (;;) {
      const avail = () => total - pos;
      if (avail() < 2) break;
      const flat = Buffer.concat(chunks);          // simple full re-concat (messages are small)
      chunks = [flat.subarray(pos)]; total = flat.length - pos; pos = 0;
      const b0 = chunks[0][0], b1 = chunks[0][1];
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (avail() < 4) break; len = chunks[0].readUInt16BE(2); off = 4; }
      else if (len === 127) { if (avail() < 10) break; len = Number(chunks[0].readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (avail() < off + 4) break; mask = chunks[0].subarray(off, off + 4); off += 4; }
      if (avail() < off + len) break;
      let payload = Buffer.from(chunks[0].subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      onFrame(fin, opcode, payload);
      const used = off + len;
      chunks = [chunks[0].subarray(used)]; total = chunks[0].length;
      if (total === 0) { chunks = []; total = 0; }
    }
  };
}

/* ---------------- rooms / relay ---------------- */
const MAX_PLAYERS = 4;
const rooms = new Map();   // CODE -> { host: conn, conns: Map(id->conn), nextId }
const clients = new Set();
let nextRoomCode = '';
function newCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)]; } while (rooms.has(c) || c === nextRoomCode);
  return nextRoomCode = c;
}
function send(ws, obj) { try { ws.socket.write(encodeFrame(Buffer.from(JSON.stringify(obj)), OP_TEXT)); } catch (e) {} }
function relay(room, data, fromId) {
  for (const [, conn] of room.conns) if (conn.id !== fromId) send(conn, { t: 'relay', from: fromId, data });
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { socket, room: null, id: 0 };
  clients.add(c);
  const parser = makeParser((fin, opcode, payload) => {
    if (opcode === OP_CLOSE) { cleanup(); return; }
    if (opcode === OP_PING) { socket.write(encodeFrame(payload, OP_PONG)); return; }
    if (opcode !== OP_TEXT && opcode !== OP_CONT) return;
    let m; try { m = JSON.parse(payload.toString('utf8')); } catch (e) { return; }
    handle(c, m);
  });
  socket.on('data', parser);
  socket.on('error', cleanup);
  socket.on('close', cleanup);
  function cleanup() {
    if (!clients.has(c)) return;
    clients.delete(c);
    try { socket.destroy(); } catch (e) {}
    leaveRoom(c);
  }
});

function leaveRoom(c) {
  const room = c.room;
  if (!room) return;
  c.room = null;
  room.conns.delete(c.id);
  if (c.id === room.hostId) {               // host left -> close room, notify clients
    for (const oc of room.conns.values()) { send(oc, { t: 'hostleft' }); oc.room = null; }
    rooms.delete(room.code);
    console.log(`room ${room.code} closed`);
  } else {
    const host = room.conns.get(room.hostId);
    if (host) send(host, { t: 'relay', from: c.id, data: { k: 'peer-leave', id: c.id } });
    console.log(`left ${room.code}: id ${c.id}`);
  }
}

function handle(c, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') {
    leaveRoom(c);                           // re-host / re-join on the same socket
    if (m.role === 'host') {
      const code = newCode();
      const room = { code, conns: new Map(), nextId: 1, hostId: 0 };
      c.id = room.nextId++; room.hostId = c.id; c.__id = c.id;
      room.conns.set(c.id, c);
      rooms.set(code, room);
      c.room = room;
      send(c, { t: 'welcome', id: c.id, role: 'host', code });
      console.log(`room ${code} hosted`);
    } else {
      const code = String(m.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(c, { t: 'err', msg: 'room ' + code + ' not found' }); return; }
      if (room.conns.size >= MAX_PLAYERS) { send(c, { t: 'err', msg: 'room ' + code + ' is full' }); return; }
      c.id = room.nextId++;
      room.conns.set(c.id, c);
      c.room = room;
      send(c, { t: 'welcome', id: c.id, role: 'client', code, hostId: room.hostId });
      const host = room.conns.get(room.hostId);
      if (host) send(host, { t: 'relay', from: c.id, data: { k: 'peer-join', id: c.id } });
      console.log(`joined ${code}: id ${c.id}`);
    }
  } else if (c.room && m.k !== undefined) {
    // host -> all clients; client -> host only (clients don't need each other's input)
    if (c.id === c.room.hostId) relay(c.room, m, c.id);
    else { const host = c.room.conns.get(c.room.hostId); if (host) send(host, { t: 'relay', from: c.id, data: m }); }
  }
}

process.on('uncaughtException', e => console.error('uncaught:', e));
server.listen(PORT, () => {
  console.log('CTRL-ALT-DEFEAT MP server up');
  console.log('  open   http://THIS-IP:' + PORT);
  for (const ifs of Object.values(require('os').networkInterfaces()))
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) console.log('  e.g.   http://' + i.address + ':' + PORT);
});
