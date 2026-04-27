# PaysysLabs Internal Developer Platform

Self-hosted API testing and developer tooling platform for PaysysLabs / Axian Acquiring.
Built on [Hoppscotch](https://hoppscotch.io/) with a custom authentication bridge,
CORS proxy, and PaysysLabs-specific request signing layer.

Deployed on bare-metal RHEL 8.10 via Docker Compose. No cloud. No Kubernetes. No TLS on the server.

---

## Table of Contents

1. [What This Is](#what-this-is)
2. [Architecture](#architecture)
3. [Project Structure](#project-structure)
4. [Services Reference](#services-reference)
5. [Custom Components](#custom-components)
   - [smtp-bridge](#smtp-bridge)
   - [hopps-proxy](#hopps-proxy)
6. [Known Issues Fixed in This Deployment](#known-issues-fixed-in-this-deployment)
7. [Server Requirements](#server-requirements)
8. [Pre-Flight Checklist](#pre-flight-checklist)
9. [Configuration Reference](#configuration-reference)
10. [First-Time Deployment](#first-time-deployment)
11. [Day-to-Day Operations](#day-to-day-operations)
12. [Authentication Flows](#authentication-flows)
    - [Email Magic Link](#email-magic-link)
    - [GitHub OAuth](#github-oauth)
    - [Team Invitation and Join-Team Flow](#team-invitation-and-join-team-flow)
13. [Network Modes](#network-modes)
14. [URL Reference](#url-reference)
15. [Troubleshooting](#troubleshooting)
16. [Hard Rules — Never Violate](#hard-rules--never-violate)

---

## What This Is

This platform gives the PaysysLabs engineering team:

- A self-hosted Hoppscotch instance for API design, testing, and team collaboration
- Magic-link email authentication routed through the internal PaysysLabs email API
- GitHub OAuth with a custom email-selection implementation (handles accounts with no primary email)
- Team workspace invitations with automatic silent sign-in (no separate login step after clicking an invite link)
- A server-side CORS proxy so developers can test endpoints that block browser-origin requests
- A `/forward` endpoint that transforms and signs requests for the PaysysLabs Spring backend, removing the need to write pre-request scripts in Hoppscotch
- A static ngrok tunnel for external / off-VPN access without changing the GitHub OAuth callback URL

---

## Architecture

```
 ┌──────────────────────────────────────────────────────────────┐
 │                      Developer Browser                        │
 └───────────────────────────┬──────────────────────────────────┘
                              │  HTTP  port 8090
                              │
 ┌────────────────────────────▼─────────────────────────────────┐
 │               hopps_nginx  (nginx:1.25-alpine)                │
 │               host:8090  ──►  container:80                    │
 │                                                               │
 │  Route                       Upstream                         │
 │  ──────────────────────────────────────────────────────────   │
 │  GET  /sw.js                 hoppscotch-frontend:80           │
 │                              (sub_filter patches SW denylist) │
 │  GET  /api/auth/github       smtp-bridge:8026/github-start    │
 │  GET  /api/auth/github/cb    smtp-bridge:8026/github-callback │
 │  ANY  /magic-login           smtp-bridge:8026/magic-login     │
 │  ANY  /invite                smtp-bridge:8026/invite          │
 │  ANY  /accept-invite         smtp-bridge:8026/accept-invite   │
 │  POST /forward               hopps-proxy:9159/forward         │
 │  POST /proxy/                hopps-proxy:9159/ (CORS proxy)   │
 │  ANY  /api/graphql           hoppscotch-backend:8080  (WS)    │
 │  ANY  /api/                  hoppscotch-backend:8080  (REST)  │
 │  ANY  /admin                 hoppscotch-admin:80              │
 │  ANY  /                      hoppscotch-frontend:80           │
 └──────┬─────────────┬─────────────┬──────────────┬────────────┘
        │             │             │              │
 ┌──────▼──────┐ ┌────▼────┐ ┌─────▼──────┐ ┌────▼──────────┐
 │  hopps_     │ │ hopps_  │ │  hopps_    │ │  hopps_       │
 │  backend    │ │ smtp_   │ │  proxy     │ │  frontend /   │
 │  :8080      │ │ bridge  │ │  :9159     │ │  admin        │
 │             │ │ :1025   │ │            │ │  :80          │
 │  REST API   │ │ :8026   │ │  /forward  │ └───────────────┘
 │  GraphQL    │ │         │ │  /proxy/   │
 │  Auth       │ │  SMTP   │ └─────┬──────┘
 └──────┬──────┘ │  relay  │       │
        │        │  + auth │       │  forwards to
        │        │  bridge │       ▼
        │        └────┬────┘  Spring Backend
        │             │       (10.0.150.x)
        ▼             ▼
 ┌─────────────────────────────────────────────────────────────┐
 │                        hopps-net                             │
 │            Docker bridge network  (isolated)                 │
 │                                                              │
 │   ┌─────────────────┐       ┌─────────────────┐            │
 │   │  hopps_postgres  │       │   hopps_redis    │            │
 │   │  postgres:15     │       │   redis:7        │            │
 │   │  port 5432       │       │   port 6379      │            │
 │   └─────────────────┘       └─────────────────┘            │
 └─────────────────────────────────────────────────────────────┘
        │
        │  optional (tunnel mode only)
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │   hopps_ngrok  (ngrok/ngrok:latest)                          │
 │   Static domain — never changes — GitHub OAuth set once      │
 │   https://dander-pork-headgear.ngrok-free.dev                │
 └─────────────────────────────────────────────────────────────┘

 External dependencies (outbound only)
 ──────────────────────────────────────
   PaysysLabs Email API     http://10.0.150.16:7034/api/EmailService
   GitHub OAuth             https://github.com/login/oauth/authorize
```

---

## Project Structure

```
paysyslabs-platform/
│
├── hoppscotch/
│   ├── .env                       All environment variables (never commit secrets)
│   ├── docker-compose.yaml        Full stack definition
│   ├── start.sh                   Ordered startup script — always use this
│   ├── migrate.sh                 Prisma database migration runner
│   ├── get-magic-link.sh          Retrieve a valid magic login URL from the database
│   ├── tunnel-restart.sh          Switch between local and ngrok tunnel mode
│   └── nginx/
│       ├── conf.d/
│       │   └── hoppscotch.conf    Nginx reverse proxy — routes, cookie rewrites, SW patch
│       └── magic.html             Static fallback page
│
├── smtp-bridge/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js                  SMTP listener + HTTP auth handler (Node.js)
│
└── hopps-proxy/
    ├── Dockerfile
    └── server.js                  CORS proxy + Spring request transformer (Node.js)
```

---

## Services Reference

| Container | Image | Memory | Internal Port | Role |
|---|---|---|---|---|
| hopps_postgres | postgres:15-alpine | 512 MB | 5432 | Application database (Prisma) |
| hopps_redis | redis:7-alpine | 256 MB | 6379 | Session cache |
| hopps_backend | hoppscotch/hoppscotch-backend:latest | 1 GB | 8080 | REST API + GraphQL + Auth |
| hopps_frontend | hoppscotch/hoppscotch-frontend:latest | 256 MB | 80 | Main SPA |
| hopps_admin | hoppscotch/hoppscotch-admin:latest | 256 MB | 80 | Admin dashboard |
| hopps_nginx | nginx:1.25-alpine | 128 MB | 80 (host: **8090**) | Reverse proxy, cookie rewriting, SW patch |
| hopps_smtp_bridge | hopps_smtp_bridge (local build) | 64 MB | 1025 (SMTP), 8026 (HTTP) | Email relay + auth bridge |
| hopps_proxy | hopps_proxy (local build) | 64 MB | 9159 | CORS proxy + signing proxy |
| hopps_ngrok | ngrok/ngrok:latest | 64 MB | — | Optional public tunnel |

### Startup Order

The startup order is strictly enforced by `start.sh`. This order is not optional.

```
Step 1   postgres-hopps + redis                 start in parallel
Step 2   wait until both report healthy
Step 3   migrate.sh                             run Prisma migrations
Step 4   verify table count >= 5               schema sanity check
Step 5   hoppscotch-backend                    start alone
Step 6   wait until backend reports healthy    up to 120 seconds
Step 7   hoppscotch-frontend + hoppscotch-admin + nginx + smtp-bridge + hopps-proxy
```

Starting the backend before migrations causes an immediate crash (`InfraConfig` table missing).
Starting nginx before the backend is healthy causes 502 errors on first page load.

---

## Custom Components

### smtp-bridge

**Location:** `smtp-bridge/`  
**Image:** built locally from `smtp-bridge/Dockerfile`  
**Ports:** 1025 (SMTP inbound from backend), 8026 (HTTP handler for nginx)

The smtp-bridge is a Node.js process that serves two distinct roles.

#### Role 1 — Email Relay

Hoppscotch sends all emails (magic links, invitations) to `smtp://smtp-bridge:1025`.
The bridge:

1. Parses the raw SMTP message using `mailparser`
2. Detects the email type by scanning for `/enter?token=` (magic link) or `/join-team?id=` (invitation)
3. Rewrites the click URL to point to the bridge's own HTTP endpoints (`/magic-login` or `/invite`)
4. Builds a branded HTML email (PaysysLabs styling)
5. Encrypts each field individually using 3DES-CBC and calls the PaysysLabs internal email API at `http://10.0.150.16:7034/api/EmailService`

Admin users receive a dual-link email: one button opens the admin panel, one opens the main app.
Both links carry the same token — the first click wins (single-use).

#### Role 2 — HTTP Auth Handler

Because the Hoppscotch backend sets cookies with paths and domains that do not survive the nginx proxy,
authentication cannot complete in the browser directly. The bridge runs an HTTP server on port 8026
that handles all auth-related redirects server-side.

| Endpoint | Nginx Route | Description |
|---|---|---|
| `GET /github-start` | `/api/auth/github` | Initiates GitHub OAuth, generates CSRF state |
| `GET /github-callback` | `/api/auth/github/callback` | Completes GitHub OAuth, sets cookies, redirects |
| `GET /magic-login` | `/magic-login` | Verifies magic link token, rewrites cookies, redirects |
| `GET /invite` | `/invite` | Accept-invite auth handler (see join-team flow below) |
| `GET /accept-invite` | `/accept-invite` | Legacy alias for `/invite` |

**Cookie rewriting** (applied to every `Set-Cookie` header returned by the backend):
- Removes the `Secure` flag (the server runs HTTP)
- Rewrites `SameSite=None` and `SameSite=Strict` to `SameSite=Lax`
- Rewrites `Path=/v1/auth/refresh` to `Path=/api/auth/refresh`
- Rewrites `Path=/v1/` to `Path=/`
- Removes `Domain=hoppscotch-backend` (internal Docker hostname, meaningless to the browser)

### hopps-proxy

**Location:** `hopps-proxy/`  
**Image:** built locally from `hopps-proxy/Dockerfile`  
**Port:** 9159

The proxy handles two routes:

#### `POST /forward` — Spring Request Signing Proxy

Removes the need to write pre-request scripts in Hoppscotch for every Spring backend call.

**Request format:**

```json
{
  "target_url": "http://10.0.150.x:PORT/api/service-name",
  "meta_data": {
    "trans_type": "PURCHASE",
    "method": "POST"
  },
  "body": {
    "amount": "100",
    "currency": "PKR"
  }
}
```

**What the proxy does:**

1. Extracts `trans_type` and all `body` values into an ordered array
2. URL-encodes each value
3. Appends the signing salt and computes a SHA256 signature
4. For POST: sends a CSV-encoded body to `{target_url}/{signature}`
5. For GET: builds `{target_url}/{encoded_params}/{signature}`

The SHA256 implementation is self-contained (zero external dependencies).

#### `POST /proxy/` — CORS Bypass Proxy

Implements the Hoppscotch proxy protocol. When Hoppscotch proxy mode is enabled in settings,
the browser sends a POST describing the actual request. The proxy fetches the target server-side
and returns the response — bypassing browser CORS restrictions. Supports all HTTP methods,
all content types, and binary responses.

---

## Known Issues Fixed in This Deployment

These are real bugs we encountered and fixed. They are documented here so the same problems
are not misdiagnosed in the future.

---

### Fix 1 — Magic-Login 404 Race Condition

**Symptom:** Clicking the magic link in email returned 404. The URL pointed to `/magic-login`
but the Hoppscotch frontend's service worker intercepted the navigation and served `index.html` instead.

**Root cause (1):** The SPA registers a service worker that intercepts ALL browser navigation
and returns the cached `index.html`. Paths like `/magic-login`, `/invite`, `/accept-invite`,
and `/join-team` must bypass the service worker and reach the server.

**Fix:** nginx intercepts the `/sw.js` request and uses `sub_filter` to inject our server-side
paths into the service worker's NavigationRoute denylist before the browser receives it.
A forced `skipWaiting` and `clients.claim()` are also injected so the patched SW activates
immediately without waiting for a page reload.

```nginx
location = /sw.js {
    proxy_pass http://hoppscotch-frontend:80;
    proxy_set_header Accept-Encoding "";
    sub_filter '/backend/]' '/backend/,/invite/,/magic-login/,/accept-invite/,/join-team/]';
    sub_filter 'self.addEventListener("message"'
               'self.addEventListener("install",function(){self.skipWaiting()});
                self.addEventListener("activate",function(e){e.waitUntil(self.clients.claim())});
                self.addEventListener("message"';
}
```

**Root cause (2):** A race condition between the backend writing the `VerificationToken` row
and the smtp-bridge trying to read it. The bridge reads `deviceIdentifier` immediately after
the email arrives, but the database write may not be committed yet.

**Fix:** `getExistingDeviceHashWithRetry` — retries the DB lookup 3 times with a 300 ms delay
between attempts before falling back.

---

### Fix 2 — Accept-Invite 404 (join-team redirect loop)

**Symptom:** Clicking a team invitation link redirected to a 404 page. The invite email
contained a `/join-team?id=...` URL. After the service worker fix the URL reached the server,
but the bridge was redirecting to `/magic-login` as an intermediate step. The service worker
then intercepted `/magic-login` before the SW patch was in place, and the flow broke.

**Root cause:** The bridge was sending the user to `/magic-login?token=...` rather than
completing the verification server-side and setting cookies directly.

**Fix:** The `/invite` handler now:
1. Looks up `inviteeEmail` from the `TeamInvitation` table
2. Calls the backend `/v1/auth/signin` server-side
3. Immediately calls `/v1/auth/verify` server-side (no browser redirect in between)
4. Sets the rewritten auth cookies on the HTTP response
5. Issues a single `302` redirect to `/join-team?id=...` with cookies already set

The browser lands directly on the join-team page, already authenticated.
If server-side verify fails (token expired, network error), the handler falls back to
the `/magic-login` redirect as a safety net.

---

### Fix 3 — Session Dropping After Every Refresh (cookie path mismatch)

**Symptom:** Users were logged out on every page refresh or navigation. The backend health
check passed and tokens were being issued, but the session never persisted.

**Root cause:** The backend sets the `refresh_token` cookie with `Path=/v1/auth/refresh`.
The browser only sends that cookie when the request URL matches `Path`. The nginx proxy
rewrites `/api/auth/refresh` to `/v1/auth/refresh` internally, but the browser only sees
the `/api/` path — so the cookie was never sent on refresh calls, causing a 403 which logs the user out.

**Fix:** nginx rewrites cookie paths before the browser stores them:

```nginx
proxy_cookie_path /v1/auth/refresh /api/auth/refresh;
proxy_cookie_path /v1/             /;
proxy_cookie_domain hoppscotch-backend $host;
```

---

### Fix 4 — GitHub OAuth Failing for Accounts with No Primary Email

**Symptom:** GitHub login returned an error for some users. The backend logs showed
`Cannot read properties of undefined` when trying to read `profile.emails[0]`.

**Root cause:** The bundled `passport-github2` library reads only `profile.emails`.
GitHub only returns a primary email in the OAuth profile if the account has one explicitly set.
Accounts using GitHub's no-reply address, or accounts where no email is set to public,
return an empty `emails` array.

**Fix:** The smtp-bridge implements the full GitHub OAuth flow itself, bypassing passport-github2.
After obtaining the access token it calls the GitHub `/user/emails` API endpoint which returns all
email addresses. It then picks the best one in priority order:

```
primary + verified  →  primary only  →  any verified  →  noreply alias  →  first in list
```

---

## Server Requirements

| Item | Value |
|---|---|
| OS | Red Hat Enterprise Linux 8.10 (Ootpa) |
| Hostname | axian-acquiring-project-2 |
| Primary IP | REDACTED_SERVER_IP |
| Internal domain | api.paysyslabs.com (hosts file only, not real DNS) |
| Docker | Docker CE via Docker's official dnf repo |
| Docker Compose | v2 (compose plugin — `docker compose`, not `docker-compose`) |
| User | REDACTED_USERNAME — sudo access, member of `docker` group |
| Hoppscotch port | 8090 |

---

## Pre-Flight Checklist

Run these once on the server before the first deployment. They are idempotent — safe to re-run.

```bash
# Step 1 — Open Hoppscotch port in firewalld
sudo firewall-cmd --permanent --add-port=8090/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports | grep 8090

# Step 2 — Enable masquerade (required for container → host IP routing)
# Without this, containers cannot reach REDACTED_SERVER_IP or other host IPs
sudo firewall-cmd --permanent --add-masquerade
sudo firewall-cmd --reload

# Step 3 — Allow container cgroup management (prevents SELinux denials)
sudo setsebool -P container_manage_cgroup on

# Step 4 — Verify Docker is running
sudo systemctl status docker

# Step 5 — Verify Docker Compose v2
docker compose version
# Expected: Docker Compose version v2.x.x

# Step 6 — Confirm user is in docker group
groups | grep docker
# If not present: sudo usermod -aG docker REDACTED_USERNAME && newgrp docker
```

### Developer Machine Setup

Every developer that needs to access the platform must add this line to their `/etc/hosts`:

```
REDACTED_SERVER_IP  api.paysyslabs.com
```

---

## Configuration Reference

All configuration lives in `hoppscotch/.env`. Do not put real values in this README or in version control.

### Variables That Change Per Environment

These two variables are the only ones that change between local mode and tunnel mode.
`tunnel-restart.sh` and `tunnel-restart.sh --local` update them automatically.

| Variable | Local Mode | Tunnel Mode |
|---|---|---|
| `PUBLIC_URL` | `http://api.paysyslabs.com:8090` | `https://dander-pork-headgear.ngrok-free.dev` |
| `PUBLIC_WS_URL` | `ws://api.paysyslabs.com:8090` | `wss://dander-pork-headgear.ngrok-free.dev` |
| `ALLOW_SECURE_COOKIES` | `false` | `true` |

### Fixed Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string — alphanumeric password only (Prisma breaks on `@` in URL) |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Must be 32+ alphanumeric characters |
| `REFRESH_TOKEN_SECRET` | Must be 32+ alphanumeric characters |
| `SESSION_SECRET` | Must be 32+ alphanumeric characters |
| `DATA_ENCRYPTION_KEY` | Must be 32+ alphanumeric characters |
| `FIRST_ADMIN_EMAIL` | The email address that becomes site admin on first login |
| `MAILER_SMTP_ENABLE` | Must be `true` — email auth depends on this |
| `MAILER_SMTP_URL` | `smtp://smtp-bridge:1025` — points to the bridge container |
| `MAILER_ADDRESS_FROM` | The sender address shown in emails |
| `VITE_ALLOWED_AUTH_PROVIDERS` | `email,github` — no spaces, comma-separated |
| `GITHUB_CLIENT_ID` | GitHub OAuth app Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app Client Secret |
| `NGROK_AUTHTOKEN` | ngrok account auth token — required for the ngrok container |

All values are stored in `hoppscotch/.env`. Refer to that file directly for actual values.

---

## First-Time Deployment

Follow these steps in order. Do not skip or reorder them.

### Step 1 — Complete the pre-flight checklist

See [Pre-Flight Checklist](#pre-flight-checklist) above.

### Step 2 — Clone the repository

```bash
git clone <repo-url> paysyslabs-platform
cd paysyslabs-platform
```

### Step 3 — Verify the .env file

```bash
cat hoppscotch/.env
```

Confirm that `PUBLIC_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `NGROK_AUTHTOKEN` are set.
Confirm no password contains `@`, `#`, `$`, or `%`.

### Step 4 — Build the custom images

The smtp-bridge and hopps-proxy are built locally. They are not pulled from a registry.

```bash
cd hoppscotch
docker compose build smtp-bridge hopps-proxy
```

Verify the images exist:

```bash
docker images | grep hopps
# Expected:
# hopps_smtp_bridge    latest    ...
# hopps_proxy          latest    ...
```

### Step 5 — Make scripts executable

```bash
chmod +x hoppscotch/start.sh \
         hoppscotch/migrate.sh \
         hoppscotch/get-magic-link.sh \
         hoppscotch/tunnel-restart.sh
```

### Step 6 — Start the stack

```bash
cd hoppscotch
./start.sh
```

The script prints a progress line for each step. A successful run ends with the service URLs printed on screen.
If any step fails, the script exits with an error message and the name of the service to check.

### Step 7 — Request the first admin magic link

The admin account does not have a password. Authentication is always via magic link or GitHub.

```bash
# Trigger a magic link for the admin email
curl -s -X POST http://api.paysyslabs.com:8090/api/auth/signin \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@paysyslabs.com"}'

# Retrieve the link from the database
cd hoppscotch
./get-magic-link.sh
```

The script prints a URL. Open it in a browser. The first user to sign in with the admin email
is automatically granted admin privileges.

### Step 8 — Verify all containers are healthy

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

All containers should show `healthy` or `Up`. None should show `Restarting` or `Exited`.

### Step 9 — Open the admin panel

Navigate to `http://api.paysyslabs.com:8090/admin`.

From the admin panel you can:
- Confirm the admin account exists
- Invite users by email
- Create workspaces (teams)
- Review site-wide settings

---

## Day-to-Day Operations

### Start the stack

```bash
cd hoppscotch
./start.sh
```

### Stop the stack (data preserved)

```bash
cd hoppscotch
docker compose down
```

### Restart a single service

```bash
cd hoppscotch
docker compose restart hoppscotch-backend
```

### Watch live logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f hoppscotch-backend
docker compose logs -f hopps_smtp_bridge
docker compose logs -f hopps_proxy
docker compose logs -f hopps_nginx
```

### Check container health status

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

### Test API health

```bash
curl http://api.paysyslabs.com:8090/api/ping
```

Expected: `{"status":"ok"}`

### Get a magic login link manually

```bash
cd hoppscotch
./get-magic-link.sh
```

If no valid token exists, the script prints the `curl` command to request a new one.

### Rebuild custom images after code changes

```bash
cd hoppscotch
docker compose build smtp-bridge hopps-proxy
docker compose up -d --force-recreate smtp-bridge hopps-proxy
```

### Reset the stack (keep all data)

```bash
cd hoppscotch
docker compose down && ./start.sh
```

### Full reset — destroy all data

Only use this when you want to start completely from scratch.

```bash
cd hoppscotch
docker compose down -v
./start.sh
```

### Re-run migrations only

Use this when a new Hoppscotch image version adds schema changes.

```bash
cd hoppscotch
./migrate.sh
docker compose restart hoppscotch-backend
```

---

## Authentication Flows

### Email Magic Link

```
User enters email
       │
       ▼
Hoppscotch backend  ──SMTP──►  smtp-bridge:1025
       │                              │
       │ creates VerificationToken    │ parses email
       │ in DB                        │ extracts token
       │                              │ rewrites click URL to /magic-login
       │                              │ sends branded HTML to PaysysLabs email API
       │                              │
       │                       User inbox
       │                              │
       │                       User clicks link
       │                              │
       │                       GET /magic-login?token=...&d=...
       │                              │
       │                    nginx proxies to smtp-bridge:8026
       │                              │
       │                    bridge calls POST /v1/auth/verify
       ◄───────────────────────────────
       │ returns Set-Cookie headers
       │
       bridge rewrites cookies:
         - removes Secure flag
         - fixes Path=/v1/ → Path=/
         - fixes Path=/v1/auth/refresh → Path=/api/auth/refresh
         - removes Domain=hoppscotch-backend
       │
       302 redirect to app with corrected cookies set
       │
       ▼
User lands on Hoppscotch, authenticated
```

Admin users receive a dual-button email. Only the first button click works (single-use token).

### GitHub OAuth

```
User clicks "Continue with GitHub"
       │
       ▼
GET /api/auth/github  (nginx → smtp-bridge:8026/github-start)
       │
       bridge generates CSRF state token
       │
       302 → github.com/login/oauth/authorize
       │
       GitHub redirects back to /api/auth/github/callback
       │
       nginx → smtp-bridge:8026/github-callback
       │
       bridge validates CSRF state
       │
       bridge exchanges code → GitHub access token
       │
       bridge calls GitHub /user/emails  (picks best email)
       │
       bridge calls POST /v1/auth/signin with selected email
       │
       bridge suppresses the resulting magic-link email (60s window)
       │
       bridge calls POST /v1/auth/verify immediately
       │
       bridge rewrites cookies (same as magic-link flow)
       │
       If admin  →  serve portal selection page (admin or main app)
       If user   →  302 redirect to main app with cookies set
```

### Team Invitation and Join-Team Flow

This flow was specifically fixed to remove the broken intermediate magic-login redirect.

```
Admin invites user@example.com from admin panel
       │
       ▼
Backend sends SMTP to smtp-bridge:1025
       │
       bridge detects /join-team?id=... in email body
       │
       bridge looks up team name from TeamInvitation table
       │
       bridge rewrites URL to /invite?id=...
       │
       bridge sends branded invitation email to user@example.com
       │
       User clicks "Join {team}" button in email
       │
       GET /invite?id={inviteId}
       │
       nginx proxies to smtp-bridge:8026/invite
       │
       bridge queries TeamInvitation for inviteeEmail
       │
       bridge calls POST /v1/auth/signin with inviteeEmail
       │
       bridge suppresses the magic-link email (60s window)
       │
       bridge reads token from DB immediately (with retry)
       │
       bridge calls POST /v1/auth/verify server-side
       │
       If verify succeeds:
         bridge rewrites cookies
         302 redirect to /join-team?id={inviteId} with cookies set
         User lands on join-team page, already authenticated — no separate login step
       │
       If verify fails (fallback):
         302 redirect to /magic-login?token=...&redirect=/join-team?id=...
         User clicks magic link, then lands on join-team page
```

The service worker denylist patch (in `hoppscotch.conf`) ensures `/invite`, `/accept-invite`,
`/magic-login`, and `/join-team` are never intercepted by the SPA and always reach the server.

---

## Network Modes

### Local Mode — VPN / LAN access only

Accessed at `http://api.paysyslabs.com:8090`.

Requirements:
- Developer must be on the internal network or VPN
- Developer must have `REDACTED_SERVER_IP  api.paysyslabs.com` in `/etc/hosts`
- `ALLOW_SECURE_COOKIES=false`

Switch to local mode:

```bash
cd hoppscotch
./tunnel-restart.sh --local
```

What the script does:
- Updates `PUBLIC_URL`, `PUBLIC_WS_URL`, `ALLOW_SECURE_COOKIES` in `.env`
- Stops the ngrok container
- Force-recreates backend, smtp-bridge, frontend, admin with updated environment
- Reloads nginx config

### Tunnel Mode — HTTPS via ngrok static domain

Accessed at `https://dander-pork-headgear.ngrok-free.dev`.

Requirements:
- `NGROK_AUTHTOKEN` set in `.env`
- `ALLOW_SECURE_COOKIES=true` (HTTPS is available via tunnel)

Switch to tunnel mode:

```bash
cd hoppscotch
./tunnel-restart.sh
```

What the script does:
- Updates `PUBLIC_URL`, `PUBLIC_WS_URL`, `ALLOW_SECURE_COOKIES` in `.env`
- Force-recreates backend, smtp-bridge, frontend, admin with updated environment
- Starts the ngrok container
- Reloads nginx config

The script is idempotent. If already in tunnel mode, it only ensures the ngrok container is running.

**The static domain (`dander-pork-headgear.ngrok-free.dev`) never changes.** The GitHub OAuth
callback URL was configured once in the GitHub app settings and never needs updating.

---

## URL Reference

### Local Mode

| Purpose | URL |
|---|---|
| Main app | http://api.paysyslabs.com:8090 |
| Admin panel | http://api.paysyslabs.com:8090/admin |
| Backend REST API | http://api.paysyslabs.com:8090/api |
| Backend GraphQL | http://api.paysyslabs.com:8090/api/graphql |
| WebSocket | ws://api.paysyslabs.com:8090/api/graphql |
| API health | http://api.paysyslabs.com:8090/api/ping |
| CORS proxy | http://api.paysyslabs.com:8090/proxy/ |
| Spring signing proxy | http://api.paysyslabs.com:8090/forward |

### Tunnel Mode

| Purpose | URL |
|---|---|
| Main app | https://dander-pork-headgear.ngrok-free.dev |
| Admin panel | https://dander-pork-headgear.ngrok-free.dev/admin |
| GitHub OAuth callback | https://dander-pork-headgear.ngrok-free.dev/api/auth/github/callback |

---

## Troubleshooting

### Port 8090 unreachable from browser

```bash
sudo firewall-cmd --permanent --add-port=8090/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports | grep 8090
```

### Containers cannot reach the host IP (REDACTED_SERVER_IP) or other servers

```bash
sudo firewall-cmd --permanent --add-masquerade
sudo firewall-cmd --reload
```

### Backend crashes immediately at startup — "InfraConfig" or "split" error

Migrations have not been applied.

```bash
cd hoppscotch
./migrate.sh
docker compose restart hoppscotch-backend
```

### Backend crashes — DATABASE_URL parse error

A password contains a special character. All passwords must be alphanumeric only.
Check `hoppscotch/.env` and `postgres_password`, `redis_password` values.

### Magic link returns 404 or loads the Hoppscotch homepage instead

The service worker is intercepting the navigation. Verify the nginx `sub_filter` patch
on `/sw.js` is active:

```bash
curl -s http://api.paysyslabs.com:8090/sw.js | grep "magic-login"
# Should print a line containing /magic-login/ in the denylist
```

If nothing is returned, check that nginx loaded the current config:

```bash
docker exec hopps_nginx nginx -t
docker exec hopps_nginx nginx -s reload
```

### Magic link says "link expired" immediately on click

The `d` parameter (deviceIdentifier hash) is missing or the token was already used.
The retry logic (3 attempts, 300 ms apart) handles race conditions between email delivery
and the DB write. If it consistently fails, check smtp-bridge logs:

```bash
docker compose logs --tail=50 hopps_smtp_bridge
```

### User is logged out on every page refresh

`ALLOW_SECURE_COOKIES=true` while accessing over HTTP.
Set `ALLOW_SECURE_COOKIES=false` in `.env` for local mode, then restart:

```bash
docker compose up -d --force-recreate hoppscotch-backend
```

### Invite link redirects but user is not logged in after joining the team

Check that the `/invite` route is in the service worker denylist:

```bash
curl -s http://api.paysyslabs.com:8090/sw.js | grep "invite"
```

Check smtp-bridge logs for the verify step result:

```bash
docker compose logs --tail=50 hopps_smtp_bridge | grep "Accept invite"
```

### GitHub login fails — "no email" error

The GitHub account has no verified email. The user must add and verify at least one email
address in their GitHub account settings (`github.com → Settings → Emails`).

### GitHub OAuth callback state mismatch

The state token expires after 10 minutes. If the user takes more than 10 minutes to
complete the GitHub login page, they are redirected to `/?error=github_state`.
They should start the login flow again.

### SELinux blocking container volume mounts

```bash
chcon -Rt svirt_sandbox_file_t ./nginx
```

### WebSocket connections disconnect immediately

Verify that nginx is passing the `Upgrade` and `Connection` headers. Check `hoppscotch.conf`:

```
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection $connection_upgrade;
```

Also confirm the `map $http_upgrade $connection_upgrade` block is present at the top of the config.

### Check recent SELinux denials

```bash
sudo ausearch -m avc -ts recent | grep docker
```

### `/forward` returns 400

The body must include `target_url`, `meta_data`, and `body`. The `meta_data` object must include `trans_type`.

---

## Hard Rules — Never Violate

| Rule | Consequence if broken |
|---|---|
| No special characters in passwords | Prisma fails to parse DATABASE_URL on startup |
| No TLS on the server | ALLOW_SECURE_COOKIES must stay false for local mode |
| No shared Docker network between stacks | Cross-stack communication via host IP REDACTED_SERVER_IP only |
| Run migrations before starting backend | Backend crashes with InfraConfig missing |
| Backend internal port is 8080, not 3170 | All nginx proxy_pass rules break |
| Auth provider key is `email` and `github` | Login button does not appear |
| WHITELISTED_ORIGINS must be set | Backend crashes on startup with split TypeError |
| Use `dnf` not `apt` | Wrong package manager for RHEL 8.10 |
| Use `firewall-cmd` not `ufw` | Firewall rules are ignored on RHEL |
