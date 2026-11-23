const ROOT = require('path').join(__dirname, '..');   // repo root (server.js, data/)
// Field manual (legend) + rendering after the draw-helper refactor. Runs on file:// (no server needed).
const { chromium } = require('playwright-core'); const fs = require('fs');
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  fs.mkdirSync(ROOT + '/tests/screenshots', { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME }); const errs = [];
  const P = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); P.on('pageerror', e => errs.push(e.message));
  await P.goto('file://' + ROOT + '/index.html'); await P.waitForTimeout(300);
  ok(await P.isVisible('#btnManual'), 'menu has FIELD MANUAL button');
  await P.click('#btnManual');
  const expect = { printers: 8, weapons: 7, patches: 9, pickups: 3, admins: 3 };
  for (const [tab, n] of Object.entries(expect)){
    await P.click(`#manTabs .tab[data-m=${tab}]`); await P.waitForTimeout(150);
    const cards = await P.$$eval('#manCards .mcard', els => els.length);
    const blank = await P.$$eval('#manCards canvas', cvs => cvs.filter(cv => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return false; return true; }).length);
    const txt = await P.textContent('#manCards');
    ok(cards === n && blank === 0 && !/undefined|NaN/.test(txt), `${tab}: ${cards}/${n} cards, ${blank} blank icons, no undefined/NaN`);
    await P.screenshot({ path: ROOT + `/tests/screenshots/m-${tab}.png` });
  }
  await P.click('#manTabs .tab[data-m=printers]');
  ok((await P.textContent('#manCards')).includes('MAIN PRINTER') && (await P.textContent('#manCards')).includes('2.4×'), 'printer texts present');
  await P.keyboard.press('Escape'); ok(!(await P.isVisible('#manual')), 'Escape closes the manual');
  // the game still renders printers, pickups and weapon icons after the refactor
  await P.click('#btnSolo'); await P.click('#charSel button >> nth=0'); await P.waitForTimeout(600);
  await P.evaluate(`for (const k of ['xp','coffee','magnet']) pickups.push({ x: me.x + 40 + pickups.length * 25, y: me.y + 60, kind: k, v: 1, life: 999, bob: 0 });
    spawnEnemy('fax'); Object.assign(enemies[enemies.length - 1], { x: me.x - 120, y: me.y - 40, spd: 0 }); me.weapons.push({ id: 'badge', lvl: 2, t: 0, ang: 0 }, { id: 'shout', lvl: 1, t: 1, ang: 0 });`);
  await P.waitForTimeout(400); await P.screenshot({ path: ROOT + '/tests/screenshots/m-ingame.png' });
  ok(errs.length === 0, 'no page errors ' + errs.join(' | '));
  await b.close();
})();
