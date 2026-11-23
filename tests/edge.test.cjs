const ROOT = require('path').join(__dirname, '..');   // repo root (server.js, data/)
const { chromium } = require('playwright-core');
const { spawn } = require('child_process'); const fs = require('fs');
const PORT = 18220, U = 'http://127.0.0.1:' + PORT;
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const srv = spawn('node', ['server.js', PORT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RATE_SCALE: '0' } });
  let log = ''; srv.stdout.on('data', d => log += d); await new Promise(r => setTimeout(r, 500));
  const b = await chromium.launch({ executablePath: process.env.CHROME }); const errs = [];
  const pg = async () => { const p = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage(); p.on('pageerror', e => errs.push(e.message)); await p.goto(U); return p; };
  const verdict = async P => { for (let i = 0; i < 40; i++) { const s = await P.textContent('#deadRank'); if (s && !s.includes('verifying')) return s; await P.waitForTimeout(150); } return P.textContent('#deadRank'); };
  const solo = async (name, cls) => { const P = await pg(); await P.fill('#nameIn', name); await P.click('#btnSolo'); await P.click(`#charSel button >> nth=${cls}`); await P.waitForTimeout(400); return P; };
  const die = P => P.evaluate(`players.forEach(p => { p.iframe = 0; hurtPlayer(p, 1e6); })`);
  const keepAlive = `me.hp = me.maxhp; if (cardsOpen()) document.querySelector('#cards button').click();`;

  // A) maxed-out legit build: sysadmin, all weapons lvl 5, dmg/crit/atk/area 5, coffee 5, boots 5 -> sprint + hits
  const A = (async () => {
    const P = await solo('MaxBuild', 0);
    await P.evaluate(`gainXp(me, 480)`); await P.waitForTimeout(300);
    for (let i = 0; i < 12; i++) { await P.evaluate(keepAlive); await P.waitForTimeout(150); }
    await P.evaluate(`
      me.weapons = []; for (const id of ['mouse','whip','keyboard','ping','toner','badge']) me.weapons.push({ id, lvl: 5, t: .1, ang: 0 });
      for (const id of ['dmg','crit','atk','area','boots']) me.pass[id] = 5;
      me.pass.coffee = 5; me.maxhp = 110 + 100; me.hp = me.maxhp;`);
    const ks = ['ArrowRight','ArrowDown','ArrowLeft','ArrowUp'];
    for (let i = 0; i < 16; i++) {
      await P.evaluate(`for (let i = 0; i < 4; i++){ spawnEnemy('laser'); const e = enemies[enemies.length-1]; e.x = me.x + 60 + i*25; e.y = me.y + 40; e.spd = 0; } ` + keepAlive);
      await P.keyboard.down(ks[i % 4]); await P.waitForTimeout(450); await P.keyboard.up(ks[i % 4]);
    }
    const st = await P.evaluate(`JSON.stringify({lv: me.level, maxhp: me.maxhp, kills: me.kills, w: me.weapons.length, t: Math.round(t)})`);
    await die(P); const v = await verdict(P);
    ok(!v.includes('INTEGRITY') && !v.includes('verifying'), `maxed legit build (${st}) not flagged: ${v}`);
    const P2 = await solo('Sprinter', 1);
    await P2.evaluate(`me.pass.boots = 5`);
    await P2.keyboard.down('ArrowRight'); await P2.keyboard.down('ArrowDown'); await P2.waitForTimeout(4000); await P2.keyboard.up('ArrowRight'); await P2.keyboard.up('ArrowDown');
    await P2.evaluate(keepAlive); await die(P2); const v2 = await verdict(P2);
    ok(!v2.includes('INTEGRITY'), `helpdesk sprint with boots 5 not flagged: ${v2}`);
  })();

  // B) real boss fight at 150 s, kill it, NIGHT SHIFT ++, die -> verified with boss count
  const B = (async () => {
    const P = await solo('BossRun', 2);
    const t0 = Date.now(); let k = 0; const ks = ['ArrowRight','ArrowDown','ArrowLeft','ArrowUp'];
    while (!(await P.evaluate('!!boss')) && Date.now() - t0 < 260000) { await P.keyboard.down(ks[k % 4]); await P.waitForTimeout(300); await P.keyboard.up(ks[k++ % 4]); await P.evaluate(keepAlive); await P.waitForTimeout(700); }
    const bt = await P.evaluate('Math.round(t)');
    ok(await P.evaluate('!!boss'), 'boss spawned naturally at t=' + bt + 's');
    await P.evaluate(`if (boss){ boss.hp = 5; boss.x = me.x + 70; boss.y = me.y; }`);
    for (let i = 0; i < 20 && !(await P.isVisible('#win')); i++) { await P.evaluate(keepAlive); await P.waitForTimeout(300); }
    ok(await P.isVisible('#win'), 'win screen after boss kill');
    await P.click('#win .bigbtn');
    for (let i = 0; i < 20; i++){ await P.evaluate(keepAlive); await P.waitForTimeout(150); }   // pick the boss-XP level-up cards
    ok(await P.evaluate('endless && st === 0 && !boss'), 'NIGHT SHIFT ++ continues without instant 2nd boss (bossT fix)');
    await P.evaluate(keepAlive); await die(P); const v = await verdict(P);
    const hs = await (await fetch(U + '/api/highscores')).json(); const e = hs.solo.find(x => x.players[0].n === 'BossRun');
    ok(!v.includes('INTEGRITY') && e && e.bosses === 1 && e.time >= 150, `boss run verified: ${v} (stored ${e && e.time}s, bosses ${e && e.bosses})`);
  })();
  await Promise.all([A, B]);
  ok(!/INTEGRITY FAIL/.test(log), 'no integrity failures logged: ' + ((log.match(/INTEGRITY FAIL[^\n]*/g) || []).join(' / ') || 'none'));
  ok(errs.length === 0, 'no page errors ' + errs.join(' | '));
  await b.close(); srv.kill(); fs.rmSync(ROOT + '/data', { recursive: true, force: true });
})();
