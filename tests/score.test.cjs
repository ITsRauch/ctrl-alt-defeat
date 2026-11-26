const ROOT = require('path').join(__dirname, '..');   // repo root (server.js, data/)
// v1.4: server-computed points (per printer type + time bonus), seasons, live score in the HUD
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const PORT = 18270, U = 'http://127.0.0.1:' + PORT;
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  fs.mkdirSync(ROOT + '/data', { recursive: true }); fs.mkdirSync(ROOT + '/tests/screenshots', { recursive: true });
  fs.writeFileSync(ROOT + '/data/highscores.json', JSON.stringify({ solo: [{ id: 'bbbbbbbbbbbbbbbb', time: 757, kills: 1564, level: 19, bosses: 0, players: [{ n: 'Alice', c: 'helpdesk' }], date: Date.now() - 86400000 }], multi: [] }));
  const srv = spawn('node', ['server.js', PORT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RATE_SCALE: '0' } });
  let log = ''; srv.stdout.on('data', d => log += d); await new Promise(r => setTimeout(r, 500));
  const b = await chromium.launch({ executablePath: process.env.CHROME }); const errs = [];
  const pg = async () => { const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept()); await p.goto(U); await p.waitForTimeout(300); return p; };
  const verdict = async P => { let v = ''; for (let i = 0; i < 40 && !/pts|INTEGRITY|Not ranked/.test(v); i++){ await P.waitForTimeout(150); v = await P.textContent('#deadRank'); } return v; };
  const P = await pg();
  ok((await P.textContent('#hsTeaser')).includes('new season'), 'menu teaser: new season, no scores yet');
  await P.fill('#nameIn', 'Bob'); await P.click('#btnSolo'); await P.click('#charSel button >> nth=2'); await P.waitForTimeout(500);
  // destroy two golems on purpose (50 pts each) while playing ~12 s
  for (let i = 0; i < 2; i++){ await P.evaluate(`spawnEnemy('golem'); const g = enemies[enemies.length - 1]; g.x = me.x + 120; g.y = me.y; g.spd = 0;`); await P.waitForTimeout(400); await P.evaluate(`const g = enemies.find(e => e.type === 'golem'); if (g){ g.hp = 1; hurtEnemy(g, 5, false, me); }`); }
  await P.evaluate(`gainXp(me, 40)`);
  for (let i = 0; i < 120 && await P.evaluate('t < 12 || cardsOpen()'); i++){ await P.evaluate(`me.hp = me.maxhp; if (cardsOpen()) document.querySelector('#cards button').click()`); await P.waitForTimeout(250); }
  const kitLocal = await P.evaluate(`({ w: me.weapons.map(w => [w.id, w.lvl]), p: PIDS.filter(id => me.pass[id]).map(id => [id, me.pass[id]]) })`);
  await P.screenshot({ path: ROOT + '/tests/screenshots/s-hud.png' });
  const local = await P.evaluate(`({ pts: runPts, t: t, golems: 2 })`);
  ok(local.pts >= 100, 'golem kills worth 50 pts each are counted locally: ' + local.pts);
  await P.evaluate(`me.iframe = 0; hurtPlayer(me, 1e6)`); const v = await verdict(P);
  const hs = await (await fetch(U + '/api/highscores')).json(); const e = hs.solo[0] || {};
  const expected = local.pts + 2 * Math.round(local.t);
  ok(v.includes('#1 in SOLO') && /\d pts/.test(v), 'rank line shows points: ' + v);
  ok(Math.abs(e.score - expected) <= Math.max(6, expected * .03), `server score ${e.score} matches the game (${expected}, ±3 %)`);
  ok(hs.archive[0].solo[0].players[0].n === 'Alice' && hs.solo.length === 1, 'old 12:37 run archived in season 1, new season has the new run');
  ok(JSON.stringify(e.players[0].w) === JSON.stringify(kitLocal.w) && JSON.stringify(e.players[0].p) === JSON.stringify(kitLocal.p) && kitLocal.w.length + kitLocal.p.length >= 2,
     'final loadout stored with the score: ' + JSON.stringify(e.players[0]));
  // scoreboard UI: season selector + score column
  await P.click('#dead .hsbtn'); await P.waitForTimeout(400);
  ok((await P.textContent('#hsTable')).includes('SCORE') && (await P.textContent('#hsNote')).includes('per destroyed printer'), 'current season shows SCORE column + explanation');
  const chips = await P.$$eval('#hsTable .chip', els => els.map(e => e.title));
  const drawn = await P.$$eval('#hsTable canvas.wg', cvs => cvs.every(cv => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; }));
  ok(chips.length === kitLocal.w.length + kitLocal.p.length && chips.some(t => t.startsWith('Helpdesk Shout')) && drawn, 'hall of fame shows weapon + patch chips with levels: ' + chips.join(', '));
  await P.screenshot({ path: ROOT + '/tests/screenshots/s-season2.png' });
  await P.selectOption('#hsSeason', '1'); await P.waitForTimeout(200);
  ok((await P.textContent('#hsTable')).includes('12:37') && !(await P.textContent('#hsTable')).includes('SCORE') && (await P.textContent('#hsNote')).includes('Archived'), 'season 1 archive still viewable (ranked by time)');
  // multiplayer: client sees the live score
  const H = await pg(); await H.click('#btnHost'); await H.waitForTimeout(400);
  const A = await pg(); await A.fill('#codeIn', await H.evaluate('roomCode')); await A.click('#btnJoin'); await A.waitForTimeout(400); await H.click('#btnStartShift'); await H.waitForTimeout(3500);
  const hsc = await H.evaluate('runPts + 2 * Math.floor(t)'), csc = await A.evaluate('liveScore');
  ok(csc > 0 && Math.abs(hsc - csc) <= 6, `client HUD score follows the host (${csc} vs ${hsc})`);
  // cheat: patch above level 5
  const Q = await pg(); await Q.click('#btnSolo'); await Q.click('#charSel button >> nth=0'); await Q.waitForTimeout(400);
  await Q.evaluate(`me.pass.glasses = 9`); await Q.waitForTimeout(300); await Q.evaluate(`me.iframe = 0; hurtPlayer(me, 1e6)`);
  const qv = await verdict(Q); ok(qv.includes('impossible patch level'), 'patch above level 5 is flagged: ' + qv.slice(0, 80));
  // cheat: a destroyed printer re-appears in the snapshots (farming points)
  const C = await pg(); await C.click('#btnSolo'); await C.click('#charSel button >> nth=0'); await C.waitForTimeout(500);
  await C.evaluate(`spawnEnemy('golem'); window.__g = enemies[enemies.length - 1]; __g.x = me.x + 150; __g.y = me.y; __g.spd = 0;`); await C.waitForTimeout(300);
  await C.evaluate(`__g.hp = 1; hurtEnemy(__g, 5, false, me)`); await C.waitForTimeout(300);
  await C.evaluate(`Object.assign(__g, { dead: false, hp: 1e9 }); enemies.push(__g)`); await C.waitForTimeout(300);
  await C.evaluate(`me.iframe = 0; hurtPlayer(me, 1e6)`); const cv = await verdict(C);
  ok(cv.includes('INTEGRITY') && cv.includes('came back'), 'point farming with a resurrected printer is flagged: ' + cv.slice(0, 90));
  const fails = log.match(/INTEGRITY FAIL[^\n]*/g) || [];
  ok(fails.length === 2 && fails.some(f => f.includes('came back')) && fails.some(f => f.includes('patch level')), 'only the two cheat tests failed integrity, legit runs clean: ' + fails.length);
  ok(errs.length === 0, 'no page errors ' + errs.join(' | '));
  await b.close(); srv.kill(); fs.rmSync(ROOT + '/data', { recursive: true, force: true });
})();
