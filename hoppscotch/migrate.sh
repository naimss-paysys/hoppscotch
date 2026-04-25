#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Hoppscotch Database Migration Script
# Runs Prisma migrations against postgres-hopps container
# ──────────────────────────────────────────────────────────────
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[MIGRATE]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}   $*"; }
fail() { echo -e "${RED}[FAIL]${NC}   $*"; exit 1; }

# ── Config ────────────────────────────────────────────────────
DB_USER="hoppscotch"
DB_PASS="hoppscotch123"
DB_NAME="hoppscotch"
DB_HOST="postgres-hopps"
DB_PORT="5432"
NETWORK="hopps-net"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

log "Starting Hoppscotch database migrations..."
log "Database URL: postgresql://${DB_USER}:***@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# ── Wait for postgres to be reachable ─────────────────────────
log "Checking postgres-hopps connectivity..."
MAX_RETRIES=20
COUNT=0
until docker exec hopps_postgres pg_isready -U "${DB_USER}" -d "${DB_NAME}" > /dev/null 2>&1; do
    COUNT=$((COUNT + 1))
    if [ $COUNT -ge $MAX_RETRIES ]; then
        fail "postgres-hopps did not become ready after ${MAX_RETRIES} attempts"
    fi
    warn "Waiting for postgres... attempt ${COUNT}/${MAX_RETRIES}"
    sleep 3
done
log "PostgreSQL is ready ✓"

# ── Run Prisma Migrations ─────────────────────────────────────
log "Running: npx prisma migrate deploy"
docker run --rm \
    --network "${NETWORK}" \
    -e DATABASE_URL="${DATABASE_URL}" \
    hoppscotch/hoppscotch-backend:latest \
    sh -c "npx prisma migrate deploy" \
    && log "Prisma migrations completed ✓" \
    || fail "Prisma migration FAILED — check output above"

# ── Verify Tables Exist ───────────────────────────────────────
log "Verifying tables were created..."
TABLE_COUNT=$(docker exec hopps_postgres \
    psql -U "${DB_USER}" -d "${DB_NAME}" -t \
    -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" \
    | tr -d '[:space:]')

if [ "${TABLE_COUNT}" -gt "0" ]; then
    log "Found ${TABLE_COUNT} tables in database ✓"
else
    fail "No tables found — migration may have failed silently"
fi

# ── List Tables ───────────────────────────────────────────────
log "Tables in hoppscotch database:"
docker exec hopps_postgres \
    psql -U "${DB_USER}" -d "${DB_NAME}" -c "\dt"

log ""
log "══════════════════════════════════════"
log "  Migration completed successfully!   "
log "══════════════════════════════════════"