// Power-up lab: runs the real game code headless (file://, no server), deterministic RNG,
// and measures what every weapon level and passive actually changes. Prints a report.
// usage: node tests/powerups.lab.cjs
const ROOT = require('path').join(__dirname, '..');
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME });
  const P = await (await b.newContext()).newPage(); const errs = []; P.on('pageerror', e => errs.push(e.message));
  await P.goto('file://' + ROOT + '/index.html'); await P.waitForTimeout(300);
  const out = await P.evaluate(() => {
    let seed = 1; const srand = s => { seed = s; }; Math.random = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    let DMG = 0, HITS = 0; window.hitEvent = (x, y, d) => { DMG += d; HITS++; };
    const fresh = (cls = 0) => { mode = 'solo'; myId = 0; newRun(CHARS[cls]); state = 'lab'; enemies = []; pickups = []; spawnT = goonT = bossT = 1e9; me.chDmg = 1; me.chArea = 1; return me; };
    const HOME = []; for (let i = 0; i < 24; i++){ const a = i * 2.39996, d = 48 + (i % 8) * 30; HOME.push([Math.cos(a) * d, Math.sin(a) * d]); }
    const dummies = () => { enemies = HOME.map(([dx, dy], i) => ({ id: 1000 + i, type: 'laser', x: me.x + dx, y: me.y + dy, hp: 1e9, maxhp: 1e9, spd: 0, r: 19, dmg: 0, xp: 0, phase: 0, flash: 0, kx: 0, ky: 0, boss: false, shootT: 99, dashT: 99, bob: 0, hitCd: {} })); };
    const run = (secs) => { for (let i = 0; i < secs * 20; i++){ update(0.05); me.hp = me.maxhp; enemies.forEach((e, k) => { e.x = me.x + HOME[k][0]; e.y = me.y + HOME[k][1]; e.kx = e.ky = 0; e.hp = 1e9; e.dead = false; }); } };
    const dps = (wid, lvl, pass) => { srand(7); fresh(); me.weapons = [{ id: wid, lvl, t: 0, ang: 0 }]; Object.assign(me.pass, pass || {}); dummies(); DMG = 0; HITS = 0; run(20); return { dps: DMG / 20, hits: HITS / 20 }; };
    const R = { weapons: {}, passives: {} };
    for (const w of WIDS){
      const base = dps(w, 1), l5 = dps(w, 5);
      R.weapons[w] = { L1: base.dps, L5: l5.dps, 'L5+dmg5': dps(w, 5, { dmg: 5 }).dps, 'L5+atk5': dps(w, 5, { atk: 5 }).dps, 'L5+area5': dps(w, 5, { area: 5 }).dps, 'L5+crit5': dps(w, 5, { crit: 5 }).dps, hitsL1: base.hits };
    }
    // movement
    const speed = boots => { fresh(); me.pass.boots = boots; const x0 = me.x; keys.add('ArrowRight'); for (let i = 0; i < 20; i++) update(0.05); keys.clear(); return me.x - x0; };
    R.passives.boots = { 0: speed(0), 5: speed(5), unit: 'px/s' };
    // coffee (via the real card)
    const hp = n => { fresh(); for (let i = 0; i < n; i++) applyCard(me, { kind: 'p', id: 'coffee' }); return me.maxhp; };
    R.passives.coffee = { 0: hp(0), 5: hp(5), unit: 'max HP' };
    // glasses: damage taken from one 20-dmg hit
    const taken = g => { fresh(); me.pass.glasses = g; me.iframe = 0; const h0 = me.hp; hurtPlayer(me, 20); return h0 - me.hp; };
    R.passives.glasses = { 0: taken(0), 5: taken(5), unit: 'HP lost per 20-dmg hit' };
    // magnet: farthest gem distance that gets collected within 3 s
    const reach = m => { fresh(); me.pass.magnet = m; let best = 0; for (let d = 40; d <= 400; d += 20){ pickups = [{ x: me.x + d, y: me.y, kind: 'xp', v: 1, life: 999, bob: 0 }]; me.xp = 0; for (let i = 0; i < 60; i++) update(0.05); if (me.xp > 0 || me.level > 1) best = d; } return best; };
    R.passives.magnet = { 0: reach(0), 5: reach(5), unit: 'px pickup reach' };
    // xpup: XP dropped by 100 kills of each enemy type
    const xpFrom = (lvl, type) => { srand(3); fresh(); me.pass.xpup = lvl; pickups = []; for (let i = 0; i < 100; i++){ const e = { x: 0, y: 0, type, xp: EDEF[type].xp, boss: false, hitCd: {} }; killEnemy(e, me); } return pickups.filter(u => u.kind === 'xp').reduce((s, u) => s + u.v, 0); };
    R.passives.xpup = {}; for (const ty of ['usb', 'inkjet', 'router', 'fax', 'laser']) R.passives.xpup[ty] = { 0: xpFrom(0, ty), 5: xpFrom(5, ty), expected5: Math.round(EDEF[ty].xp * 100 * 1.75) };
    return R;
  });
  const f = n => (typeof n === 'number' ? n.toFixed(1) : n).toString().padStart(9);
  console.log('WEAPON DPS (20 s vs 24 static dummies)\n' + 'weapon'.padEnd(10) + ['L1', 'L5', 'L5+dmg5', 'L5+atk5', 'L5+area5', 'L5+crit5'].map(s => s.padStart(9)).join(''));
  for (const [w, r] of Object.entries(out.weapons)) console.log(w.padEnd(10) + [r.L1, r.L5, r['L5+dmg5'], r['L5+atk5'], r['L5+area5'], r['L5+crit5']].map(f).join(''));
  console.log('\nPASSIVES (level 0 -> 5)');
  for (const [k, v] of Object.entries(out.passives)) if (k !== 'xpup') console.log(k.padEnd(10), v[0], '->', v[5], v.unit);
  console.log('xpup (XP from 100 kills):'); for (const [ty, v] of Object.entries(out.passives.xpup)) console.log('  ' + ty.padEnd(8), v[0], '->', v[5], '(expected ~' + v.expected5 + ')');
  if (errs.length) console.log('PAGE ERRORS', errs);
  await b.close();
})();
