const ROOT = require('path').join(__dirname, '..');   // repo root (server.js, data/)
const { chromium } = require('playwright-core');
const { spawn } = require('child_process'); const fs = require('fs');
const PORT = 18210, U = 'http://127.0.0.1:' + PORT;
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const srv = spawn('node', ['server.js', PORT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RATE_SCALE: '0' } });
  let log = ''; srv.stdout.on('data', d => log += d); await new Promise(r => setTimeout(r, 500));
  const b = await chromium.launch({ executablePath: process.env.CHROME }); const errs = [];
  const pg = async () => { const p = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept()); await p.goto(U); return p; };
  const verdict = async P => { for (let i = 0; i < 40; i++) { const s = await P.textContent('#deadRank'); if (s && !s.includes('verifying')) return s; await P.waitForTimeout(150); } return await P.textContent('#deadRank'); };
  const die = P => P.evaluate(`players.forEach(p => { p.iframe = 0; hurtPlayer(p, 1e6); })`);
  const solo = async (name, cls) => { const P = await pg(); await P.fill('#nameIn', name); await P.click('#btnSolo'); await P.click(`#charSel button >> nth=${cls}`); await P.waitForTimeout(600); return P; };
  const nearEnemies = P => P.evaluate(`for (let i = 0; i < 6; i++){ spawnEnemy('laser'); const e = enemies[enemies.length-1]; e.x = me.x + 90 + i*15; e.y = me.y + (i-3)*20; e.spd = 0; }`);

  // ---- legit solo run (12 s, moving around, picking cards) ----
  const L = await solo('Legit', 0);
  const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
  for (let i = 0; i < 12; i++) { await L.keyboard.down(keys[i % 4]); await L.waitForTimeout(500); await L.keyboard.up(keys[i % 4]);
    await L.evaluate(`me.hp = me.maxhp; if (cardsOpen()) document.querySelector('#cards button').click()`); await L.waitForTimeout(500); }
  await die(L); let v = await verdict(L);
  ok(v.includes('#1 in SOLO'), 'legit solo run (12 s) is ranked: ' + v);

  // ---- devtools cheats in solo ----
  const cheats = [
    ['max HP pumped',      `me.maxhp = 999; me.hp = 999`, /max HP 999/],
    ['HP above max',       `me.hp = me.maxhp + 80`, /above max HP/],
    ['damage multiplier',  `me.chDmg = 40`, /damage/, true],
    ['damage passive',     `me.pass.dmg = 60`, /damage/, true],
    ['speed hack',         `me.speed = 2500`, /faster than possible/, false, true],
    ['clock skip',         `t += 200`, /faster than real time|boss/],
    ['kill counter',       `me.kills = 4000`, /kills, but only/],
    ['level edit',         `me.level = 90`, /level 90/],
  ];
  for (const [name, code, re, needHits, move] of cheats) {
    const P = await solo('Bob', 1);
    await P.evaluate(code);
    if (needHits) { await nearEnemies(P); await P.waitForTimeout(2500); }
    if (move) { await P.keyboard.down('ArrowRight'); await P.waitForTimeout(600); await P.keyboard.up('ArrowRight'); }
    await P.waitForTimeout(400); await die(P); v = await verdict(P);
    ok(re.test(v) && v.includes('INTEGRITY CHECK FAILED'), `cheat detected: ${name} -> ${v.slice(0, 110)}`);
    await P.context().close();
  }
  // ---- client edits its own HP: host overrides it, run stays clean ----
  const H = await pg(); await H.fill('#nameIn', 'Alice'); await H.click('#btnHost'); await H.waitForTimeout(400); const code = await H.evaluate('roomCode');
  const A = await pg(); await A.fill('#nameIn', 'Anna'); await A.fill('#codeIn', code); await A.click('#btnJoin'); await A.waitForTimeout(400);
  await A.click('.clsbtn >> nth=2'); await A.click('#btnReady'); await A.waitForTimeout(300); await H.click('#btnStartShift'); await H.waitForTimeout(800);
  // ---- legit multiplayer: 40 s, many level-ups, both moving, auto card picks ----
  const t0 = Date.now(); let i = 0;
  while (Date.now() - t0 < 40000) {
    const k = keys[i++ % 4];
    await Promise.all([H.keyboard.down(k), A.keyboard.down(keys[(i + 1) % 4])]); await H.waitForTimeout(400); await Promise.all([H.keyboard.up(k), A.keyboard.up(keys[(i + 1) % 4])]);
    await H.evaluate(`players.forEach(p => { p.hp = p.maxhp; }); if (cardsOpen()) document.querySelector('#cards button').click(); if (${i} % 6 === 0) players.forEach(p => gainXp(p, 25))`);
    await A.evaluate(`if (cardsOpen()) document.querySelector('#cards button').click(); if (me) { me.hp = 9999; me.maxhp = 9999; }`);   // client-side tampering: must not matter
    await H.waitForTimeout(250);
  }
  const lv = await H.evaluate(`players.map(p => p.level + ':' + p.weapons.map(w => w.id + w.lvl).join('/')).join(' ')`);
  await die(H); const vh = await verdict(H), va = await verdict(A);
  ok(vh.includes('#1 in MULTIPLAYER') && va.includes('#1 in MULTIPLAYER'), `legit 40 s multiplayer (levels ${lv}) ranked on host + client: ${va}`);
  // ---- host cheats on behalf of a client ----
  await H.context().close(); await A.context().close();
  const H2 = await pg(); await H2.click('#btnHost'); await H2.waitForTimeout(400); const c2 = await H2.evaluate('roomCode');
  const A2 = await pg(); await A2.fill('#codeIn', c2); await A2.click('#btnJoin'); await A2.waitForTimeout(400); await H2.click('#btnStartShift'); await H2.waitForTimeout(600);
  await H2.evaluate(`players[1].maxhp = 500; players[1].hp = 500`); await H2.waitForTimeout(300); await die(H2);
  v = await verdict(A2); ok(v.includes('INTEGRITY CHECK FAILED'), 'host tampering with a client is flagged, client sees it: ' + v.slice(0, 90));
  // ---- scoreboard contents ----
  const hs = await (await fetch(U + '/api/highscores')).json();
  ok(hs.solo.length === 1 && hs.solo[0].players[0].n === 'Legit' && hs.multi.length === 1, `only legit runs stored (solo ${hs.solo.length}, multi ${hs.multi.length})`);
  ok(/INTEGRITY FAIL/.test(log), 'cheats logged on the server: ' + (log.match(/INTEGRITY FAIL[^\n]*/g) || []).length + ' lines');
  ok(errs.length === 0, 'no page errors ' + errs.join(' | '));
  await b.close(); srv.kill(); fs.rmSync(ROOT + '/data', { recursive: true, force: true });
})();
