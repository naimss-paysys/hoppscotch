# Hoppscotch — Phase 2 Context
# Server OS: RHEL 8.10 — see parent CLAUDE.md for full context

## What Hoppscotch Is
Self-hosted API testing platform. Runs on http://api.paysyslabs.com:8090
Auth via Keycloak OIDC (Phase 1 must be running first).

## Files in This Directory
```
hoppscotch/
├── CLAUDE.md
├── .env
├── docker-compose.yml
├── migrate.sh
├── start.sh
├── get-magic-link.sh
└── nginx/
    └── conf.d/
        └── hoppscotch.conf
```

## Services
| Container        | Image                                 | Internal Port | Role             |
|------------------|---------------------------------------|---------------|------------------|
| hopps_postgres   | postgres:15-alpine                    | 5432          | App database     |
| hopps_redis      | redis:7-alpine                        | 6379          | Session/cache    |
| hopps_backend    | hoppscotch/hoppscotch-backend:latest  | 8080          | API + auth       |
| hopps_frontend   | hoppscotch/hoppscotch-frontend:latest | 8080          | Main UI          |
| hopps_admin      | hoppscotch/hoppscotch-admin:latest    | 8080          | Admin dashboard  |
| hopps_nginx      | nginx:1.25-alpine                     | 80→8090       | Reverse proxy    |

## RHEL Pre-Flight (run once before first start)
```bash
# Open Hoppscotch port
sudo firewall-cmd --permanent --add-port=8090/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports | grep 8090

# SELinux container networking
sudo setsebool -P container_manage_cgroup on

# Docker masquerade (needed for container→host IP routing on RHEL)
sudo firewall-cmd --permanent --add-masquerade
sudo firewall-cmd --reload
```

## Nginx Routing
```
:8090/admin       → hoppscotch-admin:8080
:8090/api/graphql → hoppscotch-backend:8080 (WebSocket)
:8090/api         → hoppscotch-backend:8080
:8090/            → hoppscotch-frontend:8080
```

## Full .env Reference
```ini
DATABASE_URL=postgresql://hoppscotch:REDACTED_DB_PASS@postgres-hopps:5432/hoppscotch
REDIS_URL=redis://:REDACTED_REDIS_PASS@redis:6379
JWT_SECRET=REDACTED_JWT_SECRET
REFRESH_TOKEN_SECRET=REDACTED_REFRESH_SECRET
SESSION_SECRET=REDACTED_SESSION_SECRET
VITE_BASE_URL=http://api.paysyslabs.com:8090
VITE_SHORTCODE_BASE_URL=http://api.paysyslabs.com:8090
VITE_ADMIN_URL=http://api.paysyslabs.com:8090/admin
VITE_BACKEND_GQL_URL=http://api.paysyslabs.com:8090/api/graphql
VITE_BACKEND_WS_URL=ws://api.paysyslabs.com:8090/api/graphql
VITE_BACKEND_API_URL=http://api.paysyslabs.com:8090/api
WHITELISTED_ORIGINS=http://api.paysyslabs.com:8090,http://REDACTED_SERVER_IP:8090,http://localhost:8090
ALLOW_SECURE_COOKIES=false
FIRST_ADMIN_EMAIL=admin@paysyslabs.com
MAILER_SMTP_ENABLE=false
MAILER_SMTP_URL=
MAILER_ADDRESS_FROM="Hoppscotch <noreply@paysyslabs.com>"
VITE_ALLOWED_AUTH_PROVIDERS=email,oidc
OIDC_PROVIDER_NAME=Keycloak
OIDC_ISSUER=http://api.paysyslabs.com:8070/realms/paysyslabs
OIDC_AUTH_URL=http://api.paysyslabs.com:8070/realms/paysyslabs/protocol/openid-connect/auth
OIDC_TOKEN_URL=http://api.paysyslabs.com:8070/realms/paysyslabs/protocol/openid-connect/token
OIDC_USERINFO_URL=http://api.paysyslabs.com:8070/realms/paysyslabs/protocol/openid-connect/userinfo
OIDC_CLIENT_ID=hoppscotch
OIDC_CLIENT_SECRET=REDACTED_OIDC_SECRET
OIDC_CALLBACK_URL=http://api.paysyslabs.com:8090/api/auth/oidc/callback
OIDC_SCOPE=openid email profile
```

## Startup Order (CRITICAL)
```
1. postgres-hopps + redis      → start together
2. Wait for healthy             → healthcheck loop
3. migrate.sh                  → create schema
4. Verify tables                → sanity check
5. hoppscotch-backend          → start alone
6. Wait for backend healthy     → 120s timeout
7. frontend + admin + nginx     → start together
```

## Key Commands
```bash
# Full startup
./start.sh

# Migrations only
./migrate.sh

# Get magic login link
./get-magic-link.sh

# Watch logs
docker compose logs -f
docker compose logs -f hoppscotch-backend

# Health checks
curl http://REDACTED_SERVER_IP:8090/api/ping
docker ps --format "table {{.Names}}\t{{.Status}}"

# Reset (keep data)
docker compose down && ./start.sh

# Full reset (delete data)
docker compose down -v && ./start.sh
```

## Known Issues — Never Repeat These
| Issue | Cause | Fix |
|---|---|---|
| Backend crashes: `split` TypeError | WHITELISTED_ORIGINS missing | Add env var |
| Backend crashes: InfraConfig missing | Migrations not run | run migrate.sh first |
| Backend port wrong | People use 3170 | Use 8080 internally |
| Cookies broken | ALLOW_SECURE_COOKIES=true | Set to false |
| No Keycloak button | Wrong provider key | Use "oidc" not "keycloak" |
| Port unreachable | firewalld blocking | open port with firewall-cmd |
| Containers isolated | SELinux + masquerade | setsebool + add-masquerade |
| DB URL parse error | Special char in password | Alphanumeric only |

## RHEL-Specific Troubleshooting
| Problem | Fix |
|---|---|
| Port 8090 unreachable from browser | `firewall-cmd --permanent --add-port=8090/tcp && firewall-cmd --reload` |
| Backend can't reach Keycloak (REDACTED_SERVER_IP:8070) | `firewall-cmd --add-masquerade --permanent && firewall-cmd --reload` |
| SELinux blocking volume mounts | `chcon -Rt svirt_sandbox_file_t ./nginx` |
| `ausearch` shows docker AVC denials | `setsebool -P container_manage_cgroup on` |
| WebSocket drops | Verify nginx upgrade headers in hoppscotch.conf |
