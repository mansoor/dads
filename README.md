# DADS — Docker App Deployment Simplified

> **Yes, it's called DADS.** And like a good dad, it does all the heavy lifting without complaining, remembers exactly how everything was set up, and gets quietly upset if you don't follow the instructions. Unlike your actual dad, it won't ask why you're still using `docker run` manually in 2026.

A Bash-based toolkit for scaffolding, building, and operating multi-environment Docker application stacks — with a full-featured web UI for teams that prefer the browser. Run the wizard once to generate a self-contained workspace, then use a single `run.sh` entry point to build, deploy, promote, back up, and manage everything across dev, stage, and prod.

---

## Table of Contents

1. [Quick Install](#1-quick-install)
2. [Architecture Overview](#2-architecture-overview)
3. [Directory Structure](#3-directory-structure)
4. [Prerequisites](#4-prerequisites)
5. [CLI Quick Start](#5-cli-quick-start)
6. [The Wizard — init_workspace.sh](#6-the-wizard--init_workspacesh)
7. [Workspace Layout](#7-workspace-layout)
8. [Command Reference](#8-command-reference)
9. [Environment Configuration](#9-environment-configuration)
10. [Version Management](#10-version-management)
11. [Deployment Strategies](#11-deployment-strategies)
12. [Build vs Promote](#12-build-vs-promote)
13. [Backup & Restore](#13-backup--restore)
14. [Git Sync](#14-git-sync)
15. [Supported Stacks](#15-supported-stacks)
16. [Pre-built Stack Templates](#16-pre-built-stack-templates)
17. [Image Stacks — Manual Configuration](#17-image-stacks--manual-configuration)
18. [Image Update Detection](#18-image-update-detection)
19. [Healthchecks](#19-healthchecks)
20. [Traefik vs Direct Port Routing](#20-traefik-vs-direct-port-routing)
21. [DADS UI — Web Interface](#21-dads--web-interface)
22. [Maintenance Guide](#22-maintenance-guide)
23. [Troubleshooting](#23-troubleshooting)

---

## 1. Quick Install

One-line installer — detects your OS, installs all dependencies, clones the repo, generates a JWT secret, and starts DADS:

```bash
curl -sSL https://raw.githubusercontent.com/mansoor/dads/main/install.sh | bash
```

**With overrides:**

```bash
curl -sSL https://raw.githubusercontent.com/mansoor/dads/main/install.sh \
  | DADS_DIR=/opt/dads DADS_PORT=9090 ACME_EMAIL=admin@example.com bash
```

| Variable | Default | Description |
|----------|---------|-------------|
| `DADS_DIR` | `~/dads` | Where to clone the repo |
| `DADS_PORT` | `8080` | UI host port |
| `DADS_BRANCH` | `main` | Git branch to install |
| `ACME_EMAIL` | — | Let's Encrypt contact email (required for SSL) |
| `SKIP_DOCKER` | `0` | Set to `1` to skip Docker installation check |

**Supported OS:** Ubuntu/Debian, RHEL/CentOS/AlmaLinux/Fedora, Arch, Alpine, macOS (Docker Desktop required).

After install, open `http://localhost:8080` — first visit prompts you to create an admin account.

**Manual install:**

```bash
git clone https://github.com/mansoor/dads.git
cd dads/dads
cp .env.example .env
# Edit .env: set JWT_SECRET (openssl rand -hex 32) and ACME_EMAIL
docker network create traefik_net 2>/dev/null || true
docker compose up --build -d
```

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  DADS Toolkit                                                    │
│                                                                  │
│   init_workspace.sh      ← interactive workspace wizard         │
│   scripts/               ← engine scripts (never edited)        │
│   templates/             ← Dockerfiles, Nginx, stack templates  │
│   install.sh             ← one-line OS-aware installer          │
└───────────────────────────────┬──────────────────────────────────┘
                                │  generates ↓
┌───────────────────────────────▼──────────────────────────────────┐
│  workspaces/<project>/        (one per application)              │
│                                                                  │
│   config.json      ← single source of truth for all settings    │
│   run.sh           ← command dispatcher (your daily driver)      │
│   envs/                                                          │
│     dev/  stage/  prod/   ← scaffolded environments             │
│       .env                 ← secrets (never commit)             │
│       docker-compose.yml   ← generated from config.json        │
│       volumes/             ← bind-mounted data                  │
└──────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────┐
│  dads/          ← optional web interface (~15 MB container)   │
│                                                                  │
│   Go backend  →  React SPA (embedded via embed.FS)              │
│   REST + WebSocket API                                           │
│   Calls the same run.sh commands as the CLI                      │
└──────────────────────────────────────────────────────────────────┘
```

**Key design principles:**

- **Config-driven.** `config.json` is the single source of truth. Edit it and run `./run.sh refresh <env>` — compose files are regenerated and redeployed automatically.
- **Toolkit = pure engine.** Nothing in `scripts/` or `templates/` is project-specific. One toolkit installation serves all projects on the host.
- **Workspace = self-contained.** Everything needed to operate a project lives in `workspaces/<project>/`. The workspace can be archived, moved, or restored independently.
- **No host toolchain required.** All build steps happen inside Docker. The host needs only `bash`, `docker`, and `jq`.
- **Bind mounts by default.** All volume data lives in `envs/<env>/volumes/` on the host — readable, backupable, and portable without Docker named volume gymnastics.

---

## 3. Directory Structure

### Toolkit root

```
dads/
├── install.sh                          # One-line OS-aware installer
├── init_workspace.sh                   # Interactive workspace wizard (CLI)
├── scripts/
│   ├── lib.sh                          # Shared helpers, logging, path resolution
│   ├── bootstrap.sh                    # Scaffold one environment from templates
│   ├── compose-gen.sh                  # Generate docker-compose.yml from config.json
│   ├── env-gen.sh                      # Generate .env and .env.example
│   ├── deploy.sh                       # Docker Compose / Swarm lifecycle
│   ├── build.sh                        # Build and push Docker images
│   ├── promote.sh                      # Retag + redeploy between environments
│   ├── backup.sh                       # Database + volume backups
│   ├── restore.sh                      # Restore from a snapshot
│   ├── sync.sh                         # Git pull + build + deploy
│   ├── version.sh                      # Semver management
│   ├── image-check.sh                  # Upstream image update detector
│   ├── run.sh.template                 # Canonical run.sh (synced to all workspaces)
│   └── defaults/config.json            # Default versions
├── templates/
│   ├── dockerfiles/                    # laravel/ nodejs/ nextjs/ react/
│   ├── nginx/                          # laravel.conf nodejs.conf nextjs.conf react.conf
│   └── stacks/                         # Pre-built image stack templates (12 included)
│       ├── ghost.json
│       ├── gitea.json
│       ├── grafana.json
│       ├── immich.json
│       ├── minio.json
│       ├── n8n.json
│       ├── nextcloud.json
│       ├── nginx-proxy-manager.json
│       ├── plausible.json
│       ├── uptime-kuma.json
│       ├── vaultwarden.json
│       └── wordpress.json
└── dads/                            # Web UI — see Section 21
    ├── Dockerfile                      # 3-stage: node → golang → alpine
    ├── docker-compose.yml              # dads + Traefik v3.1
    ├── .env.example
    ├── backend/                        # Go HTTP server (CGO_ENABLED=0)
    │   ├── go.mod
    │   ├── cmd/server/main.go
    │   ├── api/
    │   │   ├── handlers.go
    │   │   ├── backup_handlers.go      # Workspace archive backup/restore
    │   │   ├── settings_handlers.go
    │   │   └── housekeeping_handlers.go
    │   └── internal/
    │       ├── auth/                   # JWT (access + refresh), bcrypt, rate limiter
    │       ├── db/                     # SQLite (modernc, CGO-free), auto-migration
    │       ├── shell/                  # Command allowlist + process bridge
    │       ├── workspace/              # Discovery, config R/W, env vars, env_access
    │       ├── imagecheck/             # Docker Hub update checker + in-memory cache
    │       ├── archiver/               # Workspace tar.gz backup/restore
    │       ├── stats/                  # Docker info + host metrics
    │       └── config/
    └── frontend/src/
        ├── pages/
        │   ├── DashboardPage.jsx       # System overview with skeleton loader
        │   ├── WorkspacePage.jsx       # Env cards, log viewer, compose viewer
        │   ├── NewWorkspacePage.jsx    # 7-step creation wizard
        │   ├── EditWorkspacePage.jsx   # Full workspace editor
        │   ├── SettingsPage.jsx
        │   ├── HousekeepingPage.jsx
        │   └── ToolsPage.jsx           # Compose→Template, Workspace Backup/Restore
        ├── components/
        │   ├── Layout.jsx
        │   ├── ComposeEditor.jsx       # Read-only compose viewer with line numbers + copy
        │   ├── SlideOutPanel.jsx
        │   └── TerminalModal.jsx
        └── lib/api.js
```

### Generated workspace

```
workspaces/<project>/
├── config.json                         # Edit this, then ./run.sh refresh <env>
├── run.sh                              # Your daily driver
└── envs/
    ├── dev/
    │   ├── .env                        # Live secrets — NEVER commit
    │   ├── .env.example                # Redacted template — safe to commit
    │   ├── docker-compose.yml          # Generated by compose-gen.sh
    │   └── volumes/                    # Bind-mounted data directories
    │       ├── app_data/
    │       └── db_data/
    ├── stage/
    └── prod/
```

---

## 4. Prerequisites

| Tool | Required for | Install |
|------|-------------|---------|
| `bash` ≥ 3.2 | All scripts | Ships with macOS |
| `docker` + Compose v2 plugin | Build / deploy | [docker.com](https://docs.docker.com/get-docker/) or `./install.sh` |
| `jq` | Config parsing | `brew install jq` / `apt install jq` |
| `openssl` | Secret generation | Ships with macOS / most Linux |
| `git` | Git sync, install script | Ships with most systems |
| `curl` | Install script, healthchecks | Ships with most systems |

> **macOS:** The toolkit is fully compatible with Bash 3.2. It deliberately avoids Bash 4+ features (`declare -A`, `${var^^}`, `${var[-1]}`).

---

## 5. CLI Quick Start

```bash
# 1. Clone or install
git clone https://github.com/mansoor/dads.git && cd dads

# 2. Run the workspace wizard
./init_workspace.sh

# 3. Fill in secrets
vi workspaces/<project>/envs/dev/.env

# 4. Place your source code
cp -r /path/to/my-app/* workspaces/<project>/envs/dev/backend/

# 5. Build and start
cd workspaces/<project>
./run.sh build dev
./run.sh start dev
```

---

## 6. The Wizard — init_workspace.sh

Run `./init_workspace.sh` from the toolkit root. It walks through 5 steps:

### Step 1 — Project
- **Project name** — lowercase, hyphens allowed (becomes the Docker resource prefix for all containers, networks, and volumes)
- **Container registry URL** — e.g. `registry.example.com`
- **Workspace output path** — defaults to `workspaces/<project>`

### Step 2 — Application Stack

**Pre-built template** — choose from 12 curated templates: Ghost, Gitea, Grafana, Immich, MinIO, n8n, Nextcloud, Nginx Proxy Manager, Plausible, Uptime Kuma, Vaultwarden, WordPress. All images, ports, volumes, healthchecks, and default env vars are pre-configured.

**Image stack (manual)** — specify your own Docker images: name, image, tag, port, host port, volumes. Use `${VAR}` references for secrets that resolve from the `.env` file at deploy time.

**Custom stack (source-built):**
- Backend: `laravel` or `nodejs`
- Frontend: `none`, `nextjs`, or `react`
- Database: `postgres` or `mysql`
- Optional: Redis, Garage S3

### Step 3 — Environments
- Environment names (e.g. `dev stage prod`)
- Per-env: domain, HTTP port, Traefik toggle, SSL, deployment engine (Compose/Swarm), replica counts, git sync

### Step 4 — Dependency Versions
- Docker image tags for each service (press Enter to accept defaults)

### Step 5 — Review & Confirm

### Non-interactive mode

```bash
./init_workspace.sh --defaults
```

---

## 7. Workspace Layout

```
workspaces/<project>/
├── config.json        ← edit this to change any setting
├── run.sh             ← run all commands from here
└── envs/
    └── dev/
        ├── .env             ← fill in real secrets before first build
        ├── .env.example     ← commit this to version control
        ├── nginx.conf       ← auto-generated; regenerated on refresh
        ├── docker-compose.yml  ← auto-generated; regenerated on refresh
        └── volumes/         ← bind-mounted data (all volume data lives here)
```

**What to commit:**

```
✅ config.json
✅ run.sh
✅ envs/*/.env.example
✅ envs/*/nginx.conf
✅ envs/*/docker-compose.yml
✅ envs/*/backend/Dockerfile
✅ envs/*/frontend/Dockerfile  (if enabled)

❌ envs/*/.env          ← contains secrets
❌ envs/*/volumes/      ← runtime data
```

---

## 8. Command Reference

All commands run from inside the workspace directory:

```bash
cd workspaces/<project>
```

### Lifecycle

```bash
./run.sh start   <env>               # Deploy / bring up the stack
./run.sh stop    <env>               # Pause containers (state preserved)
./run.sh down    <env>               # Remove containers (volumes kept)
./run.sh restart <env> [service]     # Rolling restart (all or one service)
./run.sh update  <env>               # Pull latest images + recreate (image stacks)
./run.sh refresh <env>               # Regenerate compose file + redeploy
```

### Build & Release (custom stacks only)

```bash
./run.sh build   <env>               # Build backend (+ frontend if enabled)
./run.sh build   <env> backend       # Build backend only
./run.sh build   <env> frontend      # Build frontend only
./run.sh build   <env> --push        # Build + push to registry
./run.sh build   <env> --bump        # Bump build number, then build
./run.sh build   <env> --bump minor --push

./run.sh promote <src> <dst>         # Retag + redeploy (no rebuild)
./run.sh promote <src> <dst> --dry-run

./run.sh sync    <env>               # Git pull + build + deploy
./run.sh sync    <env> --pull-only
./run.sh sync    <env> --no-deploy
```

### Operations

```bash
./run.sh ps      <env>               # Show containers (+ update check for image stacks)
./run.sh logs    <env>               # Follow all logs
./run.sh logs    <env> <service>     # Follow one service's logs
./run.sh exec    <env> <service> bash
./run.sh backup  <env>               # Run all backups (db + files)
./run.sh backup  <env> db
./run.sh backup  <env> files
./run.sh restore <env> <snapshot>    # e.g. 2026-06-01_14-30-00
```

### Configuration

```bash
./run.sh init    <env>               # Re-bootstrap env (regen Dockerfiles, nginx, compose)
./run.sh version current
./run.sh version bump                # Bump build number
./run.sh version bump minor
./run.sh version bump major
./run.sh version set 2.5.0
```

---

## 9. Environment Configuration

All settings live in `config.json`. Edit it, then run `./run.sh refresh <env>`.

### Per-environment block

```json
"environments": {
  "prod": {
    "domain":           "example.com",
    "http_port":        80,
    "traefik_enabled":  true,
    "traefik_network":  "traefik_net",
    "ssl_enabled":      true,
    "deployment":       "compose",
    "replicas": { "backend": 2, "frontend": 1 },
    "git": {
      "enabled": true,
      "repo":    "git@github.com:org/repo.git",
      "branch":  "main"
    }
  }
}
```

**`http_port` note:** Only relevant for custom stacks when Traefik is **off**. It is the host port Nginx binds to for direct access. When Traefik is on, Nginx is reached via the Docker network — no host port binding is needed.

### Image stack service fields

```json
"images": [
  {
    "name":       "app",
    "image":      "ghost",
    "tag":        "5-alpine",
    "port":       2368,
    "host_port":  "${GHOST_PORT}",
    "link_ports": ["${GHOST_PORT}"],
    "volumes":    ["./volumes/ghost_data:/var/lib/ghost/content"],
    "depends_on": ["db"],
    "extra_ports": [],
    "healthcheck": "curl -sf http://localhost:2368/ -o /dev/null || exit 1",
    "healthcheck_config": { "interval": "30s", "timeout": "10s", "retries": "3", "start_period": "60s" },
    "restart": "unless-stopped",
    "env_vars": { "url": "${GHOST_URL}" },
    "extra_compose": ""
  }
]
```

**`link_ports`** — which host ports appear as clickable links on the UI env card. Defaults to `host_port` if not set.

**`extra_compose`** — raw YAML appended verbatim to the service block in the generated compose file. Use for options not covered by structured fields (mem_limit, cpus, logging, etc.). Applies to **all** environments.

**Per-environment service overrides** — stored under `environments.<env>.service_overrides.<service_name>.extra_compose`. Same raw YAML format, applied **after** the base `extra_compose`. Use for environment-specific tuning:

```json
"environments": {
  "prod": {
    "service_overrides": {
      "app": {
        "extra_compose": "mem_limit: 4g\ncpus: \"2.0\"\nlogging:\n  driver: none"
      }
    }
  },
  "dev": {
    "service_overrides": {
      "app": {
        "extra_compose": "mem_limit: 512m\nlogging:\n  driver: json-file"
      }
    }
  }
}
```

### Version block (custom stacks)

```json
"versions": {
  "postgres": "15-alpine",
  "mysql": "8.0",
  "redis": "7-alpine",
  "nginx": "1.25-alpine",
  "node": "20-alpine",
  "php": "8.3-fpm-alpine"
}
```

---

## 10. Version Management

Image tags follow: `registry/project-backend:2.1.0-build.47-stage`

| Command | Before → After |
|---------|----------------|
| `version bump` | `1.2.3-build.41` → `1.2.3-build.42` |
| `version bump patch` | → `1.2.4-build.0` |
| `version bump minor` | → `1.3.0-build.0` |
| `version bump major` | → `2.0.0-build.0` |
| `version set 3.0.0` | → `3.0.0-build.0` |

---

## 11. Deployment Strategies

### Docker Compose (default)

```json
"deployment": "compose"
```

Best for dev and single-host stage/prod.

### Docker Swarm

```json
"deployment": "swarm",
"replicas": { "backend": 2, "frontend": 1 }
```

Enables replica scaling via `docker stack deploy`. Requires `docker swarm init`.

---

## 12. Build vs Promote

### `build` — compile a fresh image from source
```bash
./run.sh build stage --bump minor --push
```

### `promote` — move an existing validated image to the next environment
```bash
./run.sh promote stage prod
```
No Dockerfile involved. The binary is byte-for-byte identical to what ran in stage.

### Recommended release pipeline

```
dev  →  build dev  →  build stage --push  →  validate  →  promote stage prod
```

**Why not `build prod` directly?** Promoting the validated stage image guarantees you ship exactly what was tested — no build-time variance.

---

## 13. Backup & Restore

### Per-env backup snapshots (CLI)

Backups are written to `envs/<env>/backup/<YYYY-MM-DD_HH-MM-SS>/`:

```bash
./run.sh backup <env>          # database + all volumes
./run.sh backup <env> db       # database only
./run.sh backup <env> files    # volumes only
./run.sh restore <env> 2026-06-01_14-30-00
```

What gets backed up:
- **PostgreSQL** — live `pg_dump` → `*.sql.gz`
- **MySQL / MariaDB** — live `mariadb-dump` → `*.sql.gz` (uses `mariadb-admin` for v11+)
- **Volumes** — `tar.gz` per volume via `--volumes-from` → filesystem fallback if SQL dump fails

What `restore` does: stop → restore databases → restore volumes → start.

### Workspace archive backup (UI Tools page)

A separate, full-workspace archival feature available from **Tools → Workspace Backup & Restore**:

- Creates a `.tar.gz` of the entire workspace directory (config, .env files, all volume data)
- Excludes per-env backup snapshots to avoid archive-within-archive bloat
- Stored at `/data/workspace-archives/` (persisted volume, survives container restarts)
- Async — start the job and come back later to download; shows live status while running
- Download, delete from server, or restore from the UI
- Restore: upload the archive → backend validates `config.json` → extracts to `workspaces/`

---

## 14. Git Sync

When `git.enabled` is `true`, `./run.sh sync <env>` pulls the configured branch and redeploys:

```bash
./run.sh sync prod
./run.sh sync prod --pull-only
./run.sh sync prod --no-deploy
```

```json
"git": {
  "enabled": true,
  "repo":    "git@github.com:org/repo.git",
  "branch":  "main",
  "backend_path":  "./src/backend",
  "frontend_path": "./src/frontend"
}
```

---

## 15. Supported Stacks

### Backend
| Key | Stack |
|-----|-------|
| `laravel` | PHP-FPM + Composer (multi-stage prod, Xdebug in dev) |
| `nodejs` | Node.js — Express / Fastify / etc. |

### Frontend
| Key | Stack |
|-----|-------|
| `nextjs` | Next.js with `output: 'standalone'` |
| `react` | React / Vite SPA → Nginx |
| `none` | API only |

### Database
| Key | Image |
|-----|-------|
| `postgres` | `postgres:15-alpine` |
| `mysql` | `mysql:8.0` |

### Optional services
| Service | Key |
|---------|-----|
| Redis | `redis_enabled: true` |
| Garage S3 | `garage_enabled: true` |

---

## 16. Pre-built Stack Templates

12 templates included in `templates/stacks/`:

| Template | Label | Services |
|----------|-------|----------|
| `ghost` | Ghost CMS + MySQL | ghost, mysql |
| `gitea` | Gitea + PostgreSQL | gitea, postgres |
| `grafana` | Grafana + Prometheus | grafana, prometheus |
| `immich` | Immich (photo manager) | immich-server, immich-microservices, postgres, redis |
| `minio` | MinIO object storage | minio |
| `n8n` | n8n workflow automation | n8n, postgres |
| `nextcloud` | Nextcloud + PostgreSQL + Redis | nextcloud, postgres, redis |
| `nginx-proxy-manager` | Nginx Proxy Manager + MariaDB | npm-app, mariadb |
| `plausible` | Plausible Analytics | plausible, postgres, clickhouse |
| `uptime-kuma` | Uptime Kuma | uptime-kuma |
| `vaultwarden` | Vaultwarden (Bitwarden) | vaultwarden |
| `wordpress` | WordPress + MariaDB | wordpress, mariadb |

### How templates work

Each template is a JSON file in `templates/stacks/`. It declares images, ports, volumes, healthchecks, and `default_env_vars`. The wizard discovers templates by globbing `templates/stacks/*.json` — no registration required.

You can also create templates from the UI:
- **Export as template** button on any image-stack workspace page (replaces secrets with `CHANGE_ME`)
- **Tools → Compose → Template** converter (paste any `docker-compose.yml`, download the generated template JSON)
- **Save as template** button in the converter — writes directly to `templates/stacks/` on the server (no rebuild needed; templates are live-mounted)

### Volume mounts in templates

All templates use **bind mounts**: `./volumes/<name>:/container/path`. Volume data lives in `envs/<env>/volumes/<name>/` on the host — no Docker named volume overhead.

---

## 17. Image Stacks — Manual Configuration

An image stack (`"type": "image"`) deploys existing Docker images with no Dockerfiles or source code. Configure once → fill `.env` → `start`.

### Applicable commands

| Command | Image stack | Custom stack |
|---------|:-----------:|:------------:|
| `start` / `stop` / `restart` / `down` | ✅ | ✅ |
| `update` (pull + recreate) | ✅ | ✅ |
| `refresh` (regen compose + redeploy) | ✅ | ✅ |
| `ps` / `logs` / `exec` | ✅ | ✅ |
| `backup` / `restore` | ✅ | ✅ |
| `build` / `promote` / `sync` / `version` | ❌ | ✅ |

### Per-image env var interpolation

`${VAR}` placeholders in `env_vars` resolve from the `.env` file at deploy time. Each service gets only the variables it needs — no shared env blob.

---

## 18. Image Update Detection

For image stacks, DADS checks Docker Hub for updates hourly:

- **`latest` tags** — compares local digest vs remote manifest; shows "? digest unknown" (grey) if the image has no RepoDigest (e.g. pulled via compose without an explicit `docker pull`)
- **Pinned tags** — fetches the tags list and finds newer semver tags using numeric per-segment comparison (`10.0 > 9.0` correctly)

The "↑ update available" amber badge appears on the env card. After running **Update**, the cache is invalidated and a fresh check runs automatically (badge clears within ~10 seconds if the update succeeded).

---

## 19. Healthchecks

All containers include Docker healthchecks in the generated compose file.

### Custom stacks

Generated automatically by `compose-gen.sh` per service type:

| Service | Healthcheck |
|---------|-------------|
| Laravel backend | `php -r 'exit(0);'` |
| Node.js backend | `wget -qO- http://localhost:3000/health` |
| PostgreSQL | `pg_isready -U <user>` |
| MySQL / MariaDB | `mariadb-admin ping -h localhost -u root -p${PASSWORD} --silent` |
| Redis | `redis-cli ping` |
| Nginx | `curl -sf http://localhost/` |

### Image stack templates

Each service in a template carries its own `healthcheck` command and `healthcheck_config` (interval, timeout, retries, start_period). Configurable per-service in Edit Workspace.

> **Note:** Healthcheck commands containing `${VAR}` references must not use inner double-quotes around the variable (e.g. `-p${PASSWORD}` not `-p"${PASSWORD}"`). The compose generator escapes any literal `"` characters in healthcheck commands to prevent YAML syntax errors.

---

## 20. Traefik vs Direct Port Routing

### Direct ports (default for dev / Traefik off)

```json
"traefik_enabled": false
```

For custom stacks: Nginx binds `http_port` on the host → container port 80. For image stacks: each service's `host_port` is mapped directly.

### Traefik (recommended for stage/prod)

```json
"traefik_enabled": true,
"traefik_network": "traefik_net",
"ssl_enabled": true
```

No host port binding. Traefik routes by domain name using Docker labels. SSL certificates are issued automatically via Let's Encrypt. For custom stacks, Traefik routes to Nginx's internal port 80. For image stacks, Traefik routes to each service's `port` (internal container port).

**One-time setup:**
```bash
docker network create traefik_net
```

**SSL requirements:** Port 80 open, DNS A record pointing to this server, `ACME_EMAIL` set in `dads/.env`.

---

## 21. DADS UI — Web Interface

DADS UI is a browser-based control plane. It runs as a Docker container and provides full workspace management — creation, environment lifecycle, live log streaming, container terminals, backup history, image update detection, system dashboards, and admin tools.

The CLI and UI are fully interchangeable. The UI calls the same `run.sh` commands as the CLI. No business logic lives outside the Bash toolkit.

### Architecture

```
Browser  (JWT Bearer + httpOnly refresh cookie)
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│  dads container (~15 MB Alpine)                          │
│                                                             │
│  Go HTTP server (single binary, CGO_ENABLED=0)             │
│   ├─ React SPA embedded via embed.FS                        │
│   ├─ REST API + WebSocket streams                           │
│   ├─ Auth: bcrypt + dual JWT (15-min access / 7-day refresh)│
│   ├─ Proactive token refresh (fires every 13 min)           │
│   ├─ Shell bridge (strict command allowlist)                 │
│   ├─ Image update cache (hourly background checker)         │
│   ├─ Stats collector (Docker info + host /proc metrics)     │
│   └─ Async workspace archiver (tar.gz backup jobs)         │
└─────────────────────────────────────────────────────────────┘
  │  bash run.sh <cmd> <env>
  ▼
workspaces/<project>/run.sh   (auto-synced from template on startup)
```

### Quick start

```bash
cd dads
cp .env.example .env
# Set JWT_SECRET: openssl rand -hex 32
# Set ACME_EMAIL for SSL
docker network create traefik_net 2>/dev/null || true
docker compose up --build -d
# → http://localhost:8080
```

### Navigation

**Top bar:** Dashboard · Housekeeping · Tools · Settings · user menu

**Left sidebar:** workspace list with live status dots · New workspace button · Recent activity · Backup history · Version log (slide-out panels)

### Dashboard (`/`)

Skeleton loading animation while data fetches. Refreshes every 30 seconds.

- **5 stat cards:** Workspaces, Environments, Running containers, Docker images, Docker networks
- **Workspaces table:** name, type, env status dots, image count, running containers, disk, memory, Open link
- **Docker engine panel:** version, storage driver, root dir, container/image/volume/network counts
- **Host system panel:** OS, arch, CPU, uptime, memory bar, disk bar (amber >65%, red >85%)

### Workspace page (`/workspaces/:name`)

**Environment cards** — each shows:
- Environment name + status badge (running / partial / stopped / unknown)
- **Access links:** domain badge (Traefik on) or port badge(es) (Traefik off) — clickable `↗` links. Supports multiple links per env for multi-port image stacks (configured via the 🔗 checkbox on port rows)
- **"↑ update available"** amber badge / **"? digest unknown"** grey badge (image stacks)
- **`> bash`** terminal button
- **Deploy ▾** split button (Deploy / Stop / Down)
- **Restart** and **Update** buttons

**Action output panel** — streams live output from deploy, stop, restart, backup, update actions.

**Log viewer panel:**
- Environment tabs + multi-container **checkbox** selector (tick "all" or specific services)
- Per-container log colouring — each service gets a distinct colour from a 10-colour palette. Colour swatches in the container selector legend serve as a visual guide
- Text filter (grep-style with filtered/total line count)
- Auto-scroll checkbox + ⏸ Pause/Resume stream button
- ↺ Reconnect button
- **⛶ Maximize** button — opens full-screen modal with all inline features plus:
  - Row limit dropdown (All / 100 / 500 / 1 000 / 5 000)
  - **# rows** toggle for line number prefix
  - ⎘ Copy (copies current view with filter + row limit applied)
  - ⬇ Download as `.txt`
  - Clear buffer

**Compose viewer** — read-only `docker-compose.yml` with line numbers, hover-highlight per row, **Copy** button (selection-aware: copies selected text if selection exists in the viewer, otherwise copies full file). Copy works on plain HTTP via `execCommand` fallback.

### New Workspace wizard (7 steps)

1. **Project** — name (checked for uniqueness against existing workspaces), registry dropdown
2. **Stack** — Pre-built template (12 options with search + Popular/Browse All views) / Image stack / Custom app
3. **Environments** — name, domain, Traefik, SSL, port (shown only for custom stacks with Traefik off), deployment, git sync. Adding an env inherits vars from the first env
4. **Services** — per-service port mappings (with 🔗 env-card link checkbox), volume mappings (with **RW/RO** segmented control), restart policy, healthcheck command + timing, `depends_on`, Advanced YAML
5. **Backup** — enable/disable, target (local or configured remote), schedule, retention
6. **Review** — summary of all choices
7. **Result** — live bootstrap terminal. Detects success/failure from output and shows a ✓ / ✗ banner. **Open workspace** button enabled only on success. **← Go back & fix** button on failure. Step numbers in the top bar are clickable once visited for direct navigation. Top-bar button changes from Cancel → Close after creation starts

### Edit Workspace

- **Services** (image stacks) — name, image, tag; port rows (with 🔗 link checkbox, **RW/RO** volume toggle); volume rows; restart policy; healthcheck; depends_on; Advanced YAML
- **Environments** — domain, Traefik, SSL, deployment, replica counts, git sync; `http_port` shown only when Traefik is off on custom stacks; `https_port` removed (not operationally used)
- **Per-environment service overrides** (image stacks) — collapsible section per env, one YAML textarea per service. Appended after the base Advanced YAML for that environment only. "active" badge when any override is set
- **Environment variables** — collapsible inline editor (existing envs) or new-env editor (unsaved envs) with Show/hide values toggle
- **Add environment** — inherits vars from first env; shows "new" badge; visible immediately after save
- **Delete environment** — disabled when only one env remains

### Housekeeping page (`/housekeeping`)

Three tabs:

**Dashboard** — health badge, Docker storage breakdown (images/containers/volumes/build cache), safe quick actions (prune networks, prune dangling images), recent log.

**Safety Center** — expandable cards for: unused image pruning (multi-select), stopped container removal (type `PRUNE` to unlock), volume purging (3-second hold button countdown), build cache overhaul (slider unlock), old kernel cleanup.

**Automation & Logs** — daily automated tasks at 03:00 UTC; host OS operations (APT, journal rotation, temp cleanup — require `privileged: true` + `pid: host`); full task history table with output viewer.

### Settings page (`/settings`)

**Docker Registries tab** — add/edit/delete/test registries. Each registry appears as an option in the wizard registry dropdown.

**Backup Targets tab** — S3/object storage and SFTP remote destinations. Configured targets appear in the wizard backup step.

### Tools page (`/tools`)

#### Compose → Template

Converts any `docker-compose.yml` into a DADS template JSON:

- **⎘ Paste** button (clipboard API with HTTP fallback + focus-textarea fallback)
- **↑ Import file** button (file picker for `.yml`/`.yaml`/`.txt`, auto-fills template name from filename)
- Textarea supports Ctrl+V and right-click paste natively
- Conversion: services → `images[]`; ports → `port`/`host_port`/`extra_ports`; named volumes → `./volumes/name` bind mounts; env values → `${VAR}` references with originals as `default_env_vars`; healthchecks + depends_on extracted
- Output panel matched height to input panel; shows service badges + env var count
- **⎘ Copy**, **⬇ Download**, **💾 Save as template** (writes to `templates/stacks/<name>.json` on the server — no rebuild needed)

#### Workspace Backup & Restore

- **Create backup** — workspace dropdown + Start button; async tar.gz job with live 2-second polling; shows archive filename + size on completion
- **Archives on server** — lists all `.tar.gz` archives in `/data/workspace-archives/` with date, size, Download (authenticated fetch → blob URL), Delete
- **Restore** — drag-and-drop or file picker; "Overwrite if exists" checkbox; streams restore status; workspace appears in sidebar immediately after success

### Authentication

| Mechanism | Detail |
|-----------|--------|
| Password storage | bcrypt (cost 12) |
| Access token | JWT, 15-minute expiry, in-memory only |
| Refresh token | httpOnly cookie, 7-day rolling, `/api/auth/refresh` only |
| Session restore | Silent refresh on every page load |
| Proactive refresh | Timer fires every 13 minutes to renew before expiry |
| Audit log | Every action: user, workspace, command, env, timestamp |

### Security — shell bridge

The UI never runs arbitrary shell commands. Strict allowlist in `bridge.go`:

```
Allowed: start | stop | down | update | restart | ps | logs | refresh | backup | restore | init | version
```

Commands run as a fixed argv array — no string interpolation, no `bash -c`. Workspace names are validated against a slug regex and confirmed to exist in the known workspaces directory before any command executes.

### SQLite tables

| Table | Purpose |
|-------|---------|
| `users` | Admin accounts (bcrypt passwords) |
| `audit_log` | Every action with user, workspace, command, env, timestamp |
| `backup_targets` | S3 and SFTP remote backup destinations |
| `docker_registries` | Pre-authenticated container registries |
| `housekeeping_log` | Task name, trigger, status, freed bytes, output |
| `app_settings` | Application-wide key/value settings |
| `template_usage` | Template selection counts (popularity tracking) |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LISTEN_ADDR` | `:8080` | Bind address |
| `TOOLKIT_ROOT` | `/toolkit` | Mounted toolkit root |
| `WORKSPACES_DIR` | `/toolkit/workspaces` | Workspaces directory |
| `TEMPLATES_DIR` | `/toolkit/templates` | Stack templates directory |
| `DATA_DIR` | `/data` | SQLite DB + workspace archives |
| `JWT_SECRET` | — | **Required.** `openssl rand -hex 32` |

### Volume mounts

| Mount | Mode | Purpose |
|-------|------|---------|
| `../` → `/toolkit` | `ro` | Toolkit scripts and init_workspace.sh |
| `../workspaces` → `/toolkit/workspaces` | `rw` | Workspaces (run.sh executes here) |
| `../templates` → `/toolkit/templates` | `rw` | Templates (writable so Tools page can save new templates) |
| `/var/run/docker.sock` | `rw` | Docker socket |
| `dads-data` → `/data` | `rw` | SQLite DB + workspace archives persistence |

### Development mode

```bash
# Terminal 1 — Go backend
cd dads/backend
go run ./cmd/server

# Terminal 2 — React dev server
cd dads/frontend
npm install && npm run dev
# → http://localhost:5173 (proxies /api to :8080)
```

---

## 22. Maintenance Guide

### Adding a new pre-built template

1. Create `templates/stacks/<name>.json` — see Section 16 for the schema
2. No registration needed — the wizard discovers templates by globbing `*.json`
3. Or use **Tools → Compose → Template** in the UI to generate the JSON from an existing compose file, then save it directly from the browser

### Adding a new stack type (backend/frontend)

1. Add Dockerfiles to `templates/dockerfiles/<name>/`
2. Add Nginx config to `templates/nginx/<name>.conf`
3. Register in `init_workspace.sh` Step 2 `ask_choice`
4. Add service definition to `compose-gen.sh` backend `case` block
5. Add default version to `scripts/defaults/config.json`

### Adding a new environment to an existing workspace

**Option A — CLI:**
```bash
# Add env block to config.json, then:
./run.sh init <new_env>
vi envs/<new_env>/.env
./run.sh start <new_env>
```

**Option B — UI:**
Edit Workspace → Add environment → fill in settings → Save. The new env appears immediately; bootstrap on first deploy.

> Port collision: ensure `http_port` is unique across all environments on the same host.

### Updating dependency versions

```json
"versions": { "postgres": "16-alpine" }
```
```bash
./run.sh refresh <env>   # regenerates compose + pulls new image
```

---

## 23. Troubleshooting

### Compose file has YAML control character error

```
yaml: control characters are not allowed
```

This was a known bug where log output from `lib.sh` (containing ANSI escape codes) leaked into the generated `docker-compose.yml` because the logging functions wrote to stdout instead of stderr. Fixed in the current version — all `log_*` functions in `lib.sh` redirect to stderr.

If you see this on an existing deployment, run `./run.sh refresh <env>` to regenerate the compose file cleanly.

### Backup archive download not working

The download endpoint requires authentication (Bearer token). Use the **Download** button in the UI — it uses an authenticated `fetch()` call with a blob URL, not a direct `<a href>` link, which would fail without the token.

### Image update check shows "? digest unknown"

The `latest` tag update check compares local image digest against the remote. If the local image has no `RepoDigest` (common when images are pulled via compose without an explicit `docker pull`, or built locally), the comparison is indeterminate. Run **Update** to pull from the registry and populate the digest, then the check will work on subsequent hourly runs.

### Log viewer shows stuck "Backing up" status

Earlier versions had a path index bug in the backup job polling endpoint. Fixed in the current version — the job status is now polled via React Query with automatic retry and the correct path segment index.

### Port already in use

Each environment must have a unique `http_port`. Check `config.json` and `docker ps -a`. Default assignments: dev=8080, stage=8180, prod=80.

### `jq not found`

```bash
brew install jq          # macOS
apt install jq           # Debian/Ubuntu
dnf install jq           # RHEL/Fedora
```

### `realpath: illegal option -- m`

macOS's `realpath` doesn't support `-m`. Fixed in `init_workspace.sh` (uses Python fallback). Pull the latest version of the toolkit.

### `declare -A` or `${var^^}` errors

The toolkit requires Bash ≥ 3.2 and uses no Bash 4+ features. If you see these errors, a regression was introduced — please open an issue with the script name and line number.

### Running behind Cloudflare

Set Cloudflare SSL mode to **Full** (not Flexible). Flexible mode sends plain HTTP to your server, which breaks the Let's Encrypt HTTP-01 challenge that Traefik uses for certificate issuance.
