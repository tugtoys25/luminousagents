#!/usr/bin/env bash
# One command to run the free scanner: ClamAV + signed-result service (+ optional tunnel).
# Run inside Debian:  bash scanner-service/start.sh
set -euo pipefail
cd "$(dirname "$0")"
DATA="${SCANNER_HOME:-$HOME/.mayfair-scanner}"
mkdir -p "$DATA/db"

if [ ! -f "$DATA/secrets.env" ]; then
  umask 077
  {
    echo "SCANNER_TOKEN=$(openssl rand -hex 32)"
    echo "SCANNER_SIGNING_SECRET=$(openssl rand -hex 32)"
    echo "SCANNER_PROVIDER=clamav-selfhosted"
  } > "$DATA/secrets.env"
  echo "Created $DATA/secrets.env (keep it private)."
fi
set -a; . "$DATA/secrets.env"; set +a

cat > "$DATA/freshclam.conf" <<CONF
DatabaseDirectory $DATA/db
DatabaseMirror database.clamav.net
CONF
cat > "$DATA/clamd.conf" <<CONF
DatabaseDirectory $DATA/db
TCPSocket 3310
TCPAddr 127.0.0.1
Foreground yes
StreamMaxLength 25M
MaxFileSize 25M
MaxScanSize 100M
CONF
if [ "$(id -u)" = "0" ]; then
  echo "User root" >> "$DATA/clamd.conf"
  echo "DatabaseOwner root" >> "$DATA/freshclam.conf"
fi

if ! ls "$DATA/db"/*.c[vl]d >/dev/null 2>&1; then
  echo "Downloading virus definitions (first run only, a few minutes)..."
  freshclam --config-file "$DATA/freshclam.conf"
fi

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

clamd --config-file "$DATA/clamd.conf" > "$DATA/clamd.log" 2>&1 &
PIDS+=($!)
echo -n "Starting ClamAV"
for _ in $(seq 1 180); do
  if (exec 3<>/dev/tcp/127.0.0.1/3310) 2>/dev/null; then break; fi
  echo -n "."; sleep 2
done
echo " ready."

node server.mjs &
PIDS+=($!)
sleep 1

if command -v cloudflared >/dev/null 2>&1; then
  echo "Starting free Cloudflare tunnel. Your scanner URL is the https://....trycloudflare.com line below."
  cloudflared tunnel --url http://127.0.0.1:8787 2>&1 | tee "$DATA/tunnel.log" &
  PIDS+=($!)
else
  echo "cloudflared not installed: the scanner is only reachable locally. See scanner-service/README.md step 2."
fi
wait
