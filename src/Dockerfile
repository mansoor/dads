# =============================================================================
# Build context is the REPO ROOT (see docker-compose.yml). This lets the runtime
# image bake in scripts/ + templates/ + init_workspace.sh, so the toolkit code
# no longer needs to be live-mounted (Phase 6.5d single-image distribution).
# =============================================================================

# =============================================================================
# Stage 1 — Build React frontend
# =============================================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY src/frontend/package*.json ./
RUN npm install

COPY src/frontend/ ./
RUN npm run build
# Output lands in ../backend/cmd/server/dist (per vite.config.js)


# =============================================================================
# Stage 2 — Build Go binary
# =============================================================================
FROM golang:1.25-alpine AS go-builder

RUN apk add --no-cache git

WORKDIR /app/backend

# Copy all source first so go mod tidy can resolve imports
COPY src/backend/ ./
# Copy the compiled frontend so embed.FS can include it
COPY --from=frontend-builder /app/backend/cmd/server/dist ./cmd/server/dist

# go.sum is not committed — generate it here from the full source tree
RUN go mod tidy

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /dads ./cmd/server


# =============================================================================
# Stage 3 — Minimal runtime image
# =============================================================================
FROM alpine:3.19

# Install all tools required by run.sh scripts:
#   docker-cli         — docker ps / pull / exec
#   docker-cli-compose — 'docker compose' v2 plugin (scripts use `docker compose`, not docker-compose)
#   jq                 — config.json parsing throughout all scripts
#   curl               — healthchecks, image-check.sh
#   git                — sync command
#   openssl            — secret generation in env-gen.sh
#   postgresql-client  — pg_dump for backup
#   mariadb-client     — mysqldump for backup
#   bash / coreutils / tzdata / ca-certificates — shell runtime
RUN apk add --no-cache \
    bash \
    coreutils \
    ca-certificates \
    tzdata \
    docker-cli \
    docker-cli-compose \
    jq \
    curl \
    git \
    openssl \
    postgresql-client \
    mariadb-client

COPY --from=go-builder /dads /usr/local/bin/dads

# Bake the toolkit into the image (Phase 6.5d). Scripts are baked as code; the
# workspaces/ and templates/ directories are still bind-mounted as rw DATA in
# docker-compose.yml, so they overlay these baked copies at runtime (the baked
# templates serve as a seed for fresh installs).
COPY scripts/           /toolkit/scripts/
COPY templates/         /toolkit/templates/
COPY init_workspace.sh  /toolkit/init_workspace.sh

# Persistent data directory (SQLite DB lives here)
VOLUME ["/data"]

EXPOSE 8080

ENV LISTEN_ADDR=":8080" \
    TOOLKIT_ROOT="/toolkit" \
    WORKSPACES_DIR="/toolkit/workspaces" \
    DATA_DIR="/data"

ENTRYPOINT ["/usr/local/bin/dads"]
