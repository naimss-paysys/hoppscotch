#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Hoppscotch Full Stack Startup Script
# Starts services in correct order with health verification
# ──────────────────────────────────────────────────────────────
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log()     { echo -e "${GREEN}[START]${NC}  $*"; }
info()    { echo -e "${BLUE}[INFO]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}   $*"; }
fail()    { echo -e "${RED}[FAIL]${NC}   $*"; exit 1; }
section() { echo -e "\n${BOLD}${BLUE}══ $* ══${NC}\n"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# ────────────────────────────────────────────────────────────────
# STEP 1 — Start PostgreSQL and Redis
# ────────────────────────────────────────────────────────────────
section "STEP 1: Starting PostgreSQL and Redis"

docker compose up -d postgres-hopps redis
log "Containers started, waiting for initialization..."

# ────────────────────────────────────────────────────────────────
# STEP 2 — Wait for PostgreSQL to be healthy
# ────────────────────────────────────────────────────────────────
section "STEP 2: Waiting for PostgreSQL to be healthy"

MAX_WAIT=60
ELAPSED=0
until docker inspect --format='{{.State.Health.Status}}' hopps_postgres 2>/dev/null | grep -q "healthy"; do
    if [ $ELAPSED -ge $MAX_WAIT ]; then
        fail "PostgreSQL did not become healthy within ${MAX_WAIT}s"
    fi
    warn "PostgreSQL not ready yet... (${ELAPSED}s elapsed)"
    sleep 5
    ELAPSED=$((ELAPSED + 5))
done
log "PostgreSQL is healthy ✓"

# Wait for Redis too
ELAPSED=0
until docker inspect --format='{{.State.Health.Status}}' hopps_redis 2>/dev/null | grep -q "healthy"; do
    if [ $ELAPSED -ge 30 ]; then
        fail "Redis did not become healthy within 30s"
    fi
    warn "Redis not ready yet... (${ELAPSED}s elapsed)"
    sleep 3
    ELAPSED=$((ELAPSED + 3))
done
log "Redis is healthy ✓"

# ────────────────────────────────────────────────────────────────
# STEP 3 — Run Database Migrations
# ────────────────────────────────────────────────────────────────
section "STEP 3: Running Database Migrations"

bash "${SCRIPT_DIR}/migrate.sh"

# ────────────────────────────────────────────────────────────────
# STEP 4 — Verify Tables Exist
# ────────────────────────────────────────────────────────────────
section "STEP 4: Verifying Database Schema"

TABLE_COUNT=$(docker exec hopps_postgres \
    psql -U hoppscotch -d hoppscotch -t \
    -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" \
    | tr -d '[:space:]')

if [ "${TABLE_COUNT}" -lt "5" ]; then
    fail "Only ${TABLE_COUNT} tables found — expected at least 5. Migrations failed."
fi
log "Database schema verified: ${TABLE_COUNT} tables found ✓"

# ────────────────────────────────────────────────────────────────
# STEP 5 — Start Backend
# ────────────────────────────────────────────────────────────────
section "STEP 5: Starting Hoppscotch Backend"

docker compose up -d hoppscotch-backend
log "Backend container started"

# ────────────────────────────────────────────────────────────────
# STEP 6 — Wait for Backend to be Healthy
# ────────────────────────────────────────────────────────────────
section "STEP 6: Waiting for Backend to become healthy (timeout: 120s)"

MAX_WAIT=120
ELAPSED=0
until docker inspect --format='{{.State.Health.Status}}' hopps_backend 2>/dev/null | grep -q "healthy"; do
    if [ $ELAPSED -ge $MAX_WAIT ]; then
        warn "Backend health timeout reached. Dumping logs:"
        docker compose logs --tail=30 hoppscotch-backend
        fail "Backend did not become healthy within ${MAX_WAIT}s"
    fi
    warn "Backend not ready yet... (${ELAPSED}s / ${MAX_WAIT}s)"
    sleep 10
    ELAPSED=$((ELAPSED + 10))
done
log "Backend is healthy ✓"

# ────────────────────────────────────────────────────────────────
# STEP 7 — Start Frontend, Admin, and Nginx
# ────────────────────────────────────────────────────────────────
section "STEP 7: Starting Frontend, Admin, and Nginx"

docker compose up -d hoppscotch-frontend hoppscotch-admin nginx
log "All remaining services started"

# Give nginx a moment to initialize
sleep 5

# ────────────────────────────────────────────────────────────────
# STEP 8 — Final Health Check and URLs
# ────────────────────────────────────────────────────────────────
section "STEP 8: Final Verification"

# Test the API ping through nginx
if curl -sf http://REDACTED_SERVER_IP:8090/api/ping > /dev/null 2>&1; then
    log "API ping through nginx: ✓"
else
    warn "API ping through nginx: FAILED (may need a few more seconds)"
fi

echo ""
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}   Hoppscotch is UP and running!${NC}"
echo -e "${BOLD}${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Main App:${NC}    http://api.paysyslabs.com:8090"
echo -e "  ${BOLD}Admin Panel:${NC} http://api.paysyslabs.com:8090/admin"
echo -e "  ${BOLD}API:${NC}         http://api.paysyslabs.com:8090/api"
echo -e "  ${BOLD}Keycloak:${NC}    http://api.paysyslabs.com:8080"
echo ""
echo -e "  ${BOLD}First login:${NC} Use magic link (check logs)"
echo -e "  ${YELLOW}  bash get-magic-link.sh${NC}"
echo ""
echo -e "  ${BOLD}Watch logs:${NC}  docker compose logs -f"
echo ""