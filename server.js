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

/* ---------------- persistent storage (data/*.json, atomic writes) ---------------- */
const DATA_DIR = path.join(ROOT, 'data');
const HS_FILE = path.join(DATA_DIR, 'highscores.json');
const TK_FILE = path.join(DATA_DIR, 'tickets.json');
function loadJson(file, def, valid) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (valid(d)) return d; console.error(file + ': unexpected content, starting fresh'); }
  catch (e) { if (e.code !== 'ENOENT') console.error(file + ' unreadable, starting fresh:', e.message); }
  return def;
}
function saveJson(file, obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { console.error('save failed ' + file + ':', e.message); return false; }
}
const cleanText = (v, max) => typeof v === 'string'
  ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : '';

/* ---------------- rate limits / admin ---------------- */
const RATE_SCALE = process.env.RATE_SCALE !== undefined ? +process.env.RATE_SCALE : 1;   // 0 disables (tests)
const lastHit = new Map();
function limited(ip, what, ms) {
  const k = what + '|' + ip, now = Date.now();
  if (now - (lastHit.get(k) || 0) < ms * RATE_SCALE) return true;
  lastHit.set(k, now); return false;
}
const ADMIN_PW = (() => {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const f = process.env.ADMIN_PASSWORD_FILE;
  if (f) { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { console.error('admin password file unreadable:', e.message); } }
  return '';
})();
if (!ADMIN_PW) console.log('admin functions disabled (no ADMIN_PASSWORD / ADMIN_PASSWORD_FILE)');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const adminFails = new Map();          // ip -> { n, until }
function adminCheck(req) {             // 'ok' | 'none' | 'bad' | 'locked' | 'disabled'
  const key = req.headers['x-admin-key'];
  if (!key) return 'none';
  if (!ADMIN_PW) return 'disabled';
  const ip = req.socket.remoteAddress || '?', f = adminFails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return 'locked';
  if (crypto.timingSafeEqual(sha(key), sha(ADMIN_PW))) { adminFails.delete(ip); return 'ok'; }
  f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60 * 1000; f.n = 0; console.log('admin login locked for ' + ip); }
  adminFails.set(ip, f); return 'bad';
}
function requireAdmin(req, res) {
  const a = adminCheck(req);
  if (a === 'ok') return true;
  const msg = { none: 'admin only', bad: 'wrong admin password', locked: 'too many wrong passwords - wait 5 minutes', disabled: 'admin is not configured on the server' }[a];
  sendJson(res, a === 'disabled' ? 503 : a === 'locked' ? 429 : 403, { error: msg });
  return false;
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, res, max, cb) {
  let body = '', tooBig = false;
  req.on('data', c => { if (tooBig) return; body += c; if (body.length > max) { tooBig = true; sendJson(res, 413, { error: 'too large' }); req.destroy(); } });
  req.on('end', () => { if (tooBig) return; let o = null; try { o = JSON.parse(body); } catch (e) {} if (!o || typeof o !== 'object') return sendJson(res, 400, { error: 'invalid json' }); cb(o); });
}

/* ---------------- highscores (written by the server only) ---------------- */
const HS_MAX = 20, MIN_RUN_S = 10;
// Seasons: the current lists are ranked by points; finished seasons stay readable in `archive`.
const SEASON = 2, SEASON_NAME = 'Season 2 · v1.3+ · ranked by points';
let hs = loadJson(HS_FILE, { solo: [], multi: [] }, d => Array.isArray(d.solo) && Array.isArray(d.multi));
if (!hs.season) {                                   // v1.0-v1.2 file: time-ranked lists -> archive as season 1
  hs = { season: SEASON, name: SEASON_NAME, solo: [], multi: [],
    archive: [{ season: 1, name: 'Season 1 · v1.0–v1.2 · ranked by time', rankedBy: 'time', solo: hs.solo, multi: hs.multi }] };
  if (hs.archive[0].solo.length + hs.archive[0].multi.length) { saveJson(HS_FILE, hs); console.log('highscores: season 1 archived, season 2 started'); }
}
hs.archive = hs.archive || [];
const hsSort = (a, b) => (b.score - a.score) || (b.time - a.time) || (a.date - b.date);
function insertScore(entry) {
  const list = entry.players.length > 1 ? 'multi' : 'solo';
  hs[list].push(entry); hs[list].sort(hsSort); hs[list] = hs[list].slice(0, HS_MAX);
  const rank = hs[list].findIndex(e => e.id === entry.id) + 1 || null;
  if (rank) saveJson(HS_FILE, hs);
  return { list, rank };
}

/* ---------------- anti-cheat: the server watches every run ----------------
 * The host's browser simulates the game and streams 20 Hz snapshots through this
 * server (solo runs too). Each snapshot is checked against the game rules below;
 * the score is recorded from what the server saw, never from what a client claims.
 * Keep these numbers in sync with CHARS / fireWeapon / PDEF in index.html.        */
const CLS = [
  { id: 'sysadmin', hp: 110, spd: 135,        dmg: 1.2 },
  { id: 'helpdesk', hp: 85,  spd: 138 * 1.25, dmg: 1 },
  { id: 'devops',   hp: 135, spd: 125,        dmg: 1 },
];
const WIDS = ['mouse', 'toner', 'shout', 'badge', 'ping', 'keyboard', 'whip'];          // WDEF order
const PIDS = ['coffee', 'dmg', 'atk', 'boots', 'area', 'xpup', 'magnet', 'crit', 'glasses'];   // PDEF order
const WDMG = { mouse: [14, 6], toner: [9, 3], shout: [4, 2], badge: [9, 2], ping: [22, 6], keyboard: [20, 7], whip: [24, 7] };   // base, +per level
const PTS = [1, 2, 3, 4, 6, 50, 1, 1000];          // points per printer type, EIDS order: usb inkjet router fax laser golem blob boss
const PTS_PER_SECOND = 2;
const MAX_HP_BONUS = 100, MAX_SPEED_MUL = 1.4 * 1.2, MAX_WEAPONS = 6, MAX_WLVL = 5;   // boots 5 x coffee rush
const XP_NEED = [0, 0];                // total XP needed to reach level L
for (let L = 2, next = 8, sum = 0; L <= 200; L++) { sum += next; XP_NEED[L] = sum; next = Math.round(next * 1.32); }
const fmtNames = r => [...r.roster.values()].map(p => p.n).join(', ');

function witness(room, S) {
  const t = +S.t, now = Date.now();
  if (!Number.isFinite(t) || !Array.isArray(S.p)) return;
  let r = room.run;
  if (!r) r = room.run = { start: now - t * 1000, lastT: t, roster: new Map(), pos: new Map(), kills: new Map(),
    level: 1, maxEid: 0, maxHit: 0, bosses: 0, flags: [], done: false, alive: new Map(), gone: new Set(), pts: 0, destroyed: 0,
    unranked: t > 5 ? 'the server only saw part of this shift' : '' };
  if (r.done) return;
  const flag = msg => { if (r.flags.length < 4 && !r.flags.includes(msg)) r.flags.push(msg); };
  // game clock: may lag behind real time (pauses, slow PCs), never run ahead
  if (t < r.lastT - 0.11) flag('game clock ran backwards');
  if (t > (now - r.start) / 1000 + 3) flag('game clock ran faster than real time');
  for (const a of S.p) {
    if (!Array.isArray(a)) continue;
    const [id, x, y, hp, mhp, , , , lv, kl, , , cid, wflat] = a;
    const cls = CLS[cid];
    const name = cleanText(String(a[15] || 'Admin'), 16) || 'Admin';
    if (!cls) { flag('unknown class'); continue; }
    const kit = { n: name, c: cls.id, w: [], p: [] };              // final loadout is stored with the score
    if (Array.isArray(wflat)) for (let i = 0; i + 1 < wflat.length; i += 3) if (WIDS[wflat[i]]) kit.w.push([WIDS[wflat[i]], wflat[i + 1] | 0]);
    const pflat = a[17];
    if (pflat !== undefined && (!Array.isArray(pflat) || pflat.length > PIDS.length * 2)) flag(`${name}: impossible patches`);
    else if (pflat) for (let i = 0; i + 1 < pflat.length; i += 2){
      const pid = PIDS[pflat[i]], pl = pflat[i + 1];
      if (!pid || !Number.isInteger(pl) || pl < 1 || pl > 5){ flag(`${name}: impossible patch level`); break; }
      kit.p.push([pid, pl]);
    }
    r.roster.set(id, kit);
    if (mhp > cls.hp + MAX_HP_BONUS + 1) flag(`${name}: max HP ${mhp} (limit ${cls.hp + MAX_HP_BONUS})`);
    if (hp > mhp + 1) flag(`${name}: HP ${hp} above max HP ${mhp}`);
    const prev = r.pos.get(id);
    if (prev && Math.hypot(x - prev.x, y - prev.y) > cls.spd * MAX_SPEED_MUL * 1.1 * Math.max(0, t - prev.t) + 40) flag(`${name}: moved faster than possible`);
    r.pos.set(id, { x, y, t });
    r.kills.set(id, kl | 0);
    if ((lv | 0) > r.level) r.level = lv | 0;
    if (!Array.isArray(wflat) || wflat.length / 3 > MAX_WEAPONS) { flag(`${name}: too many weapons`); continue; }
    const dmgPassive = (1 + 0.12 * Math.min(5, Math.max(0, (lv | 0) - 1))) * (1 + 0.02 * Math.max(0, (lv | 0) - 1));   // dmg patch + 2 %/level
    for (let i = 0; i < wflat.length; i += 3) {
      const w = WDMG[WIDS[wflat[i]]], wl = wflat[i + 1] | 0;
      if (!w || wl < 1 || wl > MAX_WLVL) { flag(`${name}: impossible weapon`); continue; }
      const maxHit = (w[0] + (wl - 1) * w[1]) * cls.dmg * dmgPassive * 2 + 1;     // x2 = crit
      if (maxHit > r.maxHit) r.maxHit = maxHit;
    }
  }
  if (Array.isArray(S.h)) for (const h of S.h) {
    if (Array.isArray(h) && h[2] > r.maxHit) { flag(`hit for ${h[2]} damage (max possible ${Math.floor(r.maxHit)})`); break; }
  }
  if (Array.isArray(S.e)) {
    const now = new Map();
    for (const e of S.e) if (Array.isArray(e)) {
      now.set(e[0], e[1] | 0);
      if (e[0] > r.maxEid) r.maxEid = e[0];
      if (r.gone.has(e[0])) flag('a destroyed printer came back');
    }
    for (const [id, ty] of r.alive) if (!now.has(id)) { r.gone.add(id); r.pts += PTS[ty] || 0; r.destroyed++; }
    r.alive = now;
  }
  const kills = [...r.kills.values()].reduce((s, k) => s + k, 0);
  if (kills > r.maxEid + 25) flag(`${kills} kills, but only ${r.maxEid} printers ever spawned`);
  if (r.destroyed > kills + 30) flag(`${r.destroyed} printers vanished, but only ${kills} were destroyed`);
  if (r.maxEid > 74 + 20 * t) flag('printers spawned impossibly fast');
  const bsn = S.bsn | 0;
  if (bsn > (t < 149 ? 0 : 1 + Math.floor((t - 149) / 120))) flag('boss appeared too early');
  r.bosses = Math.max(0, bsn - ((+S.bs) >= 0 ? 1 : 0));
  const xpCap = r.maxEid * 45 * 1.75 + bsn * 900 + 100;
  if (r.level > 200 || XP_NEED[r.level] > xpCap) flag(`level ${r.level} with too little XP available`);
  r.lastT = Math.max(r.lastT, t);
  if (S.st === 3) finishRun(room);
}
function finishRun(room) {
  const r = room.run;
  if (!r || r.done) return;
  r.done = true;
  const players = [...r.roster.values()];
  const res = { t: 'hs', list: players.length > 1 ? 'multi' : 'solo', time: Math.round(r.lastT),
    kills: [...r.kills.values()].reduce((s, k) => s + k, 0), level: r.level, bosses: r.bosses, rank: null,
    score: r.pts + PTS_PER_SECOND * Math.round(r.lastT) };
  if (r.flags.length) {
    res.flagged = r.flags;
    console.log(`INTEGRITY FAIL room ${room.code} [${fmtNames(r)}]: ${r.flags.join(' | ')}`);
  } else if (r.unranked) res.unranked = r.unranked;
  else if (r.lastT < MIN_RUN_S) res.unranked = `shifts under ${MIN_RUN_S} s don't count`;
  else {
    const entry = { id: crypto.randomBytes(8).toString('hex'), score: res.score, time: res.time, kills: res.kills, level: res.level, bosses: res.bosses, players, date: Date.now() };
    Object.assign(res, insertScore(entry), { id: entry.id });
    console.log(`score ${res.list} ${res.score} pts ${res.time}s ${res.kills} kills [${fmtNames(r)}] -> ${res.rank ? '#' + res.rank : 'not ranked'}`);
  }
  for (const c of room.conns.values()) send(c, res);
}

/* ---------------- helpdesk tickets ---------------- */
let tk = loadJson(TK_FILE, { next: 1, tickets: [] }, d => Array.isArray(d.tickets) && Number.isInteger(d.next));
const TK_TYPES = ['bug', 'feature', 'other'], TK_PRIOS = ['low', 'normal', 'high', 'critical'];
const TK_STATUS = ['new', 'progress', 'done', 'rejected'];
const TK_MAX = 500, TK_MAX_COMMENTS = 100;
const tkKey = n => 'PRNT-' + String(n).padStart(4, '0');
const tkList = () => ({ tickets: [...tk.tickets].sort((a, b) => b.n - a.n) });
function handleTickets(req, res, rest) {
  const ip = req.socket.remoteAddress || '?';
  const m = rest.match(/^\/(\d+)(\/comments)?$/), t = m ? tk.tickets.find(x => x.n === +m[1]) : null;
  if (!rest && req.method === 'GET') return sendJson(res, 200, tkList());
  if (!rest && req.method === 'POST') {
    if (limited(ip, 'ticket', 15000)) return sendJson(res, 429, { error: 'one ticket every 15 seconds, please' });
    return readBody(req, res, 8192, o => {
      const title = cleanText(o.title, 80), desc = cleanText(o.desc, 2000), author = cleanText(o.author, 16) || 'Anonymous';
      if (title.length < 3) return sendJson(res, 400, { error: 'summary is too short' });
      if (!TK_TYPES.includes(o.type) || !TK_PRIOS.includes(o.prio)) return sendJson(res, 400, { error: 'invalid type or priority' });
      if (tk.tickets.length >= TK_MAX) return sendJson(res, 503, { error: 'ticket queue is full - ask an admin to clean up' });
      const now = Date.now(), n = tk.next++;
      const ticket = { n, key: tkKey(n), type: o.type, prio: o.prio, title, desc, author, status: 'new', created: now, updated: now, comments: [] };
      tk.tickets.push(ticket); saveJson(TK_FILE, tk);
      console.log(`ticket ${ticket.key} (${ticket.type}) by ${author}: ${title}`);
      sendJson(res, 201, { ticket, ...tkList() });
    });
  }
  if (!t) return sendJson(res, 404, { error: 'ticket not found' });
  if (m[2] && req.method === 'POST') {
    if (limited(ip, 'comment', 5000)) return sendJson(res, 429, { error: 'one comment every 5 seconds, please' });
    const admin = adminCheck(req) === 'ok';
    return readBody(req, res, 4096, o => {
      const text = cleanText(o.text, 1000), author = cleanText(o.author, 16) || 'Anonymous';
      if (!text) return sendJson(res, 400, { error: 'comment is empty' });
      if (t.comments.length >= TK_MAX_COMMENTS) return sendJson(res, 400, { error: 'too many comments on this ticket' });
      t.comments.push({ author, text, date: Date.now(), admin }); t.updated = Date.now(); saveJson(TK_FILE, tk);
      sendJson(res, 201, { ticket: t, ...tkList() });
    });
  }
  if (!m[2] && req.method === 'PATCH') {
    if (!requireAdmin(req, res)) return;
    return readBody(req, res, 1024, o => {
      if (!TK_STATUS.includes(o.status)) return sendJson(res, 400, { error: 'invalid status' });
      t.status = o.status; t.updated = Date.now(); saveJson(TK_FILE, tk);
      console.log(`ticket ${t.key} -> ${t.status}`);
      sendJson(res, 200, { ticket: t, ...tkList() });
    });
  }
  if (!m[2] && req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return;
    tk.tickets = tk.tickets.filter(x => x !== t); saveJson(TK_FILE, tk);
    console.log(`ticket ${t.key} deleted`);
    return sendJson(res, 200, tkList());
  }
  sendJson(res, 405, { error: 'method not allowed' });
}

/* ---------------- HTTP: API + static (only the game page is served) ---------------- */
function handleApi(req, res, p) {
  if (p === '/api/highscores') {
    if (req.method === 'GET') return sendJson(res, 200, hs);
    return sendJson(res, 405, { error: 'scores are recorded by the server itself' });
  }
  let m = p.match(/^\/api\/highscores\/([a-f0-9]{16})$/);
  if (m && req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return;
    let hit = null;
    for (const box of [hs, ...hs.archive]) for (const l of ['solo', 'multi']) { const e = box[l].find(x => x.id === m[1]); if (e) { hit = e; box[l] = box[l].filter(x => x !== e); } }
    if (!hit) return sendJson(res, 404, { error: 'score not found' });
    saveJson(HS_FILE, hs);
    console.log(`score deleted: ${hit.time}s [${hit.players.map(p => p.n).join(', ')}]`);
    return sendJson(res, 200, hs);
  }
  if (p === '/api/admin' && req.method === 'GET') { if (requireAdmin(req, res)) sendJson(res, 200, { ok: true }); return; }
  m = p.match(/^\/api\/tickets(\/.*)?$/);
  if (m) return handleTickets(req, res, m[1] || '');
  sendJson(res, 404, { error: 'unknown api' });
}
const PUBLIC = new Set(['/index.html']);
const server = http.createServer((req, res) => {
  let p; try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); return res.end('bad url'); }
  if (p.startsWith('/api/')) return handleApi(req, res, p);
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
      const room = { code, conns: new Map(), nextId: 1, hostId: 0, solo: !!m.solo, run: null };
      c.id = room.nextId++; room.hostId = c.id; c.__id = c.id;
      room.conns.set(c.id, c);
      rooms.set(code, room);
      c.room = room;
      send(c, { t: 'welcome', id: c.id, role: 'host', code });
      console.log(`room ${code} hosted${room.solo ? ' (solo)' : ''}`);
    } else {
      const code = String(m.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room || room.solo) { send(c, { t: 'err', msg: 'room ' + code + ' not found' }); return; }
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
    if (c.id === c.room.hostId) { relay(c.room, m, c.id); if (m.k === 's') witness(c.room, m); }
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
