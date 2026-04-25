#!/bin/bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# tunnel-restart.sh
# Restarts Cloudflare Quick Tunnel, reads the new random URL,
# updates PUBLIC_URL + PUBLIC_WS_URL in .env,
# then restarts all affected containers.
#
# Usage:
#   ./tunnel-restart.sh          # restart tunnel + update all
#   ./tunnel-restart.sh --local  # switch back to local mode
# ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Local mode — switch back to internal URL ──────────────────
if [[ "${1:-}" == "--local" ]]; then
  echo "Switching to local mode..."
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=http://api.paysyslabs.com:8090|" .env
  sed -i "s|^PUBLIC_WS_URL=.*|PUBLIC_WS_URL=ws://api.paysyslabs.com:8090|" .env
  sed -i "s|^ALLOW_SECURE_COOKIES=.*|ALLOW_SECURE_COOKIES=false|" .env
  docker compose stop cloudflared
  docker compose up -d --force-recreate hoppscotch-backend smtp-bridge
  echo "Waiting for backend to be healthy..."
  ELAPSED=0
  until docker inspect --format='{{.State.Health.Status}}' hopps_backend 2>/dev/null | grep -q "healthy"; do
    if [ $ELAPSED -ge 120 ]; then echo "ERROR: Backend did not become healthy"; exit 1; fi
    sleep 5; ELAPSED=$((ELAPSED + 5))
  done
  docker compose up -d --force-recreate hoppscotch-frontend hoppscotch-admin
  docker exec hopps_nginx nginx -s reload 2>/dev/null || true
  echo ""
  echo "Local mode active: http://api.paysyslabs.com:8090"
  exit 0
fi

# ── Restart cloudflared to get a fresh URL ────────────────────
echo "Restarting Cloudflare tunnel..."
docker compose rm -sf cloudflared 2>/dev/null || true
docker compose up -d cloudflared

# ── Wait for tunnel URL (up to 60 seconds) ───────────────────
echo "Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(docker logs hopps_cloudflared 2>&1 \
    | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' \
    | head -1 || true)
  if [[ -n "$TUNNEL_URL" ]]; then
    break
  fi
  sleep 2
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "ERROR: Could not get tunnel URL after 60s"
  echo "Check logs: docker logs hopps_cloudflared"
  exit 1
fi

WS_URL="${TUNNEL_URL/https:\/\//wss://}"
echo "Tunnel URL: $TUNNEL_URL"

# ── Update .env ───────────────────────────────────────────────
sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=${TUNNEL_URL}|" .env
sed -i "s|^PUBLIC_WS_URL=.*|PUBLIC_WS_URL=${WS_URL}|" .env
sed -i "s|^ALLOW_SECURE_COOKIES=.*|ALLOW_SECURE_COOKIES=true|" .env
echo "Updated PUBLIC_URL and PUBLIC_WS_URL in .env"

# ── Restart backend first, wait for healthy ───────────────────
echo "Restarting backend..."
docker compose up -d --force-recreate hoppscotch-backend smtp-bridge

echo "Waiting for backend to be healthy (up to 120s)..."
ELAPSED=0
until docker inspect --format='{{.State.Health.Status}}' hopps_backend 2>/dev/null | grep -q "healthy"; do
  if [ $ELAPSED -ge 120 ]; then
    echo "ERROR: Backend did not become healthy within 120s"
    echo "Check logs: docker compose logs --tail=30 hoppscotch-backend"
    exit 1
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done
echo "Backend healthy ✓"

# ── Now start frontend and admin ──────────────────────────────
echo "Starting frontend and admin..."
docker compose up -d --force-recreate \
  hoppscotch-frontend \
  hoppscotch-admin

# ── Reload nginx to pick up new container IPs ─────────────────
docker exec hopps_nginx nginx -s reload 2>/dev/null && echo "Nginx reloaded ✓" || true

echo ""
echo "════════════════════════════════════════════════"
echo "  Public URL:  $TUNNEL_URL"
echo "  Admin panel: $TUNNEL_URL/admin"
echo "════════════════════════════════════════════════"
echo ""
echo "MANUAL STEP REQUIRED — Update GitHub OAuth:"
echo "  github.com → Settings → Developer settings"
echo "  → OAuth Apps → your app"
echo "  → Authorization callback URL:"
echo "  $TUNNEL_URL/api/auth/github/callback"
echo ""
echo "Then restart smtp-bridge after updating GitHub:"
echo "  docker compose restart smtp-bridge"
