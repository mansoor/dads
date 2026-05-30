#!/usr/bin/env bash
# =============================================================================
# bootstrap.sh — Scaffold or re-scaffold a single environment inside a workspace
#
# Called by:
#   init_workspace.sh                    — initial workspace creation (WORKSPACE_ROOT exported)
#   run.sh init <env>          — re-scaffold after config changes
#
# Usage (direct):
#   WORKSPACE_ROOT=/path/to/workspace scripts/bootstrap.sh <env>
#
# What it generates inside WORKSPACE_ROOT/envs/<env>/:
#   .env.example  — annotated env file (secrets redacted)
#   .env          — generated if absent (existing secrets preserved on re-run)
#   nginx.conf    — rendered from templates/nginx/<backend>.conf
#   backend/Dockerfile + .dockerignore
#   frontend/Dockerfile + .dockerignore  (if frontend enabled)
#   docker-compose.yml
#   garage.toml   (if garage enabled)
# =============================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_cmd jq

ENV="${1:-}"
[[ -n "$ENV" ]] || { echo "Usage: scripts/bootstrap.sh <env> [--regen-env]"; exit 1; }
validate_env "$ENV"

REGEN_ENV=false
[[ "${2:-}" == "--regen-env" ]] && REGEN_ENV=true

# ── Helper: copy the right .dockerignore for this environment ─────────────────
# dev  → uses .dockerignore.dev (loose: source is bind-mounted)
# stage/prod → uses .dockerignore (strict: source baked into image)
# Falls back to the other variant if the preferred one doesn't exist.
copy_dockerignore() {
  local tmpl_dir="$1"
  local dest_dir="$2"
  local env="$3"

  local preferred fallback
  if [[ "$env" == "dev" ]]; then
    preferred="$tmpl_dir/.dockerignore.dev"
    fallback="$tmpl_dir/.dockerignore"
  else
    preferred="$tmpl_dir/.dockerignore"
    fallback="$tmpl_dir/.dockerignore.dev"
  fi

  if [[ -f "$preferred" ]]; then
    cp "$preferred" "$dest_dir/.dockerignore"
    log_dim "  .dockerignore ← $(basename "$preferred")"
  elif [[ -f "$fallback" ]]; then
    cp "$fallback" "$dest_dir/.dockerignore"
    log_warn ".dockerignore.$([ "$env" == "dev" ] && echo dev || echo prod) not found — using fallback"
  else
    log_warn "No .dockerignore found in $tmpl_dir — skipping"
  fi
}

bootstrap_env() {
  local env="$1"

  log_section "Bootstrapping '$env' → $WORKSPACE_ROOT"

  local out_dir
  out_dir="$(env_dir "$env")"
  mkdir -p "$out_dir"

  local project_type backend frontend frontend_enabled database garage_enabled project domain prefix
  project_type="$(cfg_get '.project.type // "custom"')"
  backend="$(cfg_env_get "$env" '.backend')"
  frontend="$(cfg_env_get "$env" '.frontend')"
  frontend_enabled="$(cfg_env_get "$env" '.frontend_enabled')"
  database="$(cfg_env_get "$env" '.database')"
  garage_enabled="$(cfg_env_get "$env" '.garage_enabled')"
  project="$(cfg_get '.project.name')"
  domain="$(cfg_env_get "$env" '.domain')"
  prefix="${project}_${env}"

  # ── 1. Generate .env ────────────────────────────────────────────────────────
  local env_file_path
  env_file_path="$(env_file "$env")"
  if [[ ! -f "$env_file_path" || "$REGEN_ENV" == "true" ]]; then
    bash "$SCRIPTS_DIR/env-gen.sh" "$env"
  else
    log_info ".env exists — skipping (use --regen-env to force)"
  fi

  if [[ "$project_type" == "image" ]]; then
    # ── Image stack: only compose + .env needed — no Dockerfiles or nginx ─────
    log_info "Image stack — skipping Dockerfiles and nginx config"

    # ── 2. docker-compose.yml (image type) ─────────────────────────────────────
    log_info "Generating docker-compose.yml..."
    bash "$SCRIPTS_DIR/compose-gen.sh" "$env"

    log_success "Environment '$env' bootstrapped (image stack)"
    echo
    return
  fi

  # ── Custom stack steps below ─────────────────────────────────────────────────

  # ── 2. Backend Dockerfile ────────────────────────────────────────────────────
  log_info "Installing backend Dockerfile ($backend)..."
  local be_tmpl_dir="$TEMPLATES_DIR/dockerfiles/$backend"
  [[ -d "$be_tmpl_dir" ]] || die "No Dockerfile template for backend '$backend': $be_tmpl_dir"

  local be_out_dir="$out_dir/backend"
  mkdir -p "$be_out_dir"

  local df_src="$be_tmpl_dir/Dockerfile"
  [[ "$env" == "dev" && -f "$be_tmpl_dir/Dockerfile.dev" ]] && df_src="$be_tmpl_dir/Dockerfile.dev"

  cp "$df_src" "$be_out_dir/Dockerfile"
  copy_dockerignore "$be_tmpl_dir" "$be_out_dir" "$env"
  log_success "Backend Dockerfile → $be_out_dir/Dockerfile"

  # ── 3. Frontend Dockerfile (if enabled) ──────────────────────────────────────
  if [[ "$frontend_enabled" == "true" ]]; then
    log_info "Installing frontend Dockerfile ($frontend)..."
    local fe_tmpl_dir="$TEMPLATES_DIR/dockerfiles/$frontend"
    [[ -d "$fe_tmpl_dir" ]] || die "No Dockerfile template for frontend '$frontend': $fe_tmpl_dir"

    local fe_out_dir="$out_dir/frontend"
    mkdir -p "$fe_out_dir"

    local fe_df_src="$fe_tmpl_dir/Dockerfile"
    [[ "$env" == "dev" && -f "$fe_tmpl_dir/Dockerfile.dev" ]] && fe_df_src="$fe_tmpl_dir/Dockerfile.dev"

    cp "$fe_df_src" "$fe_out_dir/Dockerfile"
    copy_dockerignore "$fe_tmpl_dir" "$fe_out_dir" "$env"
    log_success "Frontend Dockerfile → $fe_out_dir/Dockerfile"
  fi

  # ── 4. Nginx config ──────────────────────────────────────────────────────────
  log_info "Rendering Nginx config ($backend)..."
  local nginx_tmpl="$TEMPLATES_DIR/nginx/${backend}.conf"
  [[ -f "$nginx_tmpl" ]] || die "Nginx template not found: $nginx_tmpl"

  sed \
    -e "s/{{DOMAIN}}/$domain/g" \
    -e "s/{{PREFIX}}/$prefix/g" \
    -e "s/{{PROJECT}}/$project/g" \
    -e "s/{{ENV}}/$env/g" \
    "$nginx_tmpl" > "$out_dir/nginx.conf"
  log_success "Nginx config → $out_dir/nginx.conf"

  # ── 5. docker-compose.yml ────────────────────────────────────────────────────
  log_info "Generating docker-compose.yml..."
  bash "$SCRIPTS_DIR/compose-gen.sh" "$env"

  # ── 6. Garage config (if enabled) ────────────────────────────────────────────
  if [[ "$garage_enabled" == "true" ]]; then
    log_info "Generating garage.toml..."
    cat > "$out_dir/garage.toml" <<TOML
metadata_dir = "/meta"
data_dir     = "/data"
db_engine    = "lmdb"
replication_factor = 1

[rpc_bind_addr]
addr = "0.0.0.0:3901"

[s3_api]
s3_region     = "garage"
api_bind_addr = "0.0.0.0:3900"
root_domain   = ".s3.${domain}"

[s3_web]
bind_addr     = "0.0.0.0:3902"
root_domain   = ".web.${domain}"
index         = "index.html"
error_document = "404.html"

[admin]
api_bind_addr = "0.0.0.0:3903"
TOML
    log_success "Garage config → $out_dir/garage.toml"
  fi

  log_success "Environment '$env' bootstrapped"
  echo
}

bootstrap_env "$ENV"

# Standalone hint (suppressed when called from init_workspace.sh)
if [[ -z "${_INIT_SH_RUNNING:-}" ]]; then
  out_dir="$(env_dir "$ENV")"
  _pt="$(cfg_get '.project.type // "custom"')"
  log_info "Next steps:"
  echo "  1. Edit secrets : $out_dir/.env"
  if [[ "$_pt" == "image" ]]; then
    echo "  2. Deploy       : ./run.sh start $ENV"
    echo "  3. Check status : ./run.sh ps $ENV"
  else
    echo "  2. Place source : $out_dir/backend/"
    echo "  3. Build        : ./run.sh build $ENV"
    echo "  4. Deploy       : ./run.sh start $ENV"
  fi
fi
