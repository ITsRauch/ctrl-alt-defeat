const ROOT = require('path').join(__dirname, '..');   // repo root (server.js, data/)
const { spawn } = require('child_process'); const fs = require('fs');
const PORT = 18201, U = 'http://127.0.0.1:' + PORT, PW = 'test-admin-pw-42';
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
const j = async (method, url, body, admin) => { const h = {}; if (body) h['Content-Type'] = 'application/json'; if (admin) h['X-Admin-Key'] = admin;
  const r = await fetch(U + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined }); let d = {}; try { d = await r.json(); } catch (e) {} return { s: r.status, d }; };
(async () => {
  fs.mkdirSync(ROOT + '/data', { recursive: true });
  fs.writeFileSync(ROOT + '/data/highscores.json', JSON.stringify({ solo: [{ id: 'aaaaaaaaaaaaaaaa', time: 999, kills: 5, level: 3, bosses: 0, players: [{ n: 'Cheater', c: 'helpdesk' }], date: 1 }], multi: [] }));
  const srv = spawn('node', ['server.js', PORT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ADMIN_PASSWORD: PW, RATE_SCALE: '0' } });
  let log = ''; srv.stdout.on('data', d => log += d); await new Promise(r => setTimeout(r, 500));
  ok((await j('POST', '/api/highscores', { runId: 'abcdefgh12', time: 500, kills: 1, level: 1, bosses: 0, players: [{ n: 'x', c: 'devops' }] })).s === 405, 'score POST from clients is disabled (405)');
  const hs0 = (await j('GET', '/api/highscores')).d;
  ok(hs0.season === 2 && hs0.solo.length === 0 && hs0.archive[0].season === 1 && hs0.archive[0].solo.length === 1, 'old time-ranked list archived as season 1, season 2 starts empty');
  ok(JSON.parse(fs.readFileSync(ROOT + '/data/highscores.json')).archive[0].solo[0].players[0].n === 'Cheater', 'migration persisted to disk');
  ok((await j('DELETE', '/api/highscores/aaaaaaaaaaaaaaaa')).s === 403, 'delete score without admin -> 403');
  ok((await j('DELETE', '/api/highscores/aaaaaaaaaaaaaaaa', null, 'wrong')).s === 403, 'delete score wrong pw -> 403');
  ok((await j('GET', '/api/admin', null, PW)).s === 200, 'admin check with right pw');
  const del = await j('DELETE', '/api/highscores/aaaaaaaaaaaaaaaa', null, PW); ok(del.s === 200 && del.d.archive[0].solo.length === 0, 'admin deletes cheat score (also in archived seasons)');
  // tickets
  ok((await j('GET', '/api/tickets')).d.tickets.length === 0, 'no tickets initially');
  ok((await j('POST', '/api/tickets', { type: 'bug', prio: 'normal', title: 'x', author: 'a' })).s === 400, 'too short title rejected');
  ok((await j('POST', '/api/tickets', { type: 'hack', prio: 'normal', title: 'valid title' })).s === 400, 'invalid type rejected');
  const c1 = await j('POST', '/api/tickets', { type: 'bug', prio: 'high', title: 'Ping hits through walls', desc: 'line1\nline2 <script>alert(1)</script>', author: 'Bob' });
  ok(c1.s === 201 && c1.d.ticket.key === 'PRNT-0001' && c1.d.ticket.status === 'new', 'ticket created PRNT-0001');
  const c2 = await j('POST', '/api/tickets', { type: 'feature', prio: 'low', title: 'Add a stapler boss', author: '' });
  ok(c2.d.ticket.key === 'PRNT-0002' && c2.d.ticket.author === 'Anonymous' && c2.d.tickets[0].n === 2, 'second ticket, anonymous, newest first');
  ok((await j('POST', '/api/tickets/1/comments', { author: 'Carol', text: '+1' })).d.ticket.comments[0].admin === false, 'comment by user');
  ok((await j('POST', '/api/tickets/1/comments', { author: 'Alice', text: 'on it' }, PW)).d.ticket.comments[1].admin === true, 'admin comment flagged');
  ok((await j('POST', '/api/tickets/1/comments', { author: 'x', text: '   ' })).s === 400, 'empty comment rejected');
  ok((await j('PATCH', '/api/tickets/1', { status: 'done' })).s === 403, 'status change without admin -> 403');
  ok((await j('PATCH', '/api/tickets/1', { status: 'pwned' }, PW)).s === 400, 'invalid status rejected');
  ok((await j('PATCH', '/api/tickets/1', { status: 'progress' }, PW)).d.ticket.status === 'progress', 'admin sets status');
  ok((await j('DELETE', '/api/tickets/2')).s === 403, 'delete ticket without admin -> 403');
  ok((await j('DELETE', '/api/tickets/2', null, PW)).d.tickets.length === 1, 'admin deletes ticket');
  ok((await j('GET', '/api/tickets/99')).s === 404 || (await j('POST', '/api/tickets/99/comments', { text: 'x' })).s === 404, 'unknown ticket 404');
  const big = await fetch(U + '/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(20000) }).then(r => r.status, () => 'reset');
  ok(big === 413 || big === 'reset', 'oversized body rejected (' + big + ')');
  ok(fs.existsSync(ROOT + '/data/tickets.json') && JSON.parse(fs.readFileSync(ROOT + '/data/tickets.json')).next === 3, 'tickets persisted, counter not reused after delete');
  // lockout after 5 wrong passwords
  for (let i = 0; i < 5; i++) await j('GET', '/api/admin', null, 'nope' + i);
  ok((await j('GET', '/api/admin', null, PW)).s === 429, 'brute force lockout after 5 wrong passwords');
  for (const f of ['/server.js', '/data/tickets.json', '/data/highscores.json']) ok((await fetch(U + f)).status === 404, 'not served: ' + f);
  srv.kill();
  // rate limits active by default + admin disabled without password
  const s2 = spawn('node', ['server.js', PORT + 1], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, ADMIN_PASSWORD: '' } }); await new Promise(r => setTimeout(r, 500));
  const V = 'http://127.0.0.1:' + (PORT + 1);
  const p = () => fetch(V + '/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'bug', prio: 'low', title: 'spam spam' }) }).then(r => r.status);
  ok((await p()) === 201 && (await p()) === 429, 'ticket rate limit (1 / 15 s per IP)');
  ok((await fetch(V + '/api/admin', { headers: { 'X-Admin-Key': 'x' } })).status === 503, 'admin disabled without configured password (503)');
  s2.kill(); fs.rmSync(ROOT + '/data', { recursive: true });
})();
