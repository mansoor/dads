#!/usr/bin/env bash
# =============================================================================
# sync.sh — Pull latest code from git and trigger a rebuild + deploy
#
# Usage (via run.sh):
#   ./run.sh sync <env>                   # pull + build + deploy
#   ./run.sh sync <env> --pull-only       # just pull, no build
#   ./run.sh sync <env> --no-deploy       # pull + build, skip deploy
# =============================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_cmd jq git docker

ENV="${1:-}"
[[ -n "$ENV" ]] || { echo "Usage: scripts/sync.sh <env> [--pull-only] [--no-deploy]"; exit 1; }
validate_env "$ENV"

PULL_ONLY=false
NO_DEPLOY=false

for arg in "${@:2}"; do
  case "$arg" in
    --pull-only) PULL_ONLY=true ;;
    --no-deploy) NO_DEPLOY=true ;;
  esac
done

GIT_ENABLED="$(cfg_env_get "$ENV" '.git.enabled')"
if [[ "$GIT_ENABLED" != "true" ]]; then
  log_warn "Git sync disabled for '$ENV' in config.json (git.enabled = false)"
  exit 0
fi

REPO="$(cfg_env_get "$ENV" '.git.repo')"
BRANCH="$(cfg_env_get "$ENV" '.git.branch')"
FRONTEND_ENABLED="$(cfg_env_get "$ENV" '.frontend_enabled')"
OUT_DIR="$(env_dir "$ENV")"

pull_repo() {
  local dest="$1"
  if [[ -d "$dest/.git" ]]; then
    log_info "Pulling branch '$BRANCH' in $dest ..."
    git -C "$dest" fetch origin
    git -C "$dest" checkout "$BRANCH"
    git -C "$dest" reset --hard "origin/$BRANCH"
    log_success "Pulled: $(git -C "$dest" log -1 --format='%h %s')"
  else
    log_info "Cloning $REPO (branch: $BRANCH) → $dest ..."
    mkdir -p "$(dirname "$dest")"
    git clone --branch "$BRANCH" --single-branch "$REPO" "$dest"
    log_success "Cloned into $dest"
  fi
}

log_section "Git Sync: $ENV (branch: $BRANCH)"

pull_repo "$OUT_DIR/backend"
[[ "$FRONTEND_ENABLED" == "true" ]] && pull_repo "$OUT_DIR/frontend"

$PULL_ONLY && { log_success "Pull-only — done."; exit 0; }

log_info "Bumping build counter..."
bash "$SCRIPTS_DIR/version.sh" bump build

log_info "Building images..."
bash "$SCRIPTS_DIR/build.sh" "$ENV" all --push

$NO_DEPLOY && { log_success "No-deploy — images built and pushed."; exit 0; }

log_info "Regenerating docker-compose.yml..."
bash "$SCRIPTS_DIR/compose-gen.sh" "$ENV"

log_info "Deploying stack..."
bash "$SCRIPTS_DIR/deploy.sh" "$ENV" up

log_section "Sync Complete"
echo "  Environment: $ENV"
echo "  Branch:      $BRANCH"
echo "  Version:     $(version_string)"
