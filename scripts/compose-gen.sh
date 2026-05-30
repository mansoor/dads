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
deploy_block() {
  local replicas="${1:-1}"
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
    echo "    restart: unless-stopped"
  fi
}

# ── Helper: traefik labels ────────────────────────────────────────────────────
traefik_labels() {
  local router="$1"
  local host="$2"
  local port="${3:-80}"
  if [[ "$TRAEFIK_ENABLED" == "true" ]]; then
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

  # Emit top-level named volumes for any image that uses a named-volume mount.
  # A named volume is a host path that does NOT start with . / or $ (not a path or ${VAR}).
  IMAGE_LEN="$(cfg_get '.images | length')"
  _has_named_vol=false
  for _idx in $(seq 0 $((IMAGE_LEN - 1))); do
    _vols="$(cfg_get ".images[${_idx}].volumes[]? // empty" 2>/dev/null || true)"
    while IFS= read -r _vol; do
      [[ -z "$_vol" ]] && continue
      _host="${_vol%%:*}"
      if [[ "$_host" != .* && "$_host" != /* && "$_host" != '$'* ]]; then
        _has_named_vol=true
        echo "volumes:"
        break 2
      fi
    done <<< "$_vols"
  done
  if $_has_named_vol; then
    for _idx in $(seq 0 $((IMAGE_LEN - 1))); do
      _svc_name="$(cfg_get ".images[${_idx}].name")"
      _vols="$(cfg_get ".images[${_idx}].volumes[]? // empty" 2>/dev/null || true)"
      while IFS= read -r _vol; do
        [[ -z "$_vol" ]] && continue
        _host="${_vol%%:*}"
        if [[ "$_host" != .* && "$_host" != /* && "$_host" != '$'* ]]; then
          echo "  ${PREFIX}_${_svc_name}_${_host}:"
        fi
      done <<< "$_vols"
    done
    echo
  fi

  echo "services:"
  echo

  for _idx in $(seq 0 $((IMAGE_LEN - 1))); do
    _svc_name="$(cfg_get  ".images[${_idx}].name")"
    _img_ref="$(cfg_get   ".images[${_idx}].image")"
    _img_tag="$(cfg_get   ".images[${_idx}].tag")"
    _img_port="$(cfg_get  ".images[${_idx}].port")"
    _img_hport="$(cfg_get ".images[${_idx}].host_port // \"\"")"
    _img_vols="$(cfg_get  ".images[${_idx}].volumes[]? // empty" 2>/dev/null || true)"

    echo "  # ── ${_svc_name} (${_img_ref}:${_img_tag}) ─────────────────────────────────────────"
    echo "  ${PREFIX}_${_svc_name}:"
    echo "    image: ${_img_ref}:${_img_tag}"
    echo "    container_name: ${PREFIX}_${_svc_name}"
    echo "    env_file: .env"

    # Networks — services with a host_port get the Traefik network too
    echo "    networks:"
    echo "      - ${PREFIX}_net"
    if [[ -n "$_img_hport" && "$TRAEFIK_ENABLED" == "true" ]]; then
      echo "      - ${TRAEFIK_NETWORK}"
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
      # Named volume if host part has no leading . / or ${ (not a path or var-based path)
      if [[ "$_host" != .* && "$_host" != /* && "$_host" != '$'* ]]; then
        echo "      - ${PREFIX}_${_svc_name}_${_host}:${_rest}"
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

    # Ports / Traefik labels
    # Services with a host_port always get a ports: mapping.
    # Traefik labels are added on top when Traefik is enabled (both can coexist).
    if [[ -n "$_img_hport" ]]; then
      echo "    ports:"
      echo "      - \"${_img_hport}:${_img_port}\""
      if [[ "$TRAEFIK_ENABLED" == "true" ]]; then
        traefik_labels "${PREFIX}_${_svc_name}" "$DOMAIN" "$_img_port"
      fi
    else
      # No host_port — expose internally so other services can reach it
      echo "    expose:"
      echo "      - \"${_img_port}\""
    fi

    deploy_block "1"
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

  if [[ "$DATABASE" == "postgres" ]]; then
    printf "    depends_on:\n      - ${PREFIX}_postgres\n"
  elif [[ "$DATABASE" == "mysql" ]]; then
    printf "    depends_on:\n      - ${PREFIX}_mysql\n"
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
  port_mapping "$HTTP_PORT" "80"
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
