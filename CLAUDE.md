# Project: PaysysLabs Platform
# Hoppscotch + Keycloak Self-Hosted Setup

## What This Project Is
Self-hosted internal developer API testing platform (Hoppscotch)
with Keycloak as the SSO/authentication provider.
Running on bare metal RHEL 8.10 server, HTTP only, no cloud.

## Project Structure
```
paysyslabs-platform/
├── CLAUDE.md                    ← You are here
├── keycloak/
│   ├── .env
│   ├── docker-compose.yml
│   └── setup-guide.md
└── hoppscotch/
    ├── .env
    ├── docker-compose.yml
    ├── migrate.sh
    ├── start.sh
    ├── get-magic-link.sh
    └── nginx/
        └── conf.d/
            └── hoppscotch.conf
```

## Server Details — VERIFIED FROM ACTUAL MACHINE
| Item              | Value                                                    |
|-------------------|----------------------------------------------------------|
| OS                | Red Hat Enterprise Linux 8.10 (Ootpa)                   |
| Kernel            | RHEL 8.10                                                |
| Hostname          | axian-acquiring-project-2                                |
| Primary IP        | REDACTED_SERVER_IP                                             |
| All IPs on host   | REDACTED_SERVER_IP, 172.18.0.1, 172.21.0.1, 172.17.0.1,      |
|                   | 10.244.0.0, 192.168.183.64, 172.22.0.1                  |
| Internal domain   | api.paysyslabs.com (hosts file only, not real DNS)       |
| Protocol          | HTTP only (no SSL anywhere)                               |
| Package manager   | dnf                                                      |
| Firewall          | firewalld                                                |
| SELinux           | Enabled (RHEL default)                                   |
| Docker Compose    | v2 (no "version:" key)                                   |
| Hoppscotch port   | 8090                                                     |
| Keycloak port     | 8080                                                     |
| User              | REDACTED_USERNAME (sudo access)                               |

## /etc/hosts Entry (every dev machine needs this)
```
REDACTED_SERVER_IP  api.paysyslabs.com
```

## Deployment Architecture
```
Developer Browser
      │
      ▼
api.paysyslabs.com:8090  (nginx → hoppscotch)
      │
      ├── /           → hoppscotch-frontend:8080
      ├── /admin      → hoppscotch-admin:8080
      ├── /api        → hoppscotch-backend:8080
      └── /api/graphql→ hoppscotch-backend:8080 (WebSocket)

api.paysyslabs.com:8080  (Keycloak — separate stack)
      └── /realms/paysyslabs/...  ← OIDC endpoints
```

## Networks
- Keycloak stack: `keycloak-net` (isolated)
- Hoppscotch stack: `hopps-net` (isolated)
- They communicate via HOST IP: REDACTED_SERVER_IP (NOT shared Docker network)
- Note: 172.17/18/21/22.x and 10.244.x networks already exist on this host
  These are pre-existing Docker/K8s bridge networks — do not conflict with them

## RHEL 8.10 — Pre-Flight Checklist
Run these ONCE before starting any stack:

```bash
# 1. Open required ports in firewalld
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --permanent --add-port=8090/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports

# 2. Verify SELinux won't block container networking
sudo setsebool -P container_manage_cgroup on

# 3. Verify Docker is running
sudo systemctl status docker

# 4. Verify Docker Compose v2
docker compose version

# 5. Verify your user is in docker group (to run without sudo)
groups | grep docker
# If not: sudo usermod -aG docker REDACTED_USERNAME && newgrp docker
```

## Credentials Master Reference
### Keycloak
| Item                | Value               |
|---------------------|---------------------|
| Admin user          | admin               |
| Admin password      | REDACTED_KC_ADMIN_PASS            |
| Realm               | paysyslabs          |
| Client ID           | hoppscotch          |
| Client secret       | REDACTED_OIDC_SECRET |
| DB user             | keycloak            |
| DB password         | REDACTED_KC_DB_PASS         |
| DB name             | keycloak            |

### Hoppscotch
| Item                | Value                             |
|---------------------|-----------------------------------|
| DB user             | hoppscotch                        |
| DB password         | REDACTED_DB_PASS                     |
| DB name             | hoppscotch                        |
| Redis password      | REDACTED_REDIS_PASS                          |
| JWT secret          | REDACTED_JWT_SECRET |
| Refresh secret      | REDACTED_REFRESH_SECRET  |
| Session secret      | REDACTED_SESSION_SECRET   |
| Admin email         | admin@paysyslabs.com              |

## URLs Reference
| Purpose                  | URL                                                                              |
|--------------------------|----------------------------------------------------------------------------------|
| Hoppscotch app           | http://api.paysyslabs.com:8090                                                   |
| Hoppscotch admin panel   | http://api.paysyslabs.com:8090/admin                                             |
| Hoppscotch API           | http://api.paysyslabs.com:8090/api                                               |
| Hoppscotch GraphQL       | http://api.paysyslabs.com:8090/api/graphql                                       |
| Hoppscotch WebSocket     | ws://api.paysyslabs.com:8090/api/graphql                                         |
| Keycloak console         | http://api.paysyslabs.com:8080                                                   |
| Keycloak OIDC discovery  | http://api.paysyslabs.com:8080/realms/paysyslabs/.well-known/openid-configuration|

## Critical Rules — NEVER Violate These
1. NO special characters in passwords — Prisma breaks on @ in DATABASE_URL
2. NO SSL/TLS anywhere — HTTP only on this server
3. NO shared Docker network between Keycloak and Hoppscotch stacks
4. NO Kubernetes — Docker Compose only
5. NO `apt` commands — this is RHEL 8.10, use `dnf`
6. Run migrations BEFORE starting hoppscotch-backend
7. ALLOW_SECURE_COOKIES must be false (HTTP)
8. WHITELISTED_ORIGINS must be set or backend crashes
9. Backend internal port is 8080 NOT 3170
10. Auth provider key is "oidc" NOT "keycloak" or "microsoft"
11. Always check firewalld when ports are unreachable
12. Always consider SELinux when containers can't communicate

## Resource Limits (always enforce)
| Service             | Memory Limit |
|---------------------|-------------|
| postgres (any)      | 512m        |
| redis               | 256m        |
| keycloak            | 1g          |
| hoppscotch-backend  | 1g          |
| hoppscotch-frontend | 256m        |
| hoppscotch-admin    | 256m        |
| nginx               | 128m        |

## Common Commands
```bash
# Start keycloak
cd keycloak && docker compose up -d

# Start hoppscotch
cd hoppscotch && ./start.sh

# Watch logs
docker compose logs -f

# Check all container health
docker ps --format "table {{.Names}}\t{{.Status}}"

# Run migrations only
cd hoppscotch && ./migrate.sh

# Get magic login link
cd hoppscotch && ./get-magic-link.sh

# Test API health
curl http://REDACTED_SERVER_IP:8090/api/ping

# Test Keycloak
curl -s http://api.paysyslabs.com:8080/realms/paysyslabs/.well-known/openid-configuration

# RHEL: Check if port is open in firewall
sudo firewall-cmd --list-ports

# RHEL: Open a port
sudo firewall-cmd --permanent --add-port=8090/tcp && sudo firewall-cmd --reload

# RHEL: Check SELinux is not blocking
sudo ausearch -m avc -ts recent | grep docker

# Restart one service
docker compose restart hoppscotch-backend

# Nuke and start fresh (data preserved)
docker compose down && ./start.sh

# Nuke everything including data (DESTRUCTIVE)
docker compose down -v
```

## RHEL-Specific Troubleshooting
| Problem | RHEL Cause | Fix |
|---|---|---|
| Port unreachable from outside | firewalld blocking | `firewall-cmd --permanent --add-port=8090/tcp && firewall-cmd --reload` |
| Containers can't reach each other | SELinux policy | `setsebool -P container_manage_cgroup on` |
| `docker compose` not found | Only old `docker-compose` installed | Install Docker CE properly via dnf repo |
| Permission denied on volumes | SELinux file context | `chcon -Rt svirt_sandbox_file_t /path/to/volume` |
| DNS resolution fails inside container | RHEL firewalld masquerade | `firewall-cmd --add-masquerade --permanent && firewall-cmd --reload` |
| Cannot pull images | DNS or proxy issue | Check `/etc/docker/daemon.json` for proxy config |
