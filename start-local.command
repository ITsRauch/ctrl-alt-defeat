#!/bin/bash
# Double-click (macOS) or run ./start-local.command: plays CTRL-ALT-DEFEAT locally with the full feature set.
# Highscores/tickets go to ./data next to this file (separate from any shared server). Stop with Ctrl-C.
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 18+ is required: https://nodejs.org"; read -r; exit 1; }
PORT="${1:-8091}"
( sleep 1; open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null ) &
echo "CTRL-ALT-DEFEAT local: http://localhost:$PORT   (Ctrl-C to stop)"
exec node server.js "$PORT"
