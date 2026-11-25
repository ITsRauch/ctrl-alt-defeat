// Survival lab: a simple bot plays every class solo with fixed seeds, using the real game code
// (file://, synchronous simulation, no server). Prints survival time / level / kills per class.
// usage: node tests/survival.lab.cjs [path/to/index.html] [seeds=8] [maxMinutes=15]
const ROOT = require('path').join(__dirname, '..');
const { chromium } = require('playwright-core');
const FILE = require('path').resolve(process.argv[2] || ROOT + '/index.html');
const SEEDS = +(process.argv[3] || 8), MAXT = 60 * +(process.argv[4] || 15);
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME });
  const P = await (await b.newContext()).newPage(); const errs = []; P.on('pageerror', e => errs.push(e.message));
  await P.goto('file://' + FILE); await P.waitForTimeout(300);
  await P.evaluate(() => {
    let seed = 1; window.__srand = s => { seed = s; };
    Math.random = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let q = Math.imul(seed ^ seed >>> 15, 1 | seed); q = q + Math.imul(q ^ q >>> 7, 61 | q) ^ q; return ((q ^ q >>> 14) >>> 0) / 4294967296; };
    window.__steer = () => {
      let fx = 0, fy = 0, near = 1e9;
      for (const e of enemies){ const dx = me.x - e.x, dy = me.y - e.y, d2 = dx * dx + dy * dy; near = Math.min(near, d2);
        if (d2 < 320 * 320){ const w = (e.boss ? 4 : e.type === 'golem' ? 2 : 1) / Math.max(d2, 120); fx += dx * w; fy += dy * w; } }
      for (const q of eprojs){ const dx = me.x - q.x, dy = me.y - q.y, d2 = dx * dx + dy * dy; if (d2 < 160 * 160){ fx += dx * 2 / Math.max(d2, 60); fy += dy * 2 / Math.max(d2, 60); } }
      const m = 300;
      if (me.x < m) fx += (m - me.x) / m * .03; if (me.x > ARENA_W - m) fx -= (me.x - ARENA_W + m) / m * .03;
      if (me.y < m) fy += (m - me.y) / m * .03; if (me.y > ARENA_H - m) fy -= (me.y - ARENA_H + m) / m * .03;
      if (near > 140 * 140){ let g = null, gd = 1e9; for (const u of pickups){ const d = dist(u.x, u.y, me.x, me.y); if (d < gd && d < 500){ gd = d; g = u; } }
        if (g){ fx += (g.x - me.x) / gd * .006; fy += (g.y - me.y) / gd * .006; } }
      keys.clear();
      if (Math.hypot(fx, fy) > 1e-4){ const a = Math.atan2(fy, fx);
        if (Math.cos(a) > .38) keys.add('ArrowRight'); if (Math.cos(a) < -.38) keys.add('ArrowLeft');
        if (Math.sin(a) > .38) keys.add('ArrowDown'); if (Math.sin(a) < -.38) keys.add('ArrowUp'); }
    };
  });
  const res = {};
  for (let c = 0; c < 3; c++) for (let s = 1; s <= SEEDS; s++){
    const r = await P.evaluate(([c, s, MAXT]) => {
      __srand(s * 7919 + c); mode = 'solo'; myId = 0; st = 0; newRun(CHARS[c]); state = 'lab';
      while (t < MAXT){
        __steer(); update(0.05);
        if (me.offered){ const k = me.offered[Math.floor(Math.random() * me.offered.length)]; applyCard(me, k); me.offered = null; me.pending = Math.max(0, me.pending - 1); }
        if (st === 1 && me.pending <= 0) st = 0;
        if (st === 2) applyHostCmd('cont');
        if (st === 3 || me.dn > 0 || me.out) break;
      }
      keys.clear(); document.getElementById('levelup').classList.add('hidden');
      return { id: CHARS[c].id, t: Math.round(t), lv: me.level, k: me.kills, b: bossN };
    }, [c, s, MAXT]);
    (res[r.id] = res[r.id] || []).push(r);
  }
  const fmt = x => Math.floor(x / 60) + ':' + String(Math.round(x % 60)).padStart(2, '0');
  const med = a => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
  console.log(`SURVIVAL LAB  ${FILE.split('/').slice(-2).join('/')}  ${SEEDS} seeds/class, cap ${MAXT / 60} min`);
  console.log('class      median   avg     min    max    lvl  kills  boss-reached');
  for (const [id, a] of Object.entries(res)){
    const ts = a.map(r => r.t);
    console.log(id.padEnd(10), fmt(med(ts)).padStart(6), fmt(ts.reduce((x, y) => x + y) / ts.length).padStart(6), fmt(Math.min(...ts)).padStart(6), fmt(Math.max(...ts)).padStart(6),
      String(Math.round(a.reduce((x, r) => x + r.lv, 0) / a.length)).padStart(5), String(Math.round(a.reduce((x, r) => x + r.k, 0) / a.length)).padStart(6), (a.filter(r => r.b > 0).length + '/' + a.length).padStart(10));
  }
  if (errs.length) console.log('PAGE ERRORS', errs.slice(0, 3));
  await b.close();
})();
