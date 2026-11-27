#!/bin/sh
# One-time setup for the Docker deployment (no root needed):
# creates ./data and ./secrets/admin_password owned by you, and a .env with your UID/GID.
set -e
cd "$(dirname "$0")"
mkdir -p data secrets
chmod 700 secrets
if [ ! -s secrets/admin_password ]; then
  ( umask 077
    if command -v openssl >/dev/null; then openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20
    else LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20; fi > secrets/admin_password )
  echo "created secrets/admin_password  (read it with: cat secrets/admin_password)"
else
  echo "keeping existing secrets/admin_password"
fi
if [ ! -f .env ]; then
  { echo "APP_UID=$(id -u)"; echo "APP_GID=$(id -g)"
    echo "# BIND_IP=192.168.1.10   # optional: listen on this LAN address only"
    echo "# PORT=8091"; } > .env
  echo "created .env (APP_UID=$(id -u), APP_GID=$(id -g))"
else
  echo "keeping existing .env"
fi
echo "done - start with: docker compose up -d --build   (then open http://<this-machine>:8091)"
