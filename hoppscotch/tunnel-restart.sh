#!/bin/bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# tunnel-restart.sh
# Manages the ngrok static domain tunnel.
# URL never changes: https://dander-pork-headgear.ngrok-free.dev
#
# Usage:
#   ./tunnel-restart.sh          # switch to tunnel mode (ngrok)
#   ./tunnel-restart.sh --local  # switch back to local VPN mode
# ──────────────────────────────────────────────────────────────

NGROK_URL="https://dander-pork-headgear.ngrok-free.dev"
NGROK_WS="wss://dander-pork-headgear.ngrok-free.dev"
LOCAL_URL="http://api.paysyslabs.com:8090"
LOCAL_WS="ws://api.paysyslabs.com:8090"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

wait_backend_healthy() {
  echo "Waiting for backend to be healthy (up to 120s)..."
  ELAPSED=0
  until docker inspect --format='{{.State.Health.Status}}' hopps_backend 2>/dev/null | grep -q "healthy"; do
    if [ $ELAPSED -ge 120 ]; then
      echo "ERROR: Backend did not become healthy within 120s"
      echo "Check logs: docker compose logs --tail=30 hoppscotch-backend"
      exit 1
    fi
    sleep 5; ELAPSED=$((ELAPSED + 5))
  done
  echo "Backend healthy ✓"
}

# ── Local mode — switch back to internal URL ──────────────────
if [[ "${1:-}" == "--local" ]]; then
  echo "Switching to local mode..."
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=${LOCAL_URL}|" .env
  sed -i "s|^PUBLIC_WS_URL=.*|PUBLIC_WS_URL=${LOCAL_WS}|" .env
  sed -i "s|^ALLOW_SECURE_COOKIES=.*|ALLOW_SECURE_COOKIES=false|" .env
  docker compose stop ngrok
  docker compose up -d --force-recreate hoppscotch-backend smtp-bridge
  wait_backend_healthy
  docker compose up -d --force-recreate hoppscotch-frontend hoppscotch-admin
  docker exec hopps_nginx nginx -s reload 2>/dev/null || true
  echo ""
  echo "Local mode active: ${LOCAL_URL}"
  exit 0
fi

# ── Tunnel mode — switch to ngrok static domain ───────────────
CURRENT_URL=$(grep '^PUBLIC_URL=' .env | cut -d= -f2-)

if [[ "$CURRENT_URL" != "$NGROK_URL" ]]; then
  echo "Updating .env to ngrok domain..."
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=${NGROK_URL}|" .env
  sed -i "s|^PUBLIC_WS_URL=.*|PUBLIC_WS_URL=${NGROK_WS}|" .env
  sed -i "s|^ALLOW_SECURE_COOKIES=.*|ALLOW_SECURE_COOKIES=true|" .env
  echo "Restarting backend with new URL..."
  docker compose up -d --force-recreate hoppscotch-backend smtp-bridge
  wait_backend_healthy
  docker compose up -d --force-recreate hoppscotch-frontend hoppscotch-admin
  docker exec hopps_nginx nginx -s reload 2>/dev/null || true
else
  echo "PUBLIC_URL already set to ngrok domain — no restart needed."
fi

# Ensure ngrok is running
docker compose up -d ngrok

echo ""
echo "════════════════════════════════════════════════"
echo "  Public URL:  ${NGROK_URL}"
echo "  Admin panel: ${NGROK_URL}/admin"
echo "════════════════════════════════════════════════"
echo ""
echo "GitHub OAuth callback URL (set once, never changes):"
echo "  ${NGROK_URL}/api/auth/github/callback"
