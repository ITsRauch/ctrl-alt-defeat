const ROOT = require('path').join(__dirname, '..');   // repo root (server.js, data/)
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  const srv = spawn('node', ['server.js', '18230'], { cwd: ROOT, stdio: 'ignore' }); await new Promise(r => setTimeout(r, 500));
  const b = await chromium.launch({ executablePath: process.env.CHROME }); const P = await (await b.newContext()).newPage();
  await P.goto('http://127.0.0.1:18230'); await P.click('#btnSolo'); await P.click('#charSel button >> nth=0'); await P.waitForTimeout(500);
  await P.evaluate(`spawnBoss(); boss.hp = 5; boss.x = me.x + 70; boss.y = me.y; me.hp = me.maxhp`);
  await P.waitForTimeout(2500);
  const k = await P.evaluate(`({ st, boss: !!boss, bossT, t })`);
  ok(k.st === 2 && !k.boss && k.bossT >= k.t + 119, 'boss killed -> win screen, next boss scheduled 120 s later');
  await P.click('#win .bigbtn'); await P.waitForTimeout(400);
  for (let i = 0; i < 20; i++) { await P.evaluate(`me.hp = me.maxhp; if (cardsOpen()) document.querySelector('#cards button').click()`); await P.waitForTimeout(150); }
  ok(await P.evaluate('st === 0 && endless && !boss'), 'NIGHT SHIFT ++ continues without an instant 2nd boss');
  await P.evaluate(`bossT = t + 0.5; me.hp = me.maxhp`); await P.waitForTimeout(1500);
  ok(await P.evaluate('!!boss && bossN === 2'), 'night shift: boss #2 spawns when due');
  await b.close(); srv.kill(); require('fs').rmSync(ROOT + '/data', { recursive: true, force: true });
})();
