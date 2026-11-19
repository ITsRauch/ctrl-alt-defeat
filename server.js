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

/* ---------------- HTTP static ---------------- */
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('nope'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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
    if (c.room) {
      const room = c.room; c.room = null;
      room.conns.delete(c.id);
      if (c.id === room.hostId) {           // host left -> close room, notify clients
        for (const oc of room.conns.values()) send(oc, { t: 'hostleft' });
        rooms.delete(room.code);
      }
    }
  }
});

function handle(c, m) {
  if (m.t === 'hello') {
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
      c.id = room.nextId++;
      room.conns.set(c.id, c);
      c.room = room;
      send(c, { t: 'welcome', id: c.id, role: 'client', code, hostId: room.hostId });
      relay(room, { k: 'peer-join', id: c.id }, c.id);
      console.log(`joined ${code}: id ${c.id}`);
    }
  } else if (c.room && m.k !== undefined) {
    // game message (k = kind) from host or client: relay to everyone else in room
    relay(c.room, m, c.id);
  }
}

server.listen(PORT, () => {
  console.log('CTRL-ALT-DEFEAT MP server up');
  console.log('  open   http://THIS-IP:' + PORT);
  console.log('  e.g.   http://' + (require('os').networkInterfaces ? '192.168.x.x' + ':' + PORT : ''));
});
