#!/usr/bin/env bash
# Manual deploy of wa-status to the EMHA Universe VPS.
#
#   bash scripts/deploy-vps.sh
#
# Builds dist/ locally, ships it (plus the container files) over ssh as a tar
# stream — this dev box has no rsync — then rebuilds the container on the VPS.
# dist/ is wiped on the box first so stale hashed assets don't pile up.
set -euo pipefail

# Key hidup di folder personal, bukan ~/.ssh, di mesin Windows ini.
for candidate in "$HOME/.ssh/development" "$HOME/Documents/mansyur-personal/.ssh/development"; do
  if [ -z "${KEY:-}" ] && [ -f "$candidate" ]; then KEY="$candidate"; fi
done
KEY="${KEY:?private key development tidak ditemukan; set KEY=/path/ke/development}"
HOST="${HOST:-root@103.169.207.239}"
DIR="${DIR:-/opt/wa-status}"
URL="${URL:-https://wastatus.emha.space}"

cd "$(dirname "$0")/.."

echo "==> building dist/ locally"
npm run build

echo "==> shipping to $HOST:$DIR"
tar czf - dist Dockerfile Caddyfile.container docker-compose.prod.yml .dockerignore \
  | ssh -i "$KEY" "$HOST" "mkdir -p '$DIR' && rm -rf '$DIR/dist' && tar xzf - -C '$DIR'"

echo "==> build & up on VPS"
ssh -i "$KEY" "$HOST" bash -se <<REMOTE
set -e
cd '$DIR'
docker compose -f docker-compose.prod.yml up -d --build
docker image prune -f
REMOTE

echo "==> smoke test $URL"
ssh -i "$KEY" "$HOST" \
  "sleep 3; curl -fsS --retry 5 --retry-delay 3 --retry-connrefused \
     --resolve wastatus.emha.space:443:127.0.0.1 '$URL/' -o /dev/null \
   && echo 'Smoke OK: wa-status live'"
