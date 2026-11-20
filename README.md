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

## Highscores
Top 20, separately for **solo** (1 admin) and **multiplayer** (2+ admins who took part in the run),
ranked by time survived, then printers destroyed. The host submits automatically at game over
(runs under 10 s don't count). Stored in `data/highscores.json` next to `server.js`
(atomic writes, survives restarts). To reset: stop the service, delete the file, start again.
API: `GET /api/highscores`, `POST /api/highscores` (validated, max 1 post / 3 s per IP).
Only `index.html` is served over HTTP — `server.js`, `README.md` and `data/` are not.

## Firewall
Allow inbound TCP 8091 on the server, LAN only. Don't port-forward it to the internet.

## Files
- `index.html` — the whole game (host + client logic in one page)
- `server.js` — static file server + WebSocket room relay
