# CTRL-ALT-DEFEAT MP — LAN co-op (Printer Uprising)

## Run the server
Any machine with Node 18+ (no npm install needed — zero dependencies):

    node server.js          # default port 8091
    node server.js 9000     # or pick a port

## Play
1. **Host player** opens `http://<SERVER_IP>:8091`, types a name, clicks **HOST**, picks a character. A 4-letter room code appears in the green banner.
2. **Everyone else** opens the same URL on their own computer, types their name + the room code, clicks **JOIN**, picks a character.
3. The host tab runs the authoritative simulation. Clients send input and render 20 Hz snapshots — no installs, just a browser.

Max ~4 admins per room. If the host closes the tab, everyone gets a clean "HOST LOGGED OFF" scoreboard.

## Firewall
Allow inbound TCP 8091 on the server, LAN only. Don't port-forward it to the internet.

## Files
- `index.html` — the whole game (host + client logic in one page)
- `server.js` — static file server + WebSocket room relay
