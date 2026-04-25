#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_URL=$(grep '^PUBLIC_URL=' "${SCRIPT_DIR}/.env" | cut -d= -f2-)

TOKEN=$(docker exec hopps_postgres psql -U hoppscotch -d hoppscotch -t -A \
    -c "SELECT token FROM \"VerificationToken\" WHERE \"expiresOn\" > NOW() ORDER BY \"expiresOn\" DESC LIMIT 1;" \
    2>/dev/null | tr -d '[:space:]')

if [ -z "${TOKEN}" ]; then
    echo "No valid tokens found. Trigger a new one:"
    echo ""
    echo "  curl -s -X POST ${PUBLIC_URL}/api/auth/signin \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -d '{\"email\":\"admin@paysyslabs.com\"}'"
    echo ""
    echo "Then run this script again."
    exit 0
fi

echo ""
echo "Magic link:"
echo ""
echo "  ${PUBLIC_URL}/enter?token=${TOKEN}"
echo ""
echo "Open in browser to complete login."
