# DADS — Docker App Deployment Simplified

> **Yes, it's called DADS.** And like a good dad, it does all the heavy lifting without complaining, remembers exactly how everything was set up, and gets quietly upset if you don't follow the instructions. Unlike your actual dad, it won't ask why you're still using `docker run` manually in 2025.

A Bash-based toolkit for scaffolding, building, and operating multi-environment Docker application stacks. Run the wizard once to generate a self-contained workspace for your project, then use a single `run.sh` entry point to build, deploy, promote, back up, and manage it across dev, stage, and prod.

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
13. [Backup & Restore](#13-backup--restore)
14. [Git Sync](#14-git-sync)
15. [Supported Stacks](#15-supported-stacks)
16. [Maintenance — Adding a New Stack](#16-maintenance--adding-a-new-stack)
17. [Maintenance — Adding a New Environment](#17-maintenance--adding-a-new-environment)
18. [Maintenance — Updating Dependency Versions](#18-maintenance--updating-dependency-versions)
19. [Traefik vs Direct Port Routing](#19-traefik-vs-direct-port-routing)
20. [Troubleshooting](#20-troubleshooting)

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
│   ├── sync.sh                     # Git pull + build + deploy
│   └── defaults/
│       └── config.json             # Default versions (used before workspace exists)
└── templates/
    ├── dockerfiles/
    │   ├── laravel/
    │   │   ├── Dockerfile          # Multi-stage prod build (PHP-FPM)
    │   │   ├── Dockerfile.dev      # Dev build with Xdebug + Composer
    │   │   ├── .dockerignore       # Strict: excludes vendor, tests, CI config
    │   │   └── .dockerignore.dev   # Loose: excludes only vendor and built artefacts
    │   ├── nodejs/                 # Express / Fastify / etc.
    │   ├── nextjs/                 # Next.js with standalone output
    │   └── react/                  # React / Vite SPA → served by Nginx
    └── nginx/
        ├── laravel.conf            # FastCGI pass to PHP-FPM
        ├── nodejs.conf             # Upstream proxy + WebSocket support
        ├── nextjs.conf             # Upstream proxy + HMR WebSocket
        └── react.conf              # Static file server with SPA fallback
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
./run.sh start   <env>                   # Deploy / bring up the stack
./run.sh stop    <env>                   # Tear down the stack
./run.sh restart <env> [service]         # Rolling restart (all or one service)
./run.sh refresh <env>                   # Regenerate compose file + redeploy
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
./run.sh logs    <env>                   # Follow all logs
./run.sh logs    <env> backend           # Follow one service's logs
./run.sh exec    <env> backend bash      # Shell into the backend container
./run.sh backup  <env>                   # Run all backups (db + files)
./run.sh backup  <env> db               # Database backup only
./run.sh backup  <env> files            # Volume backup only
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

- **PostgreSQL** — live `pg_dump` via `docker exec` → `db.sql.gz`
- **MySQL** — live `mysqldump` via `docker exec` → `db.sql.gz`
- **Named volumes** — `docker run alpine tar czf` per volume → `<volume>.tar.gz`
- **Garage** — both `garage_data` and `garage_meta` volumes

### Restore (manual)

```bash
# Database
gunzip < backups/prod/2025-06-01_14-30-00/db.sql.gz \
  | docker exec -i <db_container> psql -U <user> <dbname>

# Volume
docker run --rm -v <volume>:/target -v $(pwd):/backup alpine \
  tar xzf /backup/backups/prod/2025-06-01_14-30-00/uploads.tar.gz -C /target
```

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

## 16. Maintenance — Adding a New Stack

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

## 17. Maintenance — Adding a New Environment

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

## 18. Maintenance — Updating Dependency Versions

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

## 19. Traefik vs Direct Port Routing

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

## 20. Troubleshooting

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
