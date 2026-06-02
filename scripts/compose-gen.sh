#!/usr/bin/env bash
# =============================================================================
# compose-gen.sh — Generate docker-compose.yml (or swarm stack file) for an env
# Usage: ./scripts/compose-gen.sh <env>
# Respects WORKSPACE_ROOT env var (set by run.sh or init_workspace.sh).
# =============================================================================

source "$(dirname "$0")/lib.sh"
require_cmd jq

ENV="${1:-}"
[[ -n "$ENV" ]] || die "Usage: compose-gen.sh <env>"
validate_env "$ENV"

log_section "Generating docker-compose.yml for '$ENV'"

# ── Read config ───────────────────────────────────────────────────────────────
PROJECT="$(cfg_get '.project.name')"
REGISTRY="$(cfg_get '.project.registry')"
PROJECT_TYPE="$(cfg_get '.project.type // "custom"')"
TAG="$(version_string)-${ENV}"
PREFIX="${PROJECT}_${ENV}"

BACKEND="$(cfg_env_get "$ENV" '.backend')"
FRONTEND_ENABLED="$(cfg_env_get "$ENV" '.frontend_enabled')"
FRONTEND="$(cfg_env_get "$ENV" '.frontend')"
DATABASE="$(cfg_env_get "$ENV" '.database')"
REDIS_ENABLED="$(cfg_env_get "$ENV" '.redis_enabled')"
GARAGE_ENABLED="$(cfg_env_get "$ENV" '.garage_enabled')"
TRAEFIK_ENABLED="$(cfg_env_get "$ENV" '.traefik_enabled')"
TRAEFIK_NETWORK="$(cfg_env_get "$ENV" '.traefik_network')"
SSL_ENABLED="$(cfg_env_get "$ENV" '.ssl_enabled // false')"
DEPLOYMENT="$(cfg_env_get "$ENV" '.deployment')"
DOMAIN="$(cfg_env_get "$ENV" '.domain')"
HTTP_PORT="$(cfg_env_get "$ENV" '.http_port')"
BACKEND_REPLICAS="$(cfg_env_get "$ENV" '.replicas.backend')"
FRONTEND_REPLICAS="$(cfg_env_get "$ENV" '.replicas.frontend')"

# ── Read versions from config (with defaults) ─────────────────────────────────
VER_POSTGRES="$(cfg_version 'postgres' '15-alpine')"
VER_MYSQL="$(cfg_version 'mysql' '8.0')"
VER_REDIS="$(cfg_version 'redis' '7-alpine')"
VER_GARAGE="$(cfg_version 'garage' 'v1.0.1')"
VER_GARAGE_WEBUI="$(cfg_version 'garage_webui' 'latest')"
VER_NGINX="$(cfg_version 'nginx' '1.25-alpine')"

IS_SWARM=false
[[ "$DEPLOYMENT" == "swarm" ]] && IS_SWARM=true

OUT_FILE="$(compose_file "$ENV")"
mkdir -p "$(dirname "$OUT_FILE")"

# ── Helper: deploy/restart block ──────────────────────────────────────────────
# Args: <replicas> [restart_policy]
# restart_policy defaults to "unless-stopped" for compose, not used for swarm
#   (swarm uses deploy.restart_policy.condition instead)
deploy_block() {
  local replicas="${1:-1}"
  local restart_policy="${2:-unless-stopped}"
  if $IS_SWARM; then
    cat <<EOF
    deploy:
      replicas: ${replicas}
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
      update_config:
        parallelism: 1
        delay: 10s
        failure_action: rollback
EOF
  else
    echo "    restart: ${restart_policy}"
  fi
}

# ── Helper: traefik labels ────────────────────────────────────────────────────
# Usage: traefik_labels <router_name> <hostname> [internal_port]
#
# Three modes controlled by TRAEFIK_ENABLED and SSL_ENABLED:
#   TRAEFIK_ENABLED=false → no labels emitted
#   TRAEFIK_ENABLED=true, SSL_ENABLED=false → single HTTP router (web entrypoint)
#   TRAEFIK_ENABLED=true, SSL_ENABLED=true  → HTTPS router with Let's Encrypt cert;
#       HTTP traffic is redirected to HTTPS via the global redirect configured
#       in Traefik's entrypoint (set in dads-ui/docker-compose.yml).
traefik_labels() {
  local router="$1"
  local host="$2"
  local port="${3:-80}"

  [[ "$TRAEFIK_ENABLED" == "true" ]] || return 0

  if [[ "$SSL_ENABLED" == "true" ]]; then
    # HTTPS router — Traefik issues a Let's Encrypt cert for this domain.
    # HTTP→HTTPS redirect is handled globally by the Traefik entrypoint config.
    cat <<EOF
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.${router}.rule=Host(\`${host}\`)"
      - "traefik.http.routers.${router}.entrypoints=websecure"
      - "traefik.http.routers.${router}.tls=true"
      - "traefik.http.routers.${router}.tls.certresolver=letsencrypt"
      - "traefik.http.services.${router}.loadbalancer.server.port=${port}"
EOF
  else
    # HTTP-only router — no cert, no redirect.
    cat <<EOF
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.${router}.rule=Host(\`${host}\`)"
      - "traefik.http.routers.${router}.entrypoints=web"
      - "traefik.http.services.${router}.loadbalancer.server.port=${port}"
EOF
  fi
}

# ── Helper: port mapping (always included — Traefik + direct access can coexist)
port_mapping() {
  local host_port="$1"
  local container_port="$2"
  echo "    ports:"
  echo "      - \"${host_port}:${container_port}\""
}

# ── Helper: healthcheck block ─────────────────────────────────────────────────
# Usage: healthcheck_block "<CMD-SHELL command>" [interval] [timeout] [retries] [start_period] [start_interval]
healthcheck_block() {
  local cmd="$1"
  local interval="${2:-30s}"
  local timeout="${3:-10s}"
  local retries="${4:-3}"
  local start_period="${5:-30s}"
  local start_interval="${6:-}"
  # Escape any literal " in the command so the YAML flow sequence stays valid.
  local safe_cmd="${cmd//\"/\\\"}"
  cat <<HC
    healthcheck:
      test: ["CMD-SHELL", "${safe_cmd}"]
      interval: ${interval}
      timeout: ${timeout}
      retries: ${retries}
      start_period: ${start_period}
HC
  # start_interval is only valid in Docker Engine 25+ / Compose spec 3.x+
  # Only emit it when explicitly configured to avoid errors on older engines.
  if [[ -n "$start_interval" ]]; then
    echo "      start_interval: ${start_interval}"
  fi
}

# ── Build compose file ────────────────────────────────────────────────────────
{

cat <<HEADER
# ============================================================
# docker-compose.yml — ${ENV} environment
# Project : ${PROJECT}  (type: ${PROJECT_TYPE})
# Version : $(version_string)
# Generated: $(date -u '+%Y-%m-%d %H:%M:%S UTC')
# Regenerate: ./run.sh refresh ${ENV}
# ============================================================

HEADER


# ── Networks ──────────────────────────────────────────────────────────────────
echo "networks:"
echo "  ${PREFIX}_net:"
echo "    driver: bridge"
if [[ "$TRAEFIK_ENABLED" == "true" ]]; then
  echo "  ${TRAEFIK_NETWORK}:"
  echo "    external: true"
fi
echo

if [[ "$PROJECT_TYPE" == "image" ]]; then
  # ════════════════════════════════════════════════════════════════════════════
  # IMAGE STACK — services generated from config.json .images[]
  # ════════════════════════════════════════════════════════════════════════════

  # Emit top-level named volumes block.
  # Sources from two places:
  #   1. images[].volumes[] entries whose host part is NOT a path (no . / $ prefix)
  #   2. named_volumes[] in config.json — user-declared extra volumes from the wizard
  # Bind mounts (./... or /...) and env-var paths (${...}) are NOT declared here.
  IMAGE_LEN="$(cfg_get '.images | length')"
  _seen_vols=" "
  _has_named_vol=false

  # Helper: emit a named volume key once
  _emit_named_vol() {
    local _vkey="$1"
    if [[ "$_seen_vols" != *" ${_vkey} "* ]]; then
      if ! $_has_named_vol; then
        echo "volumes:"
        _has_named_vol=true
      fi
      echo "  ${_vkey}:"
      _seen_vols="${_seen_vols}${_vkey} "
    fi
  }

  # 1. Named volumes from image service mounts
  for _idx in $(seq 0 $((IMAGE_LEN - 1))); do
    _vols="$(cfg_get ".images[${_idx}].volumes[]? // empty" 2>/dev/null || true)"
    while IFS= read -r _vol; do
      [[ -z "$_vol" ]] && continue
      _host="${_vol%%:*}"
      if [[ "$_host" != .* && "$_host" != /* && "$_host" != '$'* ]]; then
        _emit_named_vol "${PREFIX}_${_host}"
      fi
    done <<< "$_vols"
  done

  # 2. Extra named volumes declared in config.json named_volumes[]
  _nv_len="$(cfg_get '.named_volumes | length' 2>/dev/null || echo 0)"
  for _nv_idx in $(seq 0 $((_nv_len - 1))); do
    _nv_name="$(cfg_get ".named_volumes[${_nv_idx}].name // \"\"" 2>/dev/null || true)"
    [[ -z "$_nv_name" ]] && continue
    # Only emit if it looks like a named volume (not a path the user accidentally put here)
    if [[ "$_nv_name" != .* && "$_nv_name" != /* ]]; then
      _emit_named_vol "${PREFIX}_${_nv_name}"
    fi
  done

  $_has_named_vol && echo

  echo "services:"
  echo

  for _idx in $(seq 0 $((IMAGE_LEN - 1))); do
    _svc_name="$(cfg_get   ".images[${_idx}].name")"
    _img_ref="$(cfg_get     ".images[${_idx}].image")"
    _img_tag="$(cfg_get     ".images[${_idx}].tag")"
    _img_port="$(cfg_get    ".images[${_idx}].port")"
    _img_hport="$(cfg_get   ".images[${_idx}].host_port // \"\"")"
    _img_hc="$(cfg_get      ".images[${_idx}].healthcheck // \"\"")"
    _img_cmd="$(cfg_get     ".images[${_idx}].command // \"\"")"
    _img_vols="$(cfg_get    ".images[${_idx}].volumes[]? // empty" 2>/dev/null || true)"
    _img_xports="$(cfg_get  ".images[${_idx}].extra_ports[]? // empty" 2>/dev/null || true)"
    _img_restart="$(cfg_get ".images[${_idx}].restart // \"unless-stopped\"")"

    # Healthcheck config with per-image overrides (falls back to sensible defaults)
    _hc_interval="$(cfg_get        ".images[${_idx}].healthcheck_config.interval       // \"30s\"")"
    _hc_timeout="$(cfg_get         ".images[${_idx}].healthcheck_config.timeout        // \"10s\"")"
    _hc_retries="$(cfg_get         ".images[${_idx}].healthcheck_config.retries        // \"3\"")"
    _hc_start="$(cfg_get           ".images[${_idx}].healthcheck_config.start_period   // \"40s\"")"
    _hc_start_interval="$(cfg_get  ".images[${_idx}].healthcheck_config.start_interval // \"\"")"

    echo "  # ── ${_svc_name} (${_img_ref}:${_img_tag}) ─────────────────────────────────────────"
    echo "  ${PREFIX}_${_svc_name}:"
    echo "    image: ${_img_ref}:${_img_tag}"
    echo "    container_name: ${PREFIX}_${_svc_name}"
    echo "    env_file: .env"

    # command: (only emitted when non-empty)
    if [[ -n "$_img_cmd" ]]; then
      echo "    command: '${_img_cmd}'"
    fi

    # Networks — long-form map with alias = short service name so inter-service
    # DNS works by short name (e.g. "db", "redis") rather than full prefixed name.
    echo "    networks:"
    echo "      ${PREFIX}_net:"
    echo "        aliases:"
    echo "          - ${_svc_name}"
    if [[ -n "$_img_hport" && "$TRAEFIK_ENABLED" == "true" ]]; then
      echo "      ${TRAEFIK_NETWORK}: {}"
    fi

    # depends_on — condition: service_healthy if dependency has a healthcheck,
    # otherwise condition: service_started
    _img_deps="$(cfg_get ".images[${_idx}].depends_on[]? // empty" 2>/dev/null || true)"
    _dep_count=0
    while IFS= read -r _d; do [[ -z "$_d" ]] && continue; _dep_count=$((_dep_count+1)); done <<< "$_img_deps"
    if [[ "$_dep_count" -gt 0 ]]; then
      echo "    depends_on:"
      while IFS= read -r _dep; do
        [[ -z "$_dep" ]] && continue
        # Look up whether the dependency has a healthcheck configured
        _dep_hc=""
        for _di in $(seq 0 $((IMAGE_LEN - 1))); do
          _dn="$(cfg_get ".images[${_di}].name")"
          if [[ "$_dn" == "$_dep" ]]; then
            _dep_hc="$(cfg_get ".images[${_di}].healthcheck // \"\"")"
            break
          fi
        done
        echo "      ${PREFIX}_${_dep}:"
        if [[ -n "$_dep_hc" ]]; then
          echo "        condition: service_healthy"
        else
          echo "        condition: service_started"
        fi
      done <<< "$_img_deps"
    fi

    # Volumes
    _first_vol=true
    while IFS= read -r _vol; do
      [[ -z "$_vol" ]] && continue
      if $_first_vol; then
        echo "    volumes:"
        _first_vol=false
      fi
      _host="${_vol%%:*}"
      _rest="${_vol#*:}"
      # Named volume: host part has no leading . / or $ (not a bind mount or env-var path)
      if [[ "$_host" != .* && "$_host" != /* && "$_host" != '$'* ]]; then
        echo "      - ${PREFIX}_${_host}:${_rest}"
      else
        echo "      - ${_vol}"
      fi
    done <<< "$_img_vols"

    # Per-image environment variables — supports static values and ${VAR} interpolation
    _img_env_len="$(cfg_get ".images[${_idx}].env_vars | length" 2>/dev/null || echo 0)"
    if [[ "$_img_env_len" -gt 0 ]]; then
      echo "    environment:"
      while IFS= read -r _ekey; do
        [[ -z "$_ekey" ]] && continue
        _eval="$(cfg_get ".images[${_idx}].env_vars[\"${_ekey}\"]")"
        echo "      - ${_ekey}=${_eval}"
      done < <(cfg_get ".images[${_idx}].env_vars | keys[]" 2>/dev/null || true)
    fi

    # Ports — emit ports: block if host_port OR extra_ports are specified.
    # Traefik labels and port mapping coexist (Traefik uses port for routing, direct
    # port binding allows local access too).
    _has_ext_ports=false
    [[ -n "$_img_hport" ]] && _has_ext_ports=true
    if [[ "$_has_ext_ports" == "false" ]]; then
      while IFS= read -r _ep; do
        [[ -z "$_ep" ]] && continue
        _has_ext_ports=true; break
      done <<< "$_img_xports"
    fi

    if [[ "$_has_ext_ports" == "true" ]]; then
      echo "    ports:"
      [[ -n "$_img_hport" ]] && echo "      - \"${_img_hport}:${_img_port}\""
      while IFS= read -r _ep; do
        [[ -z "$_ep" ]] && continue
        echo "      - \"${_ep}\""
      done <<< "$_img_xports"
      if [[ -n "$_img_hport" && "$TRAEFIK_ENABLED" == "true" ]]; then
        traefik_labels "${PREFIX}_${_svc_name}" "$DOMAIN" "$_img_port"
      fi
    else
      # No external port — expose internally so other containers can connect
      echo "    expose:"
      echo "      - \"${_img_port}\""
    fi

    # Healthcheck (only emitted when a test command was specified)
    if [[ -n "$_img_hc" ]]; then
      healthcheck_block "$_img_hc" "$_hc_interval" "$_hc_timeout" "$_hc_retries" "$_hc_start" "$_hc_start_interval"
    fi

    deploy_block "1" "${_img_restart}"

    # extra_compose (service-level): raw YAML appended to this service — applies to ALL envs.
    # Stored in config.json images[n].extra_compose.
    # Each line is indented 4 spaces to sit correctly under the service key.
    _img_extra="$(cfg_get ".images[${_idx}].extra_compose // empty" 2>/dev/null || true)"
    if [[ -n "$_img_extra" && "$_img_extra" != "null" && "$_img_extra" != "empty" ]]; then
      echo "$_img_extra" | sed 's/^/    /'
    fi

    # extra_compose (env-level override): raw YAML appended AFTER the service-level block.
    # Stored in config.json environments[env].service_overrides[name].extra_compose.
    # Use for env-specific tuning: resource limits, logging, replica counts, etc.
    # Env-level keys take precedence over service-level on conflict (last definition wins).
    _env_extra="$(cfg_get ".environments[\"${ENV}\"].service_overrides[\"${_svc_name}\"].extra_compose // empty" 2>/dev/null || true)"
    if [[ -n "$_env_extra" && "$_env_extra" != "null" && "$_env_extra" != "empty" ]]; then
      echo "$_env_extra" | sed 's/^/    /'
    fi

    echo
  done

else
  # ════════════════════════════════════════════════════════════════════════════
  # CUSTOM STACK — backend + nginx + optional database / redis / garage / frontend
  # ════════════════════════════════════════════════════════════════════════════

  # ── Volumes ─────────────────────────────────────────────────────────────────
  echo "volumes:"
  [[ "$DATABASE" == "postgres" ]] && echo "  ${PREFIX}_pg_data:"
  [[ "$DATABASE" == "mysql" ]]    && echo "  ${PREFIX}_mysql_data:"
  [[ "$REDIS_ENABLED" == "true" ]] && echo "  ${PREFIX}_redis_data:"
  if [[ "$GARAGE_ENABLED" == "true" ]]; then
    echo "  ${PREFIX}_garage_data:"
    echo "  ${PREFIX}_garage_meta:"
  fi
  echo "  ${PREFIX}_uploads:"
  echo

  # ── Services ────────────────────────────────────────────────────────────────
  echo "services:"
  echo

  # ── Backend ─────────────────────────────────────────────────────────────────
  cat <<SVC
  # ── Backend (${BACKEND}) ──────────────────────────────────────────────────────
  ${PREFIX}_backend:
    image: \${BACKEND_IMAGE:-${REGISTRY}/${PROJECT}-backend:${TAG}}
    container_name: ${PREFIX}_backend
    env_file: .env
    volumes:
      - ${PREFIX}_uploads:/app/storage/uploads
    networks:
      - ${PREFIX}_net
SVC

  # depends_on with service_healthy so backend waits for DB to pass healthcheck
  if [[ "$DATABASE" == "postgres" ]]; then
    printf "    depends_on:\n      ${PREFIX}_postgres:\n        condition: service_healthy\n"
  elif [[ "$DATABASE" == "mysql" ]]; then
    printf "    depends_on:\n      ${PREFIX}_mysql:\n        condition: service_healthy\n"
  fi

  if [[ "$BACKEND" == "nodejs" ]]; then
    healthcheck_block "wget -qO- http://localhost:3000/health >/dev/null 2>&1 || curl -sf http://localhost:3000/health >/dev/null 2>&1 || exit 1" "30s" "10s" "3" "40s"
  else
    # PHP-FPM: check that PHP is operational (FPM listens on 9000 but has no HTTP)
    healthcheck_block "php -r 'exit(0);' 2>/dev/null || exit 1" "30s" "5s" "3" "60s"
  fi
  deploy_block "$BACKEND_REPLICAS"
  echo

  # ── Nginx ───────────────────────────────────────────────────────────────────
  cat <<SVC
  # ── Nginx ──────────────────────────────────────────────────────────────────
  ${PREFIX}_nginx:
    image: nginx:${VER_NGINX}
    container_name: ${PREFIX}_nginx
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - ${PREFIX}_uploads:/var/www/uploads:ro
    depends_on:
      - ${PREFIX}_backend
    networks:
      - ${PREFIX}_net
SVC
  if [[ "$TRAEFIK_ENABLED" == "true" ]]; then
    echo "      - ${TRAEFIK_NETWORK}"
  fi
  traefik_labels "${PREFIX}_nginx" "$DOMAIN" "80"
  # Only bind host port when Traefik is not handling ingress.
  # With Traefik ON, Nginx is reachable on the Docker network via port 80 — no host binding needed.
  if [[ "$TRAEFIK_ENABLED" != "true" ]]; then
    port_mapping "$HTTP_PORT" "80"
  fi
  healthcheck_block "curl -sf http://localhost/ -o /dev/null || exit 1" "30s" "5s" "3" "20s"
  deploy_block "1"
  echo

  # ── PostgreSQL ──────────────────────────────────────────────────────────────
  if [[ "$DATABASE" == "postgres" ]]; then
  cat <<SVC
  # ── PostgreSQL ${VER_POSTGRES} ────────────────────────────────────────────────
  ${PREFIX}_postgres:
    image: postgres:${VER_POSTGRES}
    container_name: ${PREFIX}_postgres
    environment:
      POSTGRES_DB: \${POSTGRES_DB}
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - ${PREFIX}_pg_data:/var/lib/postgresql/data
    networks:
      - ${PREFIX}_net
SVC
  healthcheck_block "pg_isready -U \${POSTGRES_USER} -d \${POSTGRES_DB}" "10s" "5s" "5" "30s"
  deploy_block "1"
  echo
  fi

  # ── MySQL ───────────────────────────────────────────────────────────────────
  if [[ "$DATABASE" == "mysql" ]]; then
  cat <<SVC
  # ── MySQL ${VER_MYSQL} ──────────────────────────────────────────────────────
  ${PREFIX}_mysql:
    image: mysql:${VER_MYSQL}
    container_name: ${PREFIX}_mysql
    environment:
      MYSQL_DATABASE: \${MYSQL_DATABASE}
      MYSQL_USER: \${MYSQL_USER}
      MYSQL_PASSWORD: \${MYSQL_PASSWORD}
      MYSQL_ROOT_PASSWORD: \${MYSQL_ROOT_PASSWORD}
    command: --default-authentication-plugin=mysql_native_password
    volumes:
      - ${PREFIX}_mysql_data:/var/lib/mysql
    networks:
      - ${PREFIX}_net
SVC
  healthcheck_block "mysqladmin ping -h localhost --silent" "10s" "5s" "5" "30s"
  deploy_block "1"
  echo
  fi

  # ── Redis ───────────────────────────────────────────────────────────────────
  if [[ "$REDIS_ENABLED" == "true" ]]; then
  cat <<SVC
  # ── Redis ${VER_REDIS} ──────────────────────────────────────────────────────
  ${PREFIX}_redis:
    image: redis:${VER_REDIS}
    container_name: ${PREFIX}_redis
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - ${PREFIX}_redis_data:/data
    networks:
      - ${PREFIX}_net
SVC
  healthcheck_block "redis-cli ping | grep -q PONG || exit 1" "10s" "3s" "3" "10s"
  deploy_block "1"
  echo
  fi

  # ── Garage (S3-compatible storage) ──────────────────────────────────────────
  if [[ "$GARAGE_ENABLED" == "true" ]]; then
  cat <<SVC
  # ── Garage ${VER_GARAGE} (S3-compatible) ──────────────────────────────────────
  ${PREFIX}_garage:
    image: dxflrs/garage:${VER_GARAGE}
    container_name: ${PREFIX}_garage
    volumes:
      - ${PREFIX}_garage_data:/data
      - ${PREFIX}_garage_meta:/meta
      - ./garage.toml:/etc/garage.toml:ro
    environment:
      GARAGE_ADMIN_TOKEN: \${GARAGE_ADMIN_TOKEN}
    networks:
      - ${PREFIX}_net
SVC
  healthcheck_block "curl -sf http://localhost:3903/health -o /dev/null || exit 1" "30s" "5s" "3" "60s"
  deploy_block "1"
  echo

  cat <<SVC
  # ── Garage WebUI ─────────────────────────────────────────────────────────────
  ${PREFIX}_garage_webui:
    image: khofesh/garage-webui:${VER_GARAGE_WEBUI}
    container_name: ${PREFIX}_garage_webui
    environment:
      GARAGE_API_URL: http://${PREFIX}_garage:3900
      GARAGE_API_TOKEN: \${GARAGE_ADMIN_TOKEN}
    depends_on:
      - ${PREFIX}_garage
    networks:
      - ${PREFIX}_net
SVC
  deploy_block "1"
  echo
  fi

  # ── Frontend ─────────────────────────────────────────────────────────────────
  if [[ "$FRONTEND_ENABLED" == "true" ]]; then
  cat <<SVC
  # ── Frontend (${FRONTEND}) ────────────────────────────────────────────────────
  ${PREFIX}_frontend:
    image: \${FRONTEND_IMAGE:-${REGISTRY}/${PROJECT}-frontend:${TAG}}
    container_name: ${PREFIX}_frontend
    env_file: .env
    networks:
      - ${PREFIX}_net
SVC
  if [[ "$TRAEFIK_ENABLED" == "true" ]]; then
    echo "      - ${TRAEFIK_NETWORK}"
    traefik_labels "${PREFIX}_frontend" "app.${DOMAIN}" "3000"
  fi
  deploy_block "$FRONTEND_REPLICAS"
  echo
  fi

fi  # end PROJECT_TYPE branch

} > "$OUT_FILE"

log_success "docker-compose.yml written to $OUT_FILE"
