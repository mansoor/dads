# =============================================================================
# Stage 1 — Build React frontend
# =============================================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build
# Output lands in ../backend/cmd/server/dist (per vite.config.js)


# =============================================================================
# Stage 2 — Build Go binary
# =============================================================================
FROM golang:1.25-alpine AS go-builder

RUN apk add --no-cache git

WORKDIR /app/backend

# Copy all source first so go mod tidy can resolve imports
COPY backend/ ./
# Copy the compiled frontend so embed.FS can include it
COPY --from=frontend-builder /app/backend/cmd/server/dist ./cmd/server/dist

# go.sum is not committed — generate it here from the full source tree
RUN go mod tidy

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /dads-ui ./cmd/server


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

COPY --from=go-builder /dads-ui /usr/local/bin/dads-ui

# Persistent data directory (SQLite DB lives here)
VOLUME ["/data"]

EXPOSE 8080

ENV LISTEN_ADDR=":8080" \
    TOOLKIT_ROOT="/toolkit" \
    WORKSPACES_DIR="/toolkit/workspaces" \
    DATA_DIR="/data"

ENTRYPOINT ["/usr/local/bin/dads-ui"]
