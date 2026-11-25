const ROOT = require('path').join(__dirname, '..');   // repo root (server.js, data/)
// v1.3 mechanics: shared team XP, simultaneous picks, late-join catch-up, revive, coffee rush, DevOps, menu centering
const { chromium } = require('playwright-core'); const { spawn } = require('child_process'); const fs = require('fs');
const PORT = 18260, U = 'http://127.0.0.1:' + PORT;
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  fs.mkdirSync(ROOT + '/tests/screenshots', { recursive: true });
  const srv = spawn('node', ['server.js', PORT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RATE_SCALE: '0' } });
  let log = ''; srv.stdout.on('data', d => log += d); await new Promise(r => setTimeout(r, 500));
  const b = await chromium.launch({ executablePath: process.env.CHROME }); const errs = [];
  const pg = async (w = 1280, h = 860) => { const p = await (await b.newContext({ viewport: { width: w, height: h } })).newPage(); p.on('pageerror', e => errs.push(e.message)); await p.goto(U); await p.waitForTimeout(300); return p; };
  // --- menu centering on a wide screen ---
  const M = await pg(1760, 1084);
  const cx = sel => M.$eval(sel, el => { const r = el.getBoundingClientRect(); return Math.round(r.left + r.width / 2); });
  const mid = 880, xs = { name: await cx('.namefield'), cards: await cx('.modes'), buttons: await cx('.hsrow'), guide: await cx('.guide') };
  ok(Object.values(xs).every(x => Math.abs(x - mid) <= 4), 'menu blocks centered on 1760 px: ' + JSON.stringify(xs));
  await M.screenshot({ path: ROOT + '/tests/screenshots/b-menu-1760.png' });
  // --- solo: XP curve unchanged (8 XP for level 2) ---
  const S = await pg(); await S.click('#btnSolo'); await S.click('#charSel button >> nth=0'); await S.waitForTimeout(400);
  ok(await S.evaluate('me.next') === 8, 'solo needs 8 XP for level 2 (unchanged)');
  // --- multiplayer: shared bar, +55 % per extra admin, simultaneous picks ---
  const H = await pg(); await H.fill('#nameIn', 'Host'); await H.click('#btnHost'); await H.waitForTimeout(400); const code = await H.evaluate('roomCode');
  const A = await pg(); await A.fill('#nameIn', 'Anna'); await A.fill('#codeIn', code); await A.click('#btnJoin'); await A.waitForTimeout(400);
  await H.click('#btnStartShift'); await H.waitForTimeout(700);
  ok(await H.evaluate('teamNext()') === 12 && await A.evaluate('me.next') === 12, '2 admins: level 2 needs 12 XP (8 x 1.55), client sees it');
  await H.evaluate('gainXp(players[1], 11)'); await H.waitForTimeout(300);
  ok(await H.evaluate('players.every(p => p.xp === 11 && p.level === 1)') && await A.evaluate('me.xp') === 11, 'XP collected by one admin fills the shared bar for both');
  await H.evaluate('gainXp(players[0], 1)'); await H.waitForTimeout(500);
  ok(await H.evaluate('cardsOpen()') && await A.evaluate('cardsOpen()') && await H.evaluate('st') === 1, 'team level-up: both get cards at the same time, shift paused');
  ok((await A.textContent('#lvlSub')).includes('TEAM LEVEL UP'), 'level-up screen says TEAM LEVEL UP');
  await H.click('#cards button >> nth=0'); await H.waitForTimeout(400);
  ok(await H.evaluate('st') === 1, 'still paused while Anna is picking');
  await H.screenshot({ path: ROOT + '/tests/screenshots/b-waiting.png' });
  await A.click('#cards button >> nth=1'); await H.waitForTimeout(400);
  ok(await H.evaluate('st') === 0 && await H.evaluate('players.every(p => p.level === 2 && p.pending === 0)'), 'all picked -> shift resumes, both level 2');
  // --- late joiner: same team level, catch-up picks don't pause the others ---
  await H.evaluate('players.forEach(p => p.hp = p.maxhp); gainXp(players[0], 200)'); await H.waitForTimeout(400);
  for (let i = 0; i < 12; i++){ for (const P of [H, A]) if (await P.evaluate('cardsOpen()')) await P.click('#cards button >> nth=0'); await H.waitForTimeout(250); }
  const lvl = await H.evaluate('teamLevel');
  const C = await pg(); await C.fill('#nameIn', 'Carl'); await C.fill('#codeIn', code); await C.click('#btnJoin'); await C.waitForTimeout(500); await C.click('#btnReady'); await C.waitForTimeout(900);
  ok(await H.evaluate(`players.find(p => p.name === 'Carl').level`) === lvl && await H.evaluate('st') === 0, `late joiner starts at team level ${lvl}, shift keeps running`);
  ok(await C.evaluate('cardsOpen()') && (await C.textContent('#lvlSub')).includes('Catch-up'), 'late joiner gets catch-up cards');
  const t0 = await H.evaluate('t');
  for (let i = 0; i < lvl + 2 && await C.evaluate('cardsOpen()'); i++){ await C.click('#cards button >> nth=0'); await C.waitForTimeout(350); }
  ok(await H.evaluate(`players.find(p => p.name === 'Carl').pending`) === 0 && await H.evaluate('t') > t0 + 0.5, 'catch-up done while the clock kept running');
  ok(await H.evaluate('teamNext()') === Math.round(await H.evaluate('teamBase') * 2.1), '3 admins: x2.1 XP per level');
  // --- revive: 80 px, 2 s ---
  await H.evaluate(`enemies = []; spawnT = 999; goonT = 1e9; bossT = 1e9; const v = players[1]; v.iframe = 0; hurtPlayer(v, 1e6); players[0].x = v.x + 70; players[0].y = v.y;`);
  let revived = false; for (let i = 0; i < 25 && !revived; i++){ await H.waitForTimeout(200); revived = await H.evaluate('players[1].dn === 0 && players[1].hp > 0'); }
  ok(revived, 'revive from 70 px away within ~2 s');
  // --- coffee rush + DevOps ---
  await H.evaluate(`const p = players[0]; p.hp = 10; pickups.push({ x: p.x, y: p.y, kind: 'coffee', life: 999, bob: 0 })`); await H.waitForTimeout(300);
  const cf = await H.evaluate(`({ hp: Math.round(players[0].hp), max: players[0].maxhp, buff: players[0].buffT > 0, sp: Math.round(moveSpeed(players[0])), base: Math.round(players[0].speed * (1 + .08 * (players[0].pass.boots || 0))) })`);
  ok(cf.hp >= 10 + Math.round(cf.max * .25) - 1 && cf.buff && cf.sp === Math.round(cf.base * 1.2), 'coffee heals 25 % and gives +20 % speed: ' + JSON.stringify(cf));
  const D = await pg(); await D.click('#btnSolo'); await D.click('#charSel button >> nth=2'); await D.waitForTimeout(300);
  const dv = await D.evaluate(`enemies = []; spawnT = 999; me.iframe = 0; me.hp = 100; hurtPlayer(me, 20); const a = me.hp; for (let i = 0; i < 20; i++) update(0.05); ({ took: Math.round((100 - a) * 10) / 10, regen: Math.round((me.hp - a) * 10) / 10, spd: me.speed })`);
  ok(dv.took === 18 && dv.regen >= .8 && dv.regen <= 1 && dv.spd === 125, 'DevOps: 10 % less damage, ~0.9 HP/s regen, speed 125: ' + JSON.stringify(dv));
  // --- anti-cheat: coffee rush + boots 5 sprint, high-level damage must not be flagged ---
  const R = await pg(); await R.click('#btnSolo'); await R.click('#charSel button >> nth=1'); await R.waitForTimeout(300);
  await R.evaluate(`me.pass.boots = 5; me.buffT = 99; gainXp(me, 300)`); for (let i = 0; i < 8; i++){ if (await R.evaluate('cardsOpen()')) await R.click('#cards button >> nth=0'); await R.waitForTimeout(150); }
  await R.keyboard.down('ArrowRight'); await R.waitForTimeout(3000); await R.keyboard.up('ArrowRight');
  await R.evaluate(`me.iframe = 0; hurtPlayer(me, 1e6)`); let v = ''; for (let i = 0; i < 30 && !/Not ranked|INTEGRITY|HIGHSCORE|top 20/.test(v); i++){ await R.waitForTimeout(150); v = await R.textContent('#deadRank'); }
  ok(!v.includes('INTEGRITY'), 'coffee rush + boots 5 sprint not flagged by anti-cheat: ' + v);
  ok(!/INTEGRITY FAIL/.test(log), 'no integrity failures on the server');
  ok(errs.length === 0, 'no page errors ' + errs.join(' | '));
  await b.close(); srv.kill(); fs.rmSync(ROOT + '/data', { recursive: true, force: true });
})();
