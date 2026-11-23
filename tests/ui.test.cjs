const ROOT = require('path').join(__dirname, '..');   // repo root (server.js, data/)
const { chromium } = require('playwright-core');
const { spawn } = require('child_process'); const fs = require('fs');
const PORT = 18240, U = 'http://127.0.0.1:' + PORT, PW = 'ui-test-pw-77';
const ok = (c, m) => console.log((c ? 'PASS ' : 'FAIL ') + m);
(async () => {
  fs.mkdirSync(ROOT + '/data', { recursive: true });
  fs.writeFileSync(ROOT + '/data/highscores.json', JSON.stringify({ solo: [
    { id: '1111111111111111', time: 436, kills: 434, level: 14, bosses: 0, players: [{ n: 'Bob', c: 'helpdesk' }], date: Date.now() },
    { id: '2222222222222222', time: 130, kills: 144, level: 9, bosses: 0, players: [{ n: 'Alice', c: 'helpdesk' }], date: Date.now() }], multi: [] }));
  const srv = spawn('node', ['server.js', PORT], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, ADMIN_PASSWORD: PW, RATE_SCALE: '0' } });
  await new Promise(r => setTimeout(r, 500));
  fs.mkdirSync(ROOT + '/tests/screenshots', { recursive: true });
  const b = await chromium.launch({ executablePath: process.env.CHROME }); const errs = [];
  const pg = async () => { const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept()); await p.goto(U); await p.waitForTimeout(300); return p; };
  // ---------- helpdesk ----------
  const D = await pg(); await D.fill('#nameIn', 'Carol Q');
  ok((await D.inputValue('#nameIn')) === 'Carol Q', 'space can be typed in the name field (keydown fix)');
  ok((await D.textContent('#btnDesk')).trim() === '🎫 HELPDESK', 'menu shows HELPDESK button');
  await D.click('#btnDesk'); ok(await D.isVisible('#desk') && (await D.textContent('#tkList')).includes('No open tickets'), 'desk opens, empty state');
  await D.click('#btnNewTicket');
  ok((await D.inputValue('#tkAuthor')) === 'Carol Q', 'author prefilled from name');
  await D.selectOption('#tkType', 'feature'); await D.selectOption('#tkPrio', 'high');
  await D.click('#tkTitle'); await D.keyboard.type('Add a stapler <b>boss</b>');
  await D.fill('#tkDesc', 'It staples you to the desk.\nSecond line.');
  await D.keyboard.press('Escape'); ok(await D.isVisible('#desk'), 'Escape in textarea does not close the desk');
  await D.screenshot({ path: ROOT + '/tests/screenshots/u1-newticket.png' });
  await D.click('#tkSubmit'); await D.waitForTimeout(400);
  ok((await D.textContent('#tkPane')).includes('PRNT-0001 created') && (await D.textContent('#tkList')).includes('PRNT-0001'), 'ticket created, notice + list row');
  ok(!(await D.$('#tkPane b b')) && (await D.textContent('.tkh')).includes('<b>boss</b>'), 'HTML in title shown as text (escaped)');
  ok((await D.textContent('#btnDesk')).includes('1 open'), 'menu badge shows 1 open');
  await D.fill('#tkReply', 'Also: a laminator miniboss'); await D.click('#tkReplyBtn'); await D.waitForTimeout(300);
  ok((await D.textContent('#tkPane')).includes('laminator') && (await D.textContent('#tkPane')).includes('COMMENTS · 1'), 'comment added');
  ok(!(await D.isVisible('#tkStatus')), 'no admin controls without login');
  // second user sees the ticket
  const E = await pg(); await E.click('#btnDesk'); await E.waitForTimeout(400);
  ok((await E.textContent('#tkList')).includes('Add a stapler'), 'other colleague sees the ticket');
  // admin login
  await D.click('#desk .adminbtn'); await D.fill('#adminPw', 'wrong'); await D.click('#btnAdminGo'); await D.waitForTimeout(300);
  ok((await D.textContent('#adminErr')).includes('wrong admin password'), 'wrong admin password rejected');
  await D.fill('#adminPw', PW); await D.press('#adminPw', 'Enter'); await D.waitForTimeout(400);
  ok(!(await D.isVisible('#adminbox')) && (await D.textContent('#desk .adminbtn')).includes('admin mode'), 'admin login works');
  await D.click('.tkrow >> nth=0'); await D.waitForTimeout(200);
  await D.selectOption('#tkStatus', 'progress'); await D.waitForTimeout(400);
  ok((await D.textContent('#tkPane')).includes('IN PROGRESS'), 'admin sets IN PROGRESS');
  await D.fill('#tkReply', 'Working on it'); await D.click('#tkReplyBtn'); await D.waitForTimeout(300);
  ok((await D.textContent('#tkPane')).includes('ADMIN'), 'admin comment has ADMIN badge');
  await D.screenshot({ path: ROOT + '/tests/screenshots/u2-admin-ticket.png' });
  await D.selectOption('#tkStatus', 'done'); await D.waitForTimeout(400);
  ok((await D.textContent('#tkList')).includes('No open tickets') && (await D.textContent('#btnDesk')).trim() === '🎫 HELPDESK', 'resolved ticket leaves OPEN filter, badge cleared');
  await D.click('#desk .tab[data-f=closed]'); ok((await D.textContent('#tkList')).includes('RESOLVED'), 'CLOSED filter shows resolved ticket');
  await D.click('.tkrow >> nth=0'); await D.click('#tkDelete'); await D.waitForTimeout(400);
  ok((await D.textContent('#tkPane')).includes('deleted') && !(await D.textContent('#tkList')).includes('PRNT-0001'), 'admin deletes ticket');
  await D.keyboard.press('Escape'); ok(!(await D.isVisible('#desk')), 'Escape closes desk');
  // highscore admin delete
  await D.click('#btnScores'); await D.waitForTimeout(400);
  ok(await D.$('#hsTable .xbtn'), 'admin sees delete buttons in highscores');
  await D.screenshot({ path: ROOT + '/tests/screenshots/u3-scores-admin.png' });
  await D.click('#hsTable .xbtn >> nth=0'); await D.waitForTimeout(400);
  const hs = await (await fetch(U + '/api/highscores')).json();
  ok(hs.solo.length === 1 && hs.solo[0].players[0].n === 'Alice' && !(await D.textContent('#hsTable')).includes('Bob'), 'cheat score deleted via UI');
  ok(!(await E.evaluate(`document.querySelector('#hsTable .xbtn')`)), 'non-admin has no delete buttons');
  await D.click('#scores .adminbtn'); ok(!(await D.evaluate('adminKey')), 'admin logout');
  // ---------- regression: lobby + multiplayer ----------
  const H = await pg(); await H.fill('#nameIn', 'Host'); await H.click('#btnHost'); await H.waitForTimeout(400); const code = await H.evaluate('roomCode');
  ok(await H.isVisible('#lobby') && code.length === 4, 'host lobby ' + code);
  const A = await pg(); await A.fill('#nameIn', 'Anna'); await A.fill('#codeIn', code); await A.click('#btnJoin'); await A.waitForTimeout(400);
  await A.click('.clsbtn >> nth=1'); await A.click('#btnReady'); await A.waitForTimeout(400);
  ok((await H.textContent('#lobbyList')).includes('Helpdesk Tier 1') && (await H.textContent('#btnStartShift')).startsWith('ALL READY'), 'class + ready visible to host');
  await H.click('#btnStartShift'); await H.waitForTimeout(800);
  ok(await A.evaluate('state') === 'playing' && await A.evaluate('me.ch.id') === 'helpdesk', 'client plays chosen class');
  const y0 = await H.evaluate(`players[1].y`); await A.keyboard.down('ArrowDown'); await A.waitForTimeout(600); await A.keyboard.up('ArrowDown'); await A.waitForTimeout(300);
  const y1 = await H.evaluate(`players[1].y`); await A.waitForTimeout(700); const y2 = await H.evaluate(`players[1].y`);
  ok(y1 > y0 + 40 && y1 === y2, `client moves and stops (${y0} -> ${y1} -> ${y2})`);
  const C = await pg(); await C.fill('#codeIn', code); await C.click('#btnJoin'); await C.waitForTimeout(500);
  ok(await C.evaluate('lateJoin'), 'late joiner gets mini lobby'); await C.click('#btnReady'); await C.waitForTimeout(600);
  ok(await C.evaluate('state') === 'playing' && await H.evaluate('players.length') === 3, 'late joiner in game');
  const S = await pg(); await S.click('#btnSolo'); await S.click('#charSel button >> nth=0'); await S.waitForTimeout(800);
  const soloCode = await S.evaluate('roomCode');
  const X = await pg(); await X.fill('#codeIn', soloCode); await X.click('#btnJoin'); await X.waitForTimeout(500);
  ok(soloCode.length === 4 && (await X.textContent('#startErr')).includes('not found'), 'solo rooms cannot be joined');
  ok(errs.length === 0, 'no page errors ' + errs.join(' | '));
  await b.close(); srv.kill(); fs.rmSync(ROOT + '/data', { recursive: true, force: true });
})();
