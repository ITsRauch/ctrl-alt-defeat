# CTRL-ALT-DEFEAT MP — LAN co-op (Printer Uprising)

## Run the server
**Docker (as deployed on the LAN server, `/opt/ctrl-alt-defeat`):**

    sudo docker compose up -d --build     # build + start (port 8091)
    sudo docker compose logs -f           # logs
    sudo docker compose down              # stop

Highscores live in `./data/highscores.json` (bind mount, survives rebuilds).
Updating the game = copy the new `index.html`/`server.js` here, then `sudo docker compose up -d --build`.

**Without Docker:** any machine with Node 18+ (zero dependencies):

    node server.js          # default port 8091
    node server.js 9000     # or pick a port

## Play
1. **Host:** open `http://<SERVER_IP>:8091`, enter a name, click **HOST A NEW GAME**.
   A lobby with a big **room code** opens — share the code or click **copy invite link**
   (`http://<SERVER_IP>:8091/?join=CODE` pre-fills the code).
2. **Everyone else:** open the same URL (or the invite link), enter a name + the code under **JOIN A GAME**.
3. **Lobby:** everyone picks a **class** (can be changed until the start) and clicks **I'M READY**.
   The host sees name, class and ready state of every admin. Once all are ready the start button
   turns green — the host presses **START SHIFT** (or "START ANYWAY" if someone forgot to ready up).
4. **Late joiners** get a short "shift already running" screen, pick a class and jump in next to the host.

The host tab runs the authoritative simulation — keep it open. Max 4 admins per room.
If the host closes the tab, everyone gets a clean "HOST LOGGED OFF" screen.
The same guide is shown in-game on the start screen.

## Highscores & anti-cheat
Top 20, separately for **solo** and **multiplayer** (2+ admins took part), ranked by time survived,
then printers destroyed. Stored in `data/highscores.json`.

Scores are **recorded by the server only**. Every run (solo too) streams 20 Hz snapshots through
the server, which checks them against the game rules: max HP per class, HP <= max HP, every hit
against the strongest possible weapon hit, movement speed, game clock vs. real time, kills vs.
printers ever spawned, boss timing, level vs. available XP. Any violation -> "INTEGRITY CHECK FAILED",
nothing is stored, the reason is shown to everyone and logged (`INTEGRITY FAIL ...`).
This stops DevTools number tweaking; someone forging whole snapshots by script can still get through.
The limits live in `server.js` (`CLS`, `WDMG`, ...) and must be updated when balancing changes.

## Co-op XP & balancing (v1.3)
- **Shared team XP:** one XP bar for the whole team; each extra admin adds +55 % XP per level
  (`TEAM_XP_PER_PLAYER`). On a team level-up every admin picks a card at the same time; the shift
  resumes when all are done. Late joiners start at the team level and pick catch-up cards while the
  others keep playing (they are protected meanwhile).
- Classes: Sysadmin 135 speed / +20 % damage, Helpdesk 172 speed / 85 HP, DevOps 125 speed /
  10 % less damage taken / 0.9 HP/s regen. Every level adds +2 % damage; printer HP doubles every 110 s.
- Coffee: 3 % drop, heals 25 % max HP, +20 % speed for 5 s. Revive: 80 px, 2 s, reviver takes half damage.
- Balance is measured, not guessed: `npm run lab` (weapon DPS / passive effects) and
  `npm run lab:survival -- [file] [seeds]` (bot plays every class, survival time per class).
  Remember to update the anti-cheat limits in `server.js` with any balance change.

## Field manual
**📖 FIELD MANUAL** in the menu: all printers (stats, behaviour, when they appear), weapons (level 1 → 5,
which patches boost them), patches, pickups and admin classes. Values are read from the game data
(`EDEF`, `WDEF`, `PDEF`, `CHARS`), icons use the in-game sprites; behaviour texts live in `MAN_E` / `MAN_BOOST`.

## Helpdesk tickets
**🎫 HELPDESK** in the menu: everybody can open tickets (bug / feature / other, priority) and comment.
Admins change status (NEW / IN PROGRESS / RESOLVED / WON'T FIX) and delete tickets.
Stored in `data/tickets.json`. Rate limits: 1 ticket / 15 s, 1 comment / 5 s per IP.

## Admin
Password file: `secrets/admin_password` (mounted read-only, env `ADMIN_PASSWORD_FILE`).
Log in via **🔑 admin** in the helpdesk or highscore screen. Admins can also delete highscores.
5 wrong passwords -> 5 min lockout per IP. Note: plain HTTP on the LAN, so treat it as a game
password, not a real one. Change it: edit the file, then `sudo docker compose restart`.

## Firewall
Allow inbound TCP 8091 on the server, LAN only. Don't port-forward it to the internet.

## Development & tests
The game itself has **no dependencies**. The tests drive real headless Chrome instances via
`playwright-core` (dev only) against a local server on ports 182xx; they never touch the LAN server.

    npm install
    npx playwright install chromium        # or: export CHROME=/path/to/chrome
    npm test                               # api, ui/regression, anti-cheat, endless boss  (~2 min)
    npm run test:edge                      # maxed builds + real 150 s boss run  (~3 min)
    npm run lab                            # power-up lab: DPS per weapon level/passive, passive effects
    npm run lab:survival                   # survival lab: bot plays each class (fixed seeds)

Run them after every change to `index.html` / `server.js`, especially balancing changes:
the anti-cheat limits in `server.js` (`CLS`, `WDMG`, ...) must match the game constants.

## Deploy (LAN server)
Copy `index.html`, `server.js` (and `compose.yaml`/`Dockerfile` if changed) to
`/opt/ctrl-alt-defeat/`, then `sudo docker compose up -d --build`.
`data/` (scores, tickets) and `secrets/admin_password` stay on the server and are not in git.

## Files
- `index.html` — the whole game (host + client logic, lobby, highscores, helpdesk UI) in one page
- `server.js` — static server, WebSocket room relay, anti-cheat witness, highscore/ticket/admin API
- `Dockerfile`, `compose.yaml`, `.dockerignore` — hardened container as deployed on the LAN server
- `tests/` — headless-browser and API test suites, `powerups.lab.cjs` balance lab (dev only)
