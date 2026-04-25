#!/usr/bin/env bash
# Get magic login link from Hoppscotch DB
# Use when MAILER_SMTP_ENABLE=false — token is in DB, never emailed or logged
set -euo pipefail

BASE_URL="http://api.paysyslabs.com:8090"

TOKEN=$(docker exec hopps_postgres psql -U hoppscotch -d hoppscotch -t -A \
    -c "SELECT token FROM \"VerificationToken\" WHERE \"expiresOn\" > NOW() ORDER BY \"expiresOn\" DESC LIMIT 1;" \
    2>/dev/null | tr -d '[:space:]')

if [ -z "${TOKEN}" ]; then
    echo "No valid tokens found. Trigger a new one:"
    echo ""
    echo "  curl -s -X POST ${BASE_URL}/api/auth/signin \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -d '{\"email\":\"admin@paysyslabs.com\"}'"
    echo ""
    echo "Then run this script again."
    exit 0
fi

echo ""
echo "Magic link:"
echo ""
echo "  ${BASE_URL}/enter?token=${TOKEN}"
echo ""
echo "Open in browser to complete login."
