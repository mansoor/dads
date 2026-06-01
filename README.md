# DADS — Docker App Deployment Simplified

> **Yes, it's called DADS.** And like a good dad, it does all the heavy lifting without complaining, remembers exactly how everything was set up, and gets quietly upset if you don't follow the instructions. Unlike your actual dad, it won't ask why you're still using `docker run` manually in 2025.

A Bash-based toolkit for scaffolding, building, and operating multi-environment Docker application stacks. Run the wizard once to generate a self-contained workspace for your project, then use a single `run.sh` entry point to build, deploy, promote, back up, and manage it across dev, stage, and prod.

An optional web UI (`dads-ui`) is available for teams that prefer a browser interface. It runs as a Docker container, requires authentication, and calls the same `run.sh` commands the CLI does — no logic duplication. See [Section 25](#25-dads-ui--web-interface).

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Directory Structure](#2-directory-structure)
3. [How It Works](#3-how-it-works)
4. [Prerequisites](#4-prerequisites)
5. [Quick Start](#5-quick-start)
6. [The Wizard — init_workspace.sh](#6-the-wizard--init_workspacesh)
7. [Workspace Layout](#7-workspace-layout)
8. [Command Reference](#8-command-reference)
9. [Environment Configuration](#9-environment-configuration)
10. [Version Management](#10-version-management)
11. [Deployment Strategies](#11-deployment-strategies)
12. [Build vs Promote — When to Use Each](#12-build-vs-promote--when-to-use-each)
13. [Backup & Restore](#13-backup--restore)  ← updated: CLI restore command + UI restore flow
14. [Git Sync](#14-git-sync)
15. [Supported Stacks](#15-supported-stacks)
16. [Pre-built Stack Templates](#16-pre-built-stack-templates)
17. [Image Stacks — Manual Configuration](#17-image-stacks--manual-configuration)
18. [Image Update Detection](#18-image-update-detection)
19. [Healthchecks](#19-healthchecks)
20. [Maintenance — Adding a New Stack](#20-maintenance--adding-a-new-stack)
21. [Maintenance — Adding a New Pre-built Template](#21-maintenance--adding-a-new-pre-built-template)
22. [Maintenance — Adding a New Environment](#22-maintenance--adding-a-new-environment)
23. [Maintenance — Updating Dependency Versions](#23-maintenance--updating-dependency-versions)
24. [Traefik vs Direct Port Routing](#24-traefik-vs-direct-port-routing)
25. [DADS UI — Web Interface](#25-dads-ui--web-interface)  ← updated: Settings, Housekeeping, 7-step wizard, restore
26. [Troubleshooting](#26-troubleshooting)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  DADS — Docker App Deployment Simplified (engine)              │
│                                                                 │
│   init_workspace.sh          ← only file at the root; runs the wizard    │
│   scripts/         ← engine scripts (never edited per-project)  │
│   templates/       ← Dockerfile / Nginx / .dockerignore source  │
└───────────────────────────────┬─────────────────────────────────┘
                                │  init_workspace.sh generates ↓
┌───────────────────────────────▼─────────────────────────────────┐
│  workspaces/<project>/        (one per application)             │
│                                                                 │
│   config.json      ← all project + per-env settings            │
│   run.sh           ← per-project command dispatcher            │
│   envs/                                                         │
│     dev/           ← scaffolded environment                     │
│       .env         ← secrets (never committed)                  │
│       .env.example ← redacted template (safe to commit)         │
│       nginx.conf   ← rendered nginx config                      │
│       backend/     ← Dockerfile + .dockerignore                 │
│       frontend/    ← Dockerfile + .dockerignore (if enabled)    │
│       docker-compose.yml                                        │
│     stage/  prod/  ← same structure                             │
│   backups/         ← timestamped backup archives               │
└─────────────────────────────────────────────────────────────────┘
```

**Key design principles:**

- **Toolkit = pure engine.** Nothing in `scripts/` or `templates/` is project-specific. One toolkit installation serves all projects.
- **Workspace = self-contained.** Everything needed to operate a project lives in `workspaces/<project>/`. The workspace can be moved or stored separately; `run.sh` resolves the toolkit root dynamically.
- **Config-driven.** `config.json` is the single source of truth. Changing it and running `./run.sh refresh <env>` regenerates compose files and redeploys.
- **No host toolchain required.** All dependency installs (Composer, npm, pip) happen inside the Docker build. The host needs only `bash`, `docker`, and `jq`.

---

## 2. Directory Structure

### Toolkit root

```
DADS/
├── init_workspace.sh                         # Interactive workspace wizard
├── scripts/
│   ├── lib.sh                      # Shared helpers, path resolution, logging
│   ├── bootstrap.sh                # Scaffold one environment from templates
│   ├── build.sh                    # Build and push Docker images
│   ├── promote.sh                  # Retag + redeploy between environments
│   ├── deploy.sh                   # Docker Compose / Swarm operations
│   ├── compose-gen.sh              # Generate docker-compose.yml from config
│   ├── env-gen.sh                  # Generate .env and .env.example
│   ├── version.sh                  # Semver management
│   ├── backup.sh                   # Database and volume backups
│   ├── restore.sh                  # Restore from a backup snapshot (stop → restore → start)
│   ├── sync.sh                     # Git pull + build + deploy
│   ├── run.sh.template             # Canonical run.sh (synced to all workspaces on UI start)
│   └── defaults/
│       └── config.json             # Default versions (used before workspace exists)
├── templates/
│   ├── dockerfiles/
│   │   ├── laravel/
│   │   │   ├── Dockerfile          # Multi-stage prod build (PHP-FPM)
│   │   │   ├── Dockerfile.dev      # Dev build with Xdebug + Composer
│   │   │   ├── .dockerignore       # Strict: excludes vendor, tests, CI config
│   │   │   └── .dockerignore.dev   # Loose: excludes only vendor and built artefacts
│   │   ├── nodejs/                 # Express / Fastify / etc.
│   │   ├── nextjs/                 # Next.js with standalone output
│   │   └── react/                  # React / Vite SPA → served by Nginx
│   ├── nginx/
│   │   ├── laravel.conf            # FastCGI pass to PHP-FPM
│   │   ├── nodejs.conf             # Upstream proxy + WebSocket support
│   │   ├── nextjs.conf             # Upstream proxy + HMR WebSocket
│   │   └── react.conf              # Static file server with SPA fallback
│   └── stacks/                     # Pre-built image stack templates
│       ├── nginx-proxy-manager.json
│       ├── wordpress.json
│       ├── vaultwarden.json
│       └── uptime-kuma.json
└── dads-ui/                        # Web UI (see Section 25)
    ├── Dockerfile                  # Multi-stage: node → golang → alpine (~15 MB)
    ├── docker-compose.yml          # Mounts toolkit + workspaces + docker socket
    ├── .env.example
    ├── backend/                    # Go HTTP server (CGO_ENABLED=0)
    │   ├── go.mod
    │   ├── cmd/server/main.go      # Routes, embed.FS, startup sync, image checker, scheduler
    │   ├── api/
    │   │   ├── handlers.go         # Core HTTP + WebSocket handlers
    │   │   ├── settings_handlers.go # Backup targets + Docker registries CRUD
    │   │   └── housekeeping_handlers.go # Docker & host OS maintenance endpoints
    │   └── internal/
    │       ├── auth/               # JWT (access + refresh), bcrypt, middleware
    │       ├── db/                 # SQLite (modernc, CGO-free) — users, audit log,
    │       │                       # backup_targets, docker_registries, housekeeping_log
    │       ├── shell/              # Command allowlist + process bridge
    │       ├── settings/           # Backup targets + Docker registries CRUD + docker login
    │       ├── workspace/          # Discovery, config.json R/W, .env R/W, secrets
    │       │                       # CreateRequest now includes initial_env_vars,
    │       │                       # named_volumes, backup config
    │       ├── imagecheck/         # Docker Hub poller + in-memory update cache
    │       ├── stats/              # System metrics (docker info, /proc, syscall)
    │       └── config/
    └── frontend/                   # React + Vite + Tailwind
        └── src/
            ├── pages/              # Dashboard, Login, Setup, Workspace, NewWorkspace,
            │                       # EditWorkspace, Settings, Housekeeping
            ├── components/         # Layout, SlideOutPanel (+ Restore), TerminalModal,
            │                       # ComposeEditor, LogDrawer
            ├── hooks/              # useDockerEvents (SSE → React Query invalidation)
            ├── store/              # Zustand auth store (token in memory + refresh cookie)
            └── lib/                # Axios + WebSocket helpers (+ settings + housekeeping)
```

### Generated workspace

```
workspaces/<project>/
├── config.json                     # Project config (edit freely, then refresh)
├── run.sh                          # Command dispatcher — your daily driver
├── envs/
│   ├── dev/
│   │   ├── .env                    # Live secrets — NEVER commit
│   │   ├── .env.example            # Redacted template — safe to commit
│   │   ├── nginx.conf              # Rendered from templates/nginx/<backend>.conf
│   │   ├── docker-compose.yml      # Generated by compose-gen.sh
│   │   ├── backend/
│   │   │   ├── Dockerfile          # Copied from templates (Dockerfile.dev for dev)
│   │   │   ├── .dockerignore       # Env-specific variant
│   │   │   └── <your source>       # Place your app source here
│   │   └── frontend/               # Only present when frontend_enabled = true
│   │       ├── Dockerfile
│   │       ├── .dockerignore
│   │       └── <your source>
│   ├── stage/
│   └── prod/
└── backups/
    ├── dev/
    │   └── 2025-06-01_14-30-00/
    │       ├── db.sql.gz
    │       └── uploads.tar.gz
    └── prod/
```

---

## 3. How It Works

### Initialisation

1. You run `./init_workspace.sh` and answer the wizard prompts.
2. `init_workspace.sh` writes `workspaces/<project>/config.json` with all your answers.
3. It generates `workspaces/<project>/run.sh` — a lightweight dispatcher that knows where the toolkit lives.
4. It calls `scripts/bootstrap.sh` once per environment, which renders all template files into `envs/<env>/`.

### Runtime

Every command goes through `run.sh`, which exports `WORKSPACE_ROOT` and `TOOLKIT_ROOT`, then delegates to the appropriate engine script. The engine scripts read `config.json` via `lib.sh` helpers — no hardcoded values anywhere.

### Path resolution

`lib.sh` derives `TOOLKIT_ROOT` from its own location (`${BASH_SOURCE[0]}`), so it works correctly regardless of where you call `run.sh` from. `WORKSPACE_ROOT` is pre-exported by `run.sh` before `lib.sh` is sourced.

---

## 4. Prerequisites

| Tool | Required for | Install |
|------|-------------|---------|
| `bash` ≥ 3.2 | All scripts | Ships with macOS |
| `docker` + Compose plugin | Build / deploy | [docker.com](https://docs.docker.com/get-docker/) |
| `jq` | Config parsing | `brew install jq` / `apt install jq` |
| `openssl` | Secret generation | Ships with macOS / most Linux |
| `git` | Sync feature only | Ships with most systems |

> **macOS note:** The toolkit is fully compatible with the Bash 3.2 that ships with macOS. It deliberately avoids Bash 4+ features (`declare -A`, `${var^^}`, `${var[-1]}`).

---

## 5. Quick Start

```bash
# 1. Clone or copy the toolkit
git clone <toolkit-repo> docker-automation
cd docker-automation

# 2. Run the wizard
./init_workspace.sh

# 3. Move into your workspace
cd workspaces/<project-name>

# 4. Fill in secrets
vi envs/dev/.env

# 5. Copy your source code in
cp -r /path/to/my-app/* envs/dev/backend/

# 6. Build and start
./run.sh build dev
./run.sh start dev
```

---

## 6. The Wizard — init_workspace.sh

Run `./init_workspace.sh` from the toolkit root. It walks through 5 steps:

### Step 1 — Project
- **Project name** — lowercase, hyphens allowed (becomes the Docker resource prefix)
- **Container registry URL** — e.g. `registry.example.com` (used in all image tags)
- **Workspace output path** — defaults to `workspaces/<project>`, can be any absolute path

### Step 2 — Application Stack

The wizard first asks whether you want a **pre-built stack** or a **custom stack**.

**Pre-built stack** — choose from a curated library of ready-made Docker image stacks (Nginx Proxy Manager, WordPress, Vaultwarden, Uptime Kuma, etc.). The wizard loads the template automatically: images, ports, volumes, healthchecks, and default environment variables are all pre-configured. You only need to confirm or override image tags. See [Section 16](#16-pre-built-stack-templates) for the full catalogue.

**Custom stack** — build your own application from source:
- **Backend** — `laravel` or `nodejs`
- **Frontend** — `none`, `nextjs`, or `react`
- **Database** — `postgres` or `mysql`
- **Redis** — enabled/disabled
- **Garage S3** — enabled/disabled (self-hosted S3-compatible object storage)

### Step 3 — Environments
- Enter environment names (space-separated), e.g. `dev stage prod`
- For each environment: domain, HTTP/HTTPS ports, Traefik toggle, deployment engine (Compose or Swarm), replica counts, git sync settings

### Step 4 — Dependency Versions
- Docker image tags for each service (postgres, mysql, redis, garage, nginx, node/php)
- Press Enter to accept the defaults
- For pre-built stacks, this step shows only the images included in the selected template

### Step 5 — Review & Confirm
- Summary of all choices; confirm to generate

### Non-interactive mode

```bash
./init_workspace.sh --defaults
```

Accepts all defaults — useful for CI pipelines or scripted provisioning.

---

## 7. Workspace Layout

After `init_workspace.sh` completes, your workspace is fully scaffolded:

```
workspaces/<project>/
├── config.json       ← edit this to change any setting
├── run.sh            ← run all commands from here
└── envs/
    └── dev/
        ├── .env          ← fill in real secrets before first build
        ├── .env.example  ← commit this to version control
        ├── nginx.conf    ← auto-generated; regenerated on refresh
        ├── docker-compose.yml  ← auto-generated; regenerated on refresh
        ├── backend/
        │   ├── Dockerfile      ← copied from templates
        │   ├── .dockerignore   ← env-specific variant
        │   └── ...             ← place your app source here
        └── frontend/
            ├── Dockerfile
            ├── .dockerignore
            └── ...             ← place your frontend source here
```

**What to commit to git:**

```
✅ config.json
✅ run.sh
✅ envs/*/  .env.example
✅ envs/*/  nginx.conf
✅ envs/*/  docker-compose.yml
✅ envs/*/  backend/Dockerfile
✅ envs/*/  backend/.dockerignore
✅ envs/*/  frontend/Dockerfile  (if enabled)
✅ envs/*/  frontend/.dockerignore  (if enabled)

❌ envs/*/.env          ← contains secrets
❌ backups/             ← local only
```

---

## 8. Command Reference

All commands run from inside the workspace directory:

```bash
cd workspaces/<project>
```

### Lifecycle

```bash
./run.sh start      <env>                # Deploy / bring up the stack
./run.sh stop       <env>                # Pause containers (containers kept, state preserved)
./run.sh down       <env>                # Remove containers (volumes kept)
./run.sh restart    <env> [service]      # Rolling restart (all or one service)
./run.sh update     <env>                # Pull latest images + recreate containers (image stacks)
./run.sh refresh    <env>                # Regenerate compose file + redeploy
```

### Build & Release

```bash
./run.sh build   <env>                           # Build backend (+ frontend if enabled)
./run.sh build   <env> backend                   # Build backend only
./run.sh build   <env> frontend                  # Build frontend only
./run.sh build   <env> --push                    # Build + push to registry
./run.sh build   <env> --bump                    # Bump build number, then build
./run.sh build   <env> --bump minor --push       # Bump minor version, build, push

./run.sh promote <src_env> <dst_env>             # Retag + redeploy (no rebuild)
./run.sh promote <src_env> <dst_env> --dry-run   # Preview only — no changes made

./run.sh sync    <env>                           # Git pull + build + deploy
./run.sh sync    <env> --pull-only               # Git pull only
./run.sh sync    <env> --no-deploy               # Pull + build, skip deploy
```

### Operations

```bash
./run.sh ps      <env>                   # Show running containers / services
                                         # (image stacks: also checks for upstream updates)
./run.sh logs    <env>                   # Follow all logs
./run.sh logs    <env> backend           # Follow one service's logs
./run.sh exec    <env> backend bash      # Shell into the backend container
./run.sh backup  <env>                   # Run all backups (db + files)
./run.sh backup  <env> db               # Database backup only
./run.sh backup  <env> files            # Volume backup only
./run.sh restore <env> <snapshot_date>  # Restore from a backup snapshot
                                        # e.g. ./run.sh restore prod 2025-06-01_14-30-00
```

### Configuration

```bash
./run.sh init    <env>                   # Re-bootstrap env (regen Dockerfiles, nginx, compose)
./run.sh version current                 # Print current version string
./run.sh version bump                    # Bump build number
./run.sh version bump minor              # Bump minor (resets patch + build)
./run.sh version bump major              # Bump major (resets minor + patch + build)
./run.sh version set 2.5.0              # Set an explicit version
```

---

## 9. Environment Configuration

All settings live in `config.json`. Edit it directly, then run `./run.sh refresh <env>` to apply.

### Version block

Controls Docker image tags for every service:

```json
"versions": {
  "postgres":     "15-alpine",
  "mysql":        "8.0",
  "redis":        "7-alpine",
  "garage":       "v1.0.1",
  "garage_webui": "latest",
  "nginx":        "1.25-alpine",
  "node":         "20-alpine",
  "php":          "8.3-fpm-alpine",
  "composer":     "2.7"
}
```

### Per-environment block

```json
"environments": {
  "prod": {
    "domain":           "example.com",
    "http_port":        80,
    "https_port":       443,
    "backend":          "laravel",
    "frontend_enabled": true,
    "frontend":         "nextjs",
    "database":         "postgres",
    "redis_enabled":    true,
    "garage_enabled":   true,
    "deployment":       "compose",
    "traefik_enabled":  true,
    "traefik_network":  "traefik_net",
    "git": {
      "enabled": true,
      "repo":    "git@github.com:org/repo.git",
      "branch":  "main"
    },
    "replicas": {
      "backend":  2,
      "frontend": 1
    }
  }
}
```

After any edit to `config.json`:

```bash
./run.sh refresh <env>   # regenerates docker-compose.yml and redeploys
```

---

## 10. Version Management

The toolkit uses semver with a build counter: `major.minor.patch-build.N`

Image tags follow the pattern: `registry/project-backend:2.1.0-build.47-stage`

### Bump rules

| Command | Example: 1.2.3-build.41 → |
|---------|---------------------------|
| `version bump` (default) | `1.2.3-build.42` |
| `version bump patch` | `1.2.4-build.0` |
| `version bump minor` | `1.3.0-build.0` |
| `version bump major` | `2.0.0-build.0` |
| `version set 3.0.0` | `3.0.0-build.0` |

### Recommended versioning workflow

```bash
# Feature release to stage
./run.sh build stage --bump minor --push

# Hotfix in prod
./run.sh build prod --bump patch --push

# Routine CI build
./run.sh build dev --bump --push
```

The build counter is shared across environments (not per-env) and monotonically increases. It serves as a unique build ID regardless of which env triggered the build.

---

## 11. Deployment Strategies

### Docker Compose (default)

Set `"deployment": "compose"` in `config.json`. Services are managed with `docker compose up/down/restart`. Best for dev and single-host stage/prod.

### Docker Swarm

Set `"deployment": "swarm"` in `config.json`. Services are deployed as a stack via `docker stack deploy`. Enables replica scaling. Requires a Swarm to be initialised (`docker swarm init`).

Replica counts are configured per environment:

```json
"replicas": {
  "backend":  2,
  "frontend": 1
}
```

---

## 12. Build vs Promote — When to Use Each

This is the most important workflow decision for release safety.

### `build` — compile a fresh image

```bash
./run.sh build <env> --push
```

Runs the full Docker build pipeline: installs dependencies, compiles assets, layers the image. Use this when you want to create a new artifact for a given environment.

### `promote` — move an existing image

```bash
./run.sh promote <src_env> <dst_env>
```

Pulls the image built for `<src_env>`, retags it as `<dst_env>`, pushes the new tag, and deploys. **No Dockerfile is involved. No compilation occurs.** The binary artifact is byte-for-byte identical to what ran in the source environment.

### Recommended release pipeline

```
dev                    stage                  prod
 │                       │                     │
 │  ./run.sh build dev   │                     │
 │──────────────────►    │                     │
 │                       │                     │
 │  ./run.sh build       │                     │
 │    stage --push       │                     │
 │  (new prod build)     │                     │
 │──────────────────►    │                     │
 │                       │                     │
 │                       │  validate / QA      │
 │                       │                     │
 │                       │  ./run.sh promote   │
 │                       │    stage prod       │
 │                       │─────────────────►   │
```

**Why not `build prod` directly?** A fresh build from source introduces variables — updated lock files, network fetches, compiler non-determinism. Promoting the validated stage image to prod guarantees you ship exactly what was tested.

**Why not `promote dev stage`?** Dev images are built from `Dockerfile.dev` which includes Xdebug, dev servers, and bind-mount assumptions. They're unsuitable for stage or prod. Always build a proper image for stage using the production Dockerfile.

### Summary table

| Scenario | Command |
|----------|---------|
| New feature → dev | `./run.sh build dev` |
| Cut a release candidate | `./run.sh build stage --bump minor --push` |
| Promote validated build to prod | `./run.sh promote stage prod` |
| Hotfix in prod | `./run.sh build prod --bump patch --push` |
| Rollback prod to previous build | `./run.sh promote stage prod` (after reverting stage) |

---

## 13. Backup & Restore

Backups are written to `backups/<env>/<YYYY-MM-DD_HH-MM-SS>/` and are auto-pruned after 30 days.

```bash
./run.sh backup <env>          # database + all volumes
./run.sh backup <env> db       # database only
./run.sh backup <env> files    # volumes only (uploads, garage data)
```

### What gets backed up

- **PostgreSQL** — live `pg_dump` via `docker compose exec` → `<project>_<env>_<svc>_<date>.sql.gz`
- **MySQL / MariaDB** — live `mysqldump` via `docker compose exec` → `<project>_<env>_<svc>_<date>.sql.gz`
- **Named volumes** — `docker run alpine tar czf` per volume → `<project>_<env>_<vol>_<date>.tar.gz`
- **Garage** — both `garage_data` and `garage_meta` volumes

### Restore (CLI)

`restore.sh` handles the full stop → restore → start cycle automatically:

```bash
./run.sh restore <env> <snapshot_date>
# Example:
./run.sh restore prod 2025-06-01_14-30-00
```

**What `restore` does:**

1. **Stop** — `docker compose stop` on the target environment
2. **Restore databases** — for image stacks, detects postgres/mysql services by image name and finds matching `.sql.gz` files; for custom stacks, uses `config.database`
3. **Restore volumes** — extracts each `.tar.gz` archive back into its Docker named volume using an Alpine container
4. **Start** — `docker compose up -d`

> **Safety:** `restore` only touches the named environment. Other environments in the same workspace are unaffected.

### Restore (UI)

In the DADS UI, the **Backup History** slide-out panel (left sidebar) shows a **Restore** button on every snapshot row. Clicking it shows a confirmation dialog listing the files that will be restored, then streams the restore output live (same as a deploy action). See [Section 25](#25-dads-ui--web-interface) for details.

---

## 14. Git Sync

When `git.enabled` is `true` for an environment, `./run.sh sync <env>` will:

1. Pull the configured branch from `git.repo`
2. Copy source into `envs/<env>/backend/` (and `frontend/` if enabled)
3. Build new images
4. Deploy

```bash
./run.sh sync prod                # full pull → build → deploy
./run.sh sync prod --pull-only    # pull only, no build/deploy
./run.sh sync prod --no-deploy    # pull + build, skip deploy
```

Configure in `config.json`:

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

| Key | Stack | Notes |
|-----|-------|-------|
| `laravel` | PHP-FPM + Composer | Multi-stage prod; Xdebug in dev |
| `nodejs` | Node.js (Express / Fastify / etc.) | Multi-stage with pruned prod deps, non-root user |

### Frontend

| Key | Stack | Notes |
|-----|-------|-------|
| `nextjs` | Next.js | Requires `output: 'standalone'` in `next.config.js` |
| `react` | React / Vite SPA | Compiled to static files, served by Nginx |
| `none` | API only | No frontend container |

### Database

| Key | Image |
|-----|-------|
| `postgres` | `postgres:15-alpine` (default) |
| `mysql` | `mysql:8.0` (default) |

### Optional services

| Service | Enabled by | Notes |
|---------|-----------|-------|
| Redis | `redis_enabled: true` | `redis:7-alpine` |
| Garage | `garage_enabled: true` | Self-hosted S3 + WebUI on port 3909 |

---

## 16. Pre-built Stack Templates

Pre-built templates let you deploy popular self-hosted services in seconds — no Dockerfiles, no compose authoring. The wizard loads the template and generates a fully-configured workspace with environment variables, named volumes, healthchecks, and port mappings already wired up.

### Available templates

| Template | Label | Services | Default ports |
|----------|-------|----------|---------------|
| `nginx-proxy-manager` | Nginx Proxy Manager + MariaDB | NPM app, MariaDB | 80, 443, 81 (admin) |
| `wordpress` | WordPress + MariaDB + Adminer | WordPress, MariaDB, Adminer | 8080 (WP), 8181 (Adminer) |
| `vaultwarden` | Vaultwarden (Bitwarden) | Vaultwarden server | 8080 |
| `uptime-kuma` | Uptime Kuma | Uptime Kuma | 3001 |

### How templates work

Each template is a JSON file in `templates/stacks/`. It declares:
- **images** — one entry per container, including image name, tag, internal port, volumes, environment variables, healthcheck, and inter-service `depends_on`
- **default_env_vars** — placeholder values merged into the generated `.env` file

When the wizard selects a template, it reads these fields and stores them as flat variables, exactly as if you had entered them manually. The generated `config.json` and `.env` are identical in structure to those from a custom stack — the wizard is the only place templates are involved.

### Environment variables for image stacks

Each image's `env_vars` block uses `${VAR}` references that resolve from the workspace `.env` file at deploy time. For example:

```env
# envs/prod/.env
MYSQL_ROOT_PASSWORD=s3cr3t
MYSQL_PASSWORD=dbpass
NPM_HTTP_PORT=80
NPM_HTTPS_PORT=443
NPM_ADMIN_PORT=81
```

The generated `docker-compose.yml` passes these through using `${VAR}` syntax, so Docker Compose resolves them from the `.env` file. Always fill in any `CHANGE_ME` placeholders before first deploy.

### Quick start with a pre-built stack

```bash
./init_workspace.sh
# → Select "Pre-built stack" at Step 2
# → Pick e.g. "Nginx Proxy Manager + MariaDB"
# → Confirm image tags, set environments
# → Workspace generated

cd workspaces/<project>
vi envs/prod/.env          # set passwords, ports
./run.sh start prod
```

---

## 17. Image Stacks — Manual Configuration

An **image stack** (`"type": "image"` in `config.json`) is a workspace that deploys existing Docker images rather than building your own. There are no Dockerfiles, no source code directories, no build step, and no build/promote commands. The workflow is: configure → `.env` → `start`.

Pre-built templates (Section 16) are the easiest way to create an image stack, but you can also configure one manually in the wizard for any combination of images not covered by a template.

### When to use an image stack

Use image stacks for self-hosted software you run as-is: reverse proxies, password managers, monitoring tools, Git servers, dashboards, CI systems, and similar services where you are not writing the application code yourself. Use custom stacks for applications you build and deploy from source.

### Wizard flow for manual image stacks

When you select **Pre-built stack → Enter manually** (or answer "n" to the pre-built prompt), the wizard enters image configuration mode:

1. Enter the number of containers in the stack.
2. For each container, provide:
   - **Service name** — e.g. `app`, `db`, `cache`
   - **Image** — e.g. `gitea/gitea`
   - **Tag** — e.g. `latest`, `1.21`
   - **Internal port** — the port the container listens on
   - **Host port** — the port exposed on the host (leave blank to not expose directly)
   - **Volume** — a single named volume or bind mount (e.g. `gitea_data:/data`)
   - **Environment variables** — key=value pairs, one per prompt; use `${VAR}` to reference `.env` variables
3. After all images, you set per-environment variables (added to the `.env` file).

### config.json structure for image stacks

```json
{
  "project": {
    "name":     "my-gitea",
    "type":     "image",
    "registry": "registry.example.com"
  },
  "images": [
    {
      "name":       "db",
      "image":      "postgres",
      "tag":        "15-alpine",
      "port":       5432,
      "host_port":  "",
      "healthcheck": "pg_isready -U ${POSTGRES_USER} --quiet",
      "healthcheck_config": {
        "interval": "10s", "timeout": "5s", "retries": "5", "start_period": "20s"
      },
      "volumes":    ["gitea_db:/var/lib/postgresql/data"],
      "depends_on": [],
      "extra_ports": [],
      "env_vars": {
        "POSTGRES_USER":     "${POSTGRES_USER}",
        "POSTGRES_PASSWORD": "${POSTGRES_PASSWORD}",
        "POSTGRES_DB":       "${POSTGRES_DB}"
      }
    },
    {
      "name":       "app",
      "image":      "gitea/gitea",
      "tag":        "latest",
      "port":       3000,
      "host_port":  "${GITEA_HTTP_PORT}",
      "healthcheck": "curl -sf http://localhost:3000/ -o /dev/null || exit 1",
      "healthcheck_config": {
        "interval": "30s", "timeout": "10s", "retries": "3", "start_period": "60s"
      },
      "volumes":    ["gitea_data:/data"],
      "depends_on": ["db"],
      "extra_ports": ["${GITEA_SSH_PORT}:22"],
      "env_vars": {
        "GITEA__database__HOST": "db:5432",
        "GITEA__database__USER": "${POSTGRES_USER}"
      }
    }
  ],
  "environments": {
    "prod": {
      "domain":          "git.example.com",
      "traefik_enabled": true,
      "deployment":      "compose",
      "env_vars": {
        "POSTGRES_USER":     "gitea",
        "POSTGRES_PASSWORD": "CHANGE_ME",
        "POSTGRES_DB":       "gitea",
        "GITEA_HTTP_PORT":   "3000",
        "GITEA_SSH_PORT":    "2222"
      }
    }
  }
}
```

Key fields in the `images` array:

| Field | Description |
|-------|-------------|
| `name` | Service name in the generated Compose file |
| `image` / `tag` | Docker image to pull |
| `port` | Container-internal port (used by Traefik labels if enabled) |
| `host_port` | Exposed host port; `""` means not directly exposed |
| `extra_ports` | Additional port mappings (e.g. SSH `"2222:22"`) |
| `volumes` | Named volume or bind mount strings |
| `depends_on` | Services this container waits for before starting |
| `healthcheck` | Shell command; exit 0 = healthy |
| `healthcheck_config` | `interval`, `timeout`, `retries`, `start_period` |
| `env_vars` | Container environment; `${VAR}` references are resolved from `.env` |

### Workspace layout for image stacks

Image stacks generate a simpler workspace — no Dockerfiles, no Nginx config, no backend/frontend directories:

```
workspaces/<project>/
├── config.json
├── run.sh
└── envs/
    └── prod/
        ├── .env              ← fill in secrets before first start
        ├── .env.example      ← safe to commit
        └── docker-compose.yml
```

### Applicable run.sh commands

Image stacks do not have a build step, so build-related commands are not applicable:

| Command | Image stack | Custom stack |
|---------|:-----------:|:------------:|
| `start` / `stop` / `restart` | ✅ | ✅ |
| `ps` (with update detection) | ✅ | ✅ |
| `logs` / `exec` | ✅ | ✅ |
| `refresh` | ✅ | ✅ |
| `backup` | ✅ | ✅ |
| `init` | ✅ | ✅ |
| `build` | ❌ | ✅ |
| `promote` | ❌ | ✅ |
| `sync` | ❌ | ✅ |
| `version` | ❌ | ✅ |

### Per-image env var interpolation

The `env_vars` block in each image entry uses `${VAR}` placeholders. At deploy time, `docker compose` resolves these from the `.env` file in the environment directory. This means:

- Each service gets only the variables it needs (no shared env blob)
- Secrets are never duplicated across services — define once in `.env`, reference in multiple images
- `${VAR}` references appear literally in `config.json` and `docker-compose.yml`; Docker Compose handles resolution at runtime

After editing `.env`, run `./run.sh refresh <env>` to regenerate the Compose file and redeploy with the updated values.

---

## 18. Image Update Detection

For workspaces using image stacks (pre-built or manual), `./run.sh ps <env>` automatically checks for upstream image updates after displaying container status.

```bash
./run.sh ps prod
```

Example output:

```
CONTAINER ID   IMAGE                            STATUS
a1b2c3d4e5f6   jc21/nginx-proxy-manager:latest  Up 3 days (healthy)
b2c3d4e5f6a7   mariadb:10.6                     Up 3 days (healthy)

Checking for image updates...
  ✓  mariadb:10.6                    — up to date
  ↑  jc21/nginx-proxy-manager:latest — update available
```

When an update is available, redeploy with:

```bash
./run.sh refresh <env>
```

`refresh` re-generates `docker-compose.yml` and runs `docker compose up -d --pull always`, which pulls the latest image and restarts only the affected container.

The update check is performed by `scripts/image-check.sh`, which compares the local image digest against the registry manifest. It requires network access to the image registry and `docker manifest inspect` support.

---

## 19. Healthchecks

All containers — both custom-built and pre-built image stacks — include Docker healthchecks in the generated `docker-compose.yml`.

### Custom stacks

Healthchecks are generated by `compose-gen.sh` based on the service type:

| Service | Healthcheck |
|---------|-------------|
| Laravel / Node.js backend | `curl -sf http://localhost:<port>/` |
| Next.js frontend | `curl -sf http://localhost:<port>/` |
| PostgreSQL | `pg_isready -U <user>` |
| MySQL | `mysqladmin ping -h localhost --silent` |
| Redis | `redis-cli ping` |
| Nginx | `curl -sf http://localhost/` |

### Pre-built image stacks

Healthchecks are defined in the template JSON and are included verbatim in the compose output. Each service in a template carries its own `healthcheck` command and timing configuration (`interval`, `timeout`, `retries`, `start_period`).

For example, the Nginx Proxy Manager template defines:

```json
"healthcheck": "curl -sf http://localhost:81/ -o /dev/null || exit 1",
"healthcheck_config": {
  "interval": "30s",
  "timeout":  "10s",
  "retries":  "3",
  "start_period": "60s"
}
```

The `start_period` is especially important for services that run database migrations or take time to initialise on first boot.

### Viewing health status

```bash
./run.sh ps <env>     # shows STATUS column including (healthy) / (starting) / (unhealthy)
```

---

## 20. Maintenance — Adding a New Stack

To add a new backend (e.g. `django`) or frontend (e.g. `nuxt`):

### Step 1 — Add Dockerfile templates

```
templates/dockerfiles/django/
├── Dockerfile          # Multi-stage production build
├── Dockerfile.dev      # Dev build (hot-reload, debug tools)
├── .dockerignore       # Strict: for prod/stage builds
└── .dockerignore.dev   # Loose: for dev bind-mount builds
```

**Dockerfile conventions:**
- Production: multi-stage — deps stage → build stage → minimal runtime stage
- Dev: single stage — install tools, expose port, set entrypoint for hot-reload
- Use `ARG BUILD_ENV` and `ARG VERSION` — they are passed by `build.sh`
- Run as a non-root user in the final stage

**`.dockerignore` conventions:**
- Prod: exclude `.git`, `.env*`, test files, CI config, linting config, compiled output, docs
- Dev: exclude compiled output, secrets, and source directories (they are bind-mounted)

### Step 2 — Add an Nginx template

```
templates/nginx/django.conf
```

Use the placeholders `{{DOMAIN}}`, `{{PREFIX}}`, `{{PROJECT}}`, `{{ENV}}` — they are substituted by `bootstrap.sh` using `sed`.

For a Django/gunicorn backend, proxy to the backend container:

```nginx
upstream {{PREFIX}}_backend {
    server {{PREFIX}}_backend:8000;
    keepalive 32;
}

server {
    listen 80;
    server_name {{DOMAIN}};

    location / {
        proxy_pass http://{{PREFIX}}_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Step 3 — Register in init_workspace.sh

Add the new backend to the `ask_choice` in Step 2 of the wizard:

```bash
ask_choice BACKEND "Backend framework" "laravel" \
  "laravel" "Laravel (PHP-FPM)" \
  "nodejs"  "Node.js (Express / Fastify / etc.)" \
  "django"  "Django (Python / Gunicorn)"          # ← add this line
```

### Step 4 — Add to compose-gen.sh

In `scripts/compose-gen.sh`, add the service definition for your new stack inside the backend `case` statement, with the appropriate image, ports, volumes, and healthcheck.

### Step 5 — Add default version

In `scripts/defaults/config.json`, add the default image tag:

```json
"versions": {
  ...
  "python": "3.12-slim"
}
```

And add the corresponding version question in `init_workspace.sh` Step 4.

---

## 21. Maintenance — Adding a New Pre-built Template

Pre-built templates live in `templates/stacks/` as JSON files. To add a new one (e.g. Gitea):

### Step 1 — Create the template JSON

```
templates/stacks/gitea.json
```

The schema:

```json
{
  "name":        "gitea",
  "label":       "Gitea + PostgreSQL",
  "description": "Self-hosted Git service",
  "tags":        ["git", "vcs"],
  "images": [
    {
      "name":       "db",
      "image":      "postgres",
      "tag":        "15-alpine",
      "port":       5432,
      "host_port":  "",
      "command":    "",
      "healthcheck": "pg_isready -U ${POSTGRES_USER} --quiet",
      "healthcheck_config": {
        "interval": "10s", "timeout": "5s", "retries": "5", "start_period": "20s"
      },
      "volumes":    ["gitea_db:/var/lib/postgresql/data"],
      "depends_on": [],
      "extra_ports": [],
      "env_vars": {
        "POSTGRES_USER":     "${POSTGRES_USER}",
        "POSTGRES_PASSWORD": "${POSTGRES_PASSWORD}",
        "POSTGRES_DB":       "${POSTGRES_DB}"
      }
    },
    {
      "name":       "app",
      "image":      "gitea/gitea",
      "tag":        "latest",
      "port":       3000,
      "host_port":  "${GITEA_HTTP_PORT}",
      "command":    "",
      "healthcheck": "curl -sf http://localhost:3000/ -o /dev/null || exit 1",
      "healthcheck_config": {
        "interval": "30s", "timeout": "10s", "retries": "3", "start_period": "60s"
      },
      "volumes":    ["gitea_data:/data"],
      "depends_on": ["db"],
      "extra_ports": ["${GITEA_SSH_PORT}:22"],
      "env_vars": {
        "GITEA__database__DB_TYPE": "postgres",
        "GITEA__database__HOST":    "db:5432",
        "GITEA__database__NAME":    "${POSTGRES_DB}",
        "GITEA__database__USER":    "${POSTGRES_USER}",
        "GITEA__database__PASSWD":  "${POSTGRES_PASSWORD}"
      }
    }
  ],
  "default_env_vars": {
    "POSTGRES_USER":     "gitea",
    "POSTGRES_PASSWORD": "CHANGE_ME",
    "POSTGRES_DB":       "gitea",
    "GITEA_HTTP_PORT":   "3000",
    "GITEA_SSH_PORT":    "2222"
  }
}
```

### Fields reference

| Field | Description |
|-------|-------------|
| `name` | Machine identifier — must match the filename (without `.json`) |
| `label` | Display name shown in the wizard |
| `description` | One-line description shown in the wizard |
| `tags` | Freeform tags (informational only) |
| `images[].name` | Service name in Docker Compose |
| `images[].image` | Docker Hub image name |
| `images[].tag` | Default image tag (wizard allows override) |
| `images[].port` | Container-internal port |
| `images[].host_port` | Host port (`""` = not exposed directly) |
| `images[].extra_ports` | Additional port mappings (e.g. SSH) |
| `images[].volumes` | Named volume or bind mount mappings |
| `images[].depends_on` | Service names this image waits for |
| `images[].healthcheck` | Shell command returning 0 = healthy |
| `images[].healthcheck_config` | `interval`, `timeout`, `retries`, `start_period` |
| `images[].env_vars` | Env vars passed to the container; use `${VAR}` references |
| `default_env_vars` | Initial values written to the generated `.env` file |

### Step 2 — Test it

```bash
./init_workspace.sh
# → Select "Pre-built stack"
# → Your new template should appear in the list
```

The wizard discovers templates automatically by globbing `templates/stacks/*.json` — no registration required.

---

## 22. Maintenance — Adding a New Environment

To add a `qa` environment to an existing workspace:

### Option A — Re-run init_workspace.sh (clean workspace)

Best for a new project where you haven't deployed yet. Re-run `./init_workspace.sh`, include `qa` in the environment list, and your workspace is fully regenerated.

### Option B — Add manually (existing workspace)

**Step 1 — Add the environment block to `config.json`:**

```json
"environments": {
  "dev":  { ... },
  "stage": { ... },
  "prod": { ... },
  "qa": {
    "domain":           "qa.example.com",
    "http_port":        8280,
    "https_port":       8643,
    "backend":          "laravel",
    "frontend_enabled": true,
    "frontend":         "nextjs",
    "database":         "postgres",
    "redis_enabled":    true,
    "garage_enabled":   false,
    "deployment":       "compose",
    "traefik_enabled":  false,
    "traefik_network":  "traefik_net",
    "git": {
      "enabled": false,
      "repo":    "git@github.com:org/repo.git",
      "branch":  "qa"
    },
    "replicas": {
      "backend":  1,
      "frontend": 1
    }
  }
}
```

**Step 2 — Bootstrap the new environment:**

```bash
./run.sh init qa
```

This runs `bootstrap.sh` for `qa`, generating:
- `envs/qa/.env` and `.env.example`
- `envs/qa/nginx.conf`
- `envs/qa/docker-compose.yml`
- `envs/qa/backend/Dockerfile` + `.dockerignore`
- `envs/qa/frontend/Dockerfile` + `.dockerignore` (if enabled)

**Step 3 — Fill in secrets and deploy:**

```bash
vi envs/qa/.env
./run.sh build qa --push
./run.sh start qa
```

> **Port collision warning:** Ensure the `http_port` and `https_port` are unique across all environments running on the same host. Default assignments: dev=8080/8443, stage=8180/8543, prod=80/443.

---

## 23. Maintenance — Updating Dependency Versions

To upgrade PostgreSQL from `15-alpine` to `16-alpine` across all environments:

**Step 1 — Update `config.json`:**

```json
"versions": {
  "postgres": "16-alpine"
}
```

**Step 2 — Regenerate and redeploy:**

```bash
./run.sh refresh dev
./run.sh refresh stage
./run.sh refresh prod
```

`refresh` regenerates `docker-compose.yml` (picking up the new image tag) and runs `docker compose up -d` which pulls the new image and restarts the affected container.

> **Database upgrades require a data migration.** Back up first (`./run.sh backup <env> db`), then check the official upgrade guide for your database engine before applying to prod.

---

## 24. Traefik vs Direct Port Routing

### Direct ports (default for dev)

```json
"traefik_enabled": false,
"http_port": 8080
```

Nginx binds directly to `http_port` on the host. Access at `http://localhost:8080`. Simple, no external dependencies.

### Traefik (recommended for stage/prod)

```json
"traefik_enabled": true,
"traefik_network": "traefik_net"
```

Nginx is not port-mapped. Instead, Traefik labels are added to the container so Traefik's reverse proxy picks it up by domain name. SSL termination is handled by Traefik (Let's Encrypt). Requires Traefik to be running on the same Docker network.

These two modes are mutually exclusive. Toggling `traefik_enabled` and running `./run.sh refresh <env>` switches between them.

---

## 25. DADS UI — Web Interface

DADS UI is a browser-based control plane for the toolkit. It runs as a Docker container alongside your workspaces and provides a full management interface — workspace creation, environment lifecycle, live log streaming, container terminals, backup history, image update detection, and system dashboards — without touching the CLI.

The CLI and UI are fully interchangeable. The UI calls the same `run.sh` commands the CLI does; no business logic lives outside the Bash toolkit. On server startup, DADS UI automatically syncs `run.sh` into all existing workspaces from the canonical template, so new commands are always available without manual re-bootstrapping.

### Architecture

```
Browser
  │  HTTPS  (JWT Bearer + httpOnly refresh cookie)
  ▼
┌─────────────────────────────────────────────────────────────┐
│  dads-ui container                                           │
│                                                             │
│  Go HTTP server (CGO_ENABLED=0, single binary)              │
│   ├─ Serves React SPA (embedded via embed.FS)               │
│   ├─ REST API  /api/*                                        │
│   ├─ WebSocket /api/workspaces/*/action  (action streaming)  │
│   ├─ WebSocket /api/workspaces/*/create  (bootstrap stream)  │
│   ├─ WebSocket /api/workspaces/*/envs/*/terminal (shell)     │
│   ├─ SSE       /api/events  (Docker container events)        │
│   ├─ Auth: bcrypt + dual JWT + SQLite                        │
│   ├─ Shell bridge (strict command allowlist)                 │
│   ├─ Image update cache (hourly background checker)          │
│   └─ Stats collector (Docker info + host metrics)            │
└────────────────────┬────────────────────────────────────────┘
                     │  bash run.sh <cmd> <env>
                     ▼
         workspaces/<project>/run.sh  (auto-synced from template)
```

The React frontend is compiled into the Go binary at build time via `embed.FS` — no separate web server or CDN required. The binary is approximately 15 MB and starts in under 1 second.

### Quick start

```bash
cd dads-ui

# 1. Copy and configure the env file
cp .env.example .env
# Required: set JWT_SECRET (generate with: openssl rand -hex 32)
# Required for SSL: set ACME_EMAIL to your email address

# 2. Create the shared Traefik network (one-time, safe to re-run)
docker network create traefik_net 2>/dev/null || true

# 3. Build and start (launches both dads-ui and Traefik)
docker compose up --build -d

# 4. Open http://localhost:8080
#    → First visit redirects to /setup to create your admin account
#    → Subsequent visits restore your session automatically (persistent login)
```

### UI layout

#### Top navigation bar
- **DADS logo** (top-left) — clickable, navigates to Dashboard
- **Dashboard** link — system overview
- **Housekeeping** link — Docker & host OS maintenance centre
- **Settings** link — backup targets, Docker registries
- **Username menu** (top-right) — dropdown with:
  - Signed-in username
  - **Change password** — modal with current + new password fields
  - **Sign out**

#### Left sidebar
- **Workspaces list** — all discovered workspaces with live status dots (green = running, amber = partial, red = stopped)
- **New workspace** — opens the creation wizard
- **Recent activity** — opens slide-out panel (see below)
- **Backup history** — opens slide-out panel
- **Version log** — opens slide-out panel

#### Slide-out panels (Recent Activity / Backup History / Version Log)

Clicking any of the three sidebar items opens a 70%-width panel that slides in from the right. All three panels share an identical layout:

- **Workspace filter** — text search by workspace name
- **Type filter** — All / Image stacks / Custom apps
- **Clear** — resets filters
- **Close (×)** or **Escape** — dismisses the panel

Content per panel:
- **Recent activity** — chronological list of all actions across all workspaces: command badge (colour-coded), workspace name, environment, author, time ago
- **Backup history** — collapsible snapshot rows per workspace/env, showing date, total size, and individual file names + sizes on expand. Each row has a **Restore** button (amber) that opens a confirmation dialog then streams the restore output live
- **Version log** — per-workspace list of build, promote, and version events

#### Dashboard (`/`)

The dashboard refreshes every 30 seconds and shows:

**Stat cards (top row):**
| Card | Data |
|------|------|
| Workspaces | Total count, split by image vs custom |
| Environments | Total across all workspaces |
| Running containers | Count, with stopped/paused breakdown |
| Docker images | Total images |
| Docker networks | Total networks + engine version |

**Workspaces table:**
Each workspace row shows: name (clickable link), type badge, environment status dots, image/service count, running container count, disk usage (from `du`), memory usage (from `docker stats`), and an Open link.

**Docker engine panel:**
Engine version, storage driver, root directory, container/image/volume/network counts.

**Host system panel:**
OS, architecture, CPU cores, uptime, memory usage bar (GB free / total), disk usage bar (GB free / total). Bars turn amber above 65% and red above 85%.

#### Workspace page (`/workspaces/:name`)

**Header area:**
- Workspace name, type badge (`image` / `custom`), deployment badge (`compose` / `swarm`)
- **Export as template** button (image stacks only) — saves the workspace as a reusable pre-built template JSON with secret values replaced by `CHANGE_ME` placeholders
- **Edit workspace** button
- **Build** button (custom stacks only)

**Environment cards:**

Each environment gets a card showing:
- **Environment name** with live **"↑ update available"** amber badge (image stacks) when upstream images have changed
- **Port/domain badge** — clickable `↗` link: shows `:port ↗` when no domain is configured (opens `http://host:port`), or `domain.com ↗` when a domain is set
- **`> bash` button** — opens the container terminal popup (see below)
- **Status badge** — running / partial / stopped / unknown
- **Action grid (2×2):**
  - **Deploy** — `docker compose up -d --remove-orphans`
  - **Update** (image stacks) — `docker compose pull` then `docker compose up -d`; shows "✓ Up to date" (grey) when the image update cache confirms no updates
  - **Restart** — `docker compose restart`
  - **Stop ▾** (split button) — main button: `docker compose stop` (pauses containers, state preserved); dropdown: **Stop** or **Inactivate** (`docker compose down`, removes containers, keeps volumes)
- **Footer row:** Env Vars · Compose · Backup

**Env Vars modal:**
- Lists all `.env` keys
- Each row has an editable value input + **×** delete icon (staged — nothing deleted until Save)
- **Show values** checkbox — fetches and displays actual plaintext values (`?reveal=true`)
- New key/value row at the bottom
- Save applies all edits and deletions atomically

**Bottom split (50% / 50%):**

*Left — Action output:*
- Streams output from the most recent action (Deploy, Stop, Restart, Backup, Update, etc.)
- Shows a pulsing green dot while running
- **Clear** button resets it
- Empty state shows a hint message

*Right — Log viewer:*
- Environment selector tabs — switch between envs (reconnects the stream)
- Container pills — populated from `docker compose ps`; click to filter logs to one service (`all` shows combined output)
- Scrollable log area with ANSI colour rendering, buffers last 2 000 lines
- **↺ reconnect** button

#### Container terminal popup (`> bash` button)

Clicking the `> bash` badge on any environment card opens a terminal popup:

- **Container dropdown** — only running containers are listed
- **Connect** — opens a WebSocket to the server which runs `docker exec -it <container> bash` (falls back to `sh` if bash is unavailable); xterm.js renders the output
- **Disconnect** — closes the WebSocket; you can then select a different container and reconnect
- **Close (×)** — disconnects and closes the popup
- **Auto-resize** — ResizeObserver fits xterm.js to the popup and sends `stty` resize commands to the shell
- **Connected indicator** — pulsing green dot + "connected" label while the shell session is active

#### Create workspace wizard (7 steps)

**Step 1 — Project:** workspace name and container registry.

The registry field is a smart dropdown: if registries have been configured in **Settings → Docker Registries**, they appear as options (defaulting to the first one). An **"Other (enter manually)…"** option reveals a free-text input. When no registries are configured, an amber banner links to Settings and the text input is shown directly.

**Step 2 — Application stack:** choose between three options:
- **Pre-built template** — pick from curated templates (NPM, WordPress, Vaultwarden, Uptime Kuma, and any exported custom templates). Template env vars are loaded and smart secrets auto-generated.
- **Image stack** — specify your own Docker images: service name, image, tag, container port, host port. Add per-service environment variables that go into `.env`.
- **Custom application** — source-built app: backend (Laravel / Node.js), frontend (none / Next.js / React), database, Redis, Garage.

**Step 3 — Environments:** name, domain, ports, Traefik toggle, deployment engine, git sync settings.

**Step 4 — Env Vars & Volumes:**
- **Initial environment variables** — key/value pairs written into every environment's `.env` at creation. For image stacks these merge with the per-service vars from Step 2 (user values win).
- **Named volumes** — declare additional Docker named volumes (name + mount path). These are stored in `config.json` and declared in the generated `docker-compose.yml`.

**Step 5 — Backup Configuration:**
- **Enable/disable** backups toggle
- **Destination** — Local filesystem (default) or any S3/SFTP target configured in Settings. A link to Settings is shown when no remote targets exist.
- **Schedule** — Daily / Weekly / Manual
- **Retention** — 3 / 7 / 14 / 30 backups (older snapshots pruned automatically)

**Step 6 — Review:** summary of all choices including env var count, volume names, and backup destination.

**Step 7 — Creating:** live xterm.js terminal showing bootstrap output as it runs.

#### Edit workspace

Available from the **Edit workspace** button on any workspace page:

- **Project** — name and registry
- **Services** (image stacks only) — editable list of images: name, image, tag, container port, host port, volumes (one per line)
- **Environments** — edit domain, ports, Traefik settings, deployment, git sync, backend/frontend/database settings (custom stacks only), replica counts
- **Add environment** — pre-filled from first env; new envs get an "Init" hint after save
- **Danger zone** — **Delete workspace** button opens a confirmation modal requiring the user to type the exact workspace name before deletion proceeds. Deletes all workspace files, configs, and backups permanently.

### Image update detection

For image-stack workspaces, DADS UI runs a background Go routine that checks Docker Hub for image updates once per hour:

- **`latest` tags** — compares local image digest vs remote manifest digest; if different, marks as updated
- **Pinned tags** — fetches the Docker Hub tags list and finds any newer semver tag

Results are cached in memory. The frontend polls every 10 minutes and shows an amber pulsing badge ("↑ update available") on any environment where an update is available. Clicking the **Update** button in the env card pulls the new images and recreates containers.

### Authentication and sessions

| Mechanism | Detail |
|-----------|--------|
| Password storage | bcrypt (cost 12) |
| Access token | JWT, 15-minute expiry, stored in browser memory only (never localStorage) |
| Refresh token | Separate long-lived JWT, httpOnly cookie scoped to `/api/auth/refresh`, 7-day MaxAge, rolling (extended on each refresh) |
| Session restore | On every page load, the app silently calls `/api/auth/refresh`; if the cookie is valid, the session is restored without showing the login page |
| Login rate limit | 5 attempts per IP per 15 minutes |
| Env var read | Values returned masked (`••••••••`) by default; opt-in reveal via `?reveal=true` — requires the same JWT |
| Audit log | Every action recorded: user, workspace, command, environment, timestamp |
| Change password | Verifies current password before applying the new one |

### Security model — shell bridge

The UI never runs arbitrary shell commands. Every action goes through a strict command allowlist in `internal/shell/bridge.go`:

```
Allowed: start | stop | down | update | restart | ps | logs | refresh | backup | restore | init | version
```

Commands are passed as a fixed argv array (`bash run.sh <cmd> <env>`) — no string interpolation, no `bash -c`, no user input in the command position. Workspace names are validated against a slug regex and confirmed to exist within the known workspaces directory before any command runs.

Env file edits go through `internal/workspace/workspace.go` with structured key/value parsing — no raw file text is accepted from the browser.

The container terminal uses `docker exec -it <container_id> sh` with explicit container ID validation — the ID is resolved by the server via `docker compose ps`, not accepted from the client.

### Backend packages

```
dads-ui/backend/internal/
├── auth/           # JWT (access + refresh), bcrypt, Bearer middleware, rate limiter
├── db/             # SQLite via modernc.org/sqlite (CGO-free), auto-migration
├── shell/          # Command allowlist, subprocess environment, Bootstrap helper
├── settings/       # Backup targets (S3/SFTP) + Docker registries — CRUD + docker login
├── workspace/      # Discovery, config.json parsing, .env R/W, secrets generator
│                   # CreateRequest includes initial_env_vars, named_volumes, backup config
├── imagecheck/     # Docker Hub API client, digest comparison, semver tag checker, in-memory cache
├── stats/          # docker info, /proc/meminfo, syscall.Statfs, du, docker stats parser
└── config/         # Env var config (LISTEN_ADDR, JWT_SECRET, paths)
```

### SQLite tables

| Table | Purpose |
|-------|---------|
| `users` | Admin accounts (bcrypt passwords) |
| `audit_log` | Every action: user, workspace, command, env, timestamp |
| `backup_targets` | S3 and SFTP backup destinations (config stored as JSON blob) |
| `docker_registries` | Pre-authenticated container registries (credentials for `docker login`) |
| `housekeeping_log` | Record of every housekeeping action: task, trigger, status, output, freed bytes |

### Settings page (`/settings`)

The Settings page is accessible from the top navigation bar. It has two tabs:

#### Docker Registries tab
Manage pre-authenticated container registries. Each entry stores a display name, registry URL, username, and password.

- **Add / Edit / Delete** registry entries
- **Test** button — runs `docker login --password-stdin <url>` inside the container and reports success or the error message
- Registries appear as options in the **Create workspace wizard Step 1** registry dropdown
- Adding a registry automatically runs `docker login` so subsequent `docker pull` commands in the container succeed without additional authentication

#### Backup Targets tab
Configure remote destinations for workspace backups.

**S3 / Object Storage target fields:**
- Endpoint (e.g. `s3.amazonaws.com` or a custom MinIO/R2/Wasabi URL)
- Bucket, Region, Path prefix
- Access key + Secret key
- Use SSL toggle

**SFTP target fields:**
- Host, Port, Username, Remote path
- Authentication: Password or SSH private key (paste PEM content)

Configured targets appear in the **Create workspace wizard Step 5** backup destination dropdown.

---

### Housekeeping page (`/housekeeping`)

The Housekeeping page is accessible from the top navigation bar. It has three tabs:

#### Tab 1 — Dashboard
- **Health status badge** — HEALTHY / CLEANUP ADVISED / CRITICAL SPACE DEFICIT (based on total reclaimable Docker storage)
- **Docker storage breakdown** — four cards (Images, Containers, Volumes, Build Cache) showing size, count, and reclaimable space with proportional bars
- **Safe quick actions** (no approval needed):
  - **Prune Unused Networks** — `docker network prune -f` (runs immediately, output shown in a modal)
  - **Prune Dangling Images** — `docker image prune -f` (removes `<none>:<none>` layers)
- **Recent housekeeping** — last 5 log entries with freed space and time ago

#### Tab 2 — Safety Center
Each item is a collapsible card. Expand to review before acting.

| Card | Risk | Approval mechanism |
|------|------|--------------------|
| Unused Image Pruning | Medium | Checkbox multi-select per image → **Approve & Purge Images** button |
| Stopped Container Removal | Medium | Table showing exit codes → type `PRUNE` in a text field to unlock |
| Volume Purging | **Critical** | Per-volume toggle switches + 3-second hold-button countdown ("Authorize Irreversible Volume Destruction") |
| Build Cache Overhaul | Medium | Disk breakdown bars → slider drag to unlock → **Execute Global System Clean** |
| Old Kernel Cleanup | Medium | Active + previous kernels locked (🔒); obsolete kernels selectable → 2-step confirmation modal |

#### Tab 3 — Automation & Logs
**Automated tasks** (run daily at 03:00 UTC, no approval):
- Network cleanup (`docker network prune -f`)
- Dangling image prune (`docker image prune -f`)

**Host OS config cards** (require `privileged: true` + `pid: host` in docker-compose.yml):
- **APT cache cleanup** — `apt-get autoremove && apt-get clean`, run-now button
- **Journal rotation** — configurable max age (days) and max size (GB), apply vacuum button
- **Temp directory cleanup** — configurable max age (days unaccessed), exclusion patterns (comma-separated), clean button

**Task history table** — last 100 entries from `housekeeping_log`: task name, trigger (manual/cron), status, freed bytes, timestamp. Click any row to view the full command output.

**Enabling host OS operations:**

Add the following to the `dads-ui` service in `docker-compose.yml`:

```yaml
    privileged: true
    pid: host
```

Without these, APT, journalctl, kernel, and /tmp operations return a configuration guidance message; Docker operations are unaffected.

---

### Traefik & SSL

DADS UI ships with Traefik v3.1 in `docker-compose.yml`. It runs alongside the `dads-ui` container and handles HTTP/HTTPS ingress for all workspace containers.

#### How it works

Traefik watches the `traefik_net` Docker network for label changes. When a workspace is deployed with Traefik enabled, its containers join `traefik_net` and Traefik automatically starts routing traffic to them. When `ssl_enabled` is true, Traefik requests a Let's Encrypt certificate for the domain and serves HTTPS — no manual cert management required.

```
Internet / upstream proxy (:80, :443)
        │
        ▼
    Traefik v3.1                ← reads Docker labels on traefik_net
        │
        ├── example.com → workspace-prod nginx :80
        ├── app.example.com → workspace-prod frontend :3000
        └── dads.example.com → dads-ui :8080 (optional)
```

#### One-time setup

```bash
# Create the shared network before first deploy
docker network create traefik_net 2>/dev/null || true

# Set ACME_EMAIL in dads-ui/.env (required for SSL)
echo "ACME_EMAIL=admin@example.com" >> dads-ui/.env

docker compose up --build -d
```

#### SSL requirements

| Requirement | Detail |
|-------------|--------|
| Port 80 open | Let's Encrypt HTTP-01 challenge must reach Traefik |
| DNS record | Domain A record must point to this server |
| ACME_EMAIL | Set in `dads-ui/.env` before first SSL workspace |
| Rate limit | Let's Encrypt allows 5 certs per domain per week |

> **Behind Cloudflare:** Set SSL mode to **Full** (not Flexible) so the HTTP-01 challenge can reach Traefik on port 80. Flexible SSL terminates HTTPS at Cloudflare and sends plain HTTP to your server, which breaks cert issuance.

#### Enabling SSL for a workspace

**New workspace:** In the wizard Step 3, enable Traefik, enter a domain, then toggle **SSL certificate (Let's Encrypt)**.

**Existing workspace:** In Edit Workspace → environment block, enable Traefik, enter a domain, toggle **SSL certificate**, save, then run:
```bash
./run.sh refresh <env>
```
This regenerates `docker-compose.yml` with the TLS router labels. Traefik picks them up automatically and issues the cert on the next request.

#### Exposing DADS UI via SSL (optional)

Uncomment the `labels` block in `docker-compose.yml` and set `DADS_DOMAIN` in `.env`:

```bash
# In dads-ui/.env
DADS_DOMAIN=dads.example.com
```

Then rebuild: `docker compose up --build -d`

---

### Environment variables (container)

| Variable | Default | Description |
|----------|---------|-------------|
| `LISTEN_ADDR` | `:8080` | Host:port the server binds to |
| `TOOLKIT_ROOT` | `/toolkit` | Path to the mounted toolkit root |
| `WORKSPACES_DIR` | `/toolkit/workspaces` | Path to the workspaces directory |
| `TEMPLATES_DIR` | `/toolkit/templates` | Path to stack templates |
| `DATA_DIR` | `/data` | SQLite DB location (mount a persistent volume here) |
| `JWT_SECRET` | — | **Required.** Long random string for signing JWTs |

### Volume mounts (docker-compose.yml)

| Mount | Mode | Purpose |
|-------|------|---------|
| `../` → `/toolkit` | `ro` | Toolkit scripts and templates |
| `../workspaces` → `/toolkit/workspaces` | `rw` | Workspaces — `run.sh` runs here |
| `/var/run/docker.sock` | `rw` | Docker socket for all container operations |
| `dads-ui-data` → `/data` | `rw` | SQLite DB persistence across restarts |

### Putting it behind Traefik

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.dads-ui.rule=Host(`dads.example.com`)
  - traefik.http.routers.dads-ui.tls.certresolver=letsencrypt
  - traefik.http.services.dads-ui.loadbalancer.server.port=8080
networks:
  - traefik_net

networks:
  traefik_net:
    external: true
```

Remove the `ports` mapping from the service — Traefik handles ingress and TLS.

### Development mode (without Docker)

```bash
# Terminal 1 — Go backend (Go 1.22+)
cd dads-ui/backend
go run ./cmd/server

# Terminal 2 — React dev server (Vite, with HMR + API proxy to :8080)
cd dads-ui/frontend
npm install
npm run dev
# → http://localhost:5173
```

Vite proxies `/api` and WebSocket paths to `localhost:8080` automatically.

---

## 26. Troubleshooting

### `./run.sh` prints `\033[1m` literally

Your terminal is rendering raw escape codes. This should be fixed in the current version of `lib.sh` (uses `$'...'` ANSI-C quoting). If you have an older generated `run.sh`, re-generate it:

```bash
# From the toolkit root
./init_workspace.sh   # or re-bootstrap individual envs
```

### `realpath: illegal option -- m`

macOS's `realpath` doesn't support `-m`. Fixed in `init_workspace.sh` (uses `python3 -c os.path.normpath` instead). Update your copy of `init_workspace.sh` from the toolkit.

### `bad array subscript` or `declare -A` errors

The toolkit requires Bash ≥ 3.2 and avoids all Bash 4+ features. If you see these errors, a regression was introduced — open an issue and include the script name and line number.

### Workspace already exists warning

```
⚠  Workspace already exists: workspaces/<project>
```

Running `init_workspace.sh` again on an existing workspace prompts for confirmation. Existing `.env` files are preserved (secrets are not overwritten). Pass `--regen-env` to `bootstrap.sh` if you want to regenerate `.env` from scratch.

### Image not found during promote

```
Error: manifest for registry/project-backend:2.1.0-build.47-stage not found
```

The source image was never pushed. Run `./run.sh build <src_env> --push` first, then promote.

### Port already in use

Each environment must have a unique `http_port`. Check your `config.json` and ensure no two environments share a port. Run `docker ps` to see what's currently bound.

### jq not found

Install `jq`: `brew install jq` (macOS) or `apt install jq` / `yum install jq` (Linux). It is required by all engine scripts.
