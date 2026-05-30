#!/usr/bin/env bash
# =============================================================================
# promote.sh — Retag and redeploy an image between environments
#
# Promotes the exact image built in <src_env> to <dst_env> by pulling it,
# retagging it, pushing the new tag, then deploying to the destination.
# No rebuild occurs — the binary artifact is identical.
#
# Usage (via run.sh):
#   ./run.sh promote <src_env> <dst_env>            # retag + deploy
#   ./run.sh promote <src_env> <dst_env> --dry-run  # preview only
#
# Example:
#   ./run.sh promote stage prod
# =============================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_cmd docker jq

SRC_ENV="${1:-}"
DST_ENV="${2:-}"
DRY_RUN=false
[[ "${3:-}" == "--dry-run" ]] && DRY_RUN=true

[[ -n "$SRC_ENV" && -n "$DST_ENV" ]] || {
  echo "Usage: scripts/promote.sh <src_env> <dst_env> [--dry-run]"
  exit 1
}

validate_env "$SRC_ENV"
validate_env "$DST_ENV"
[[ "$SRC_ENV" != "$DST_ENV" ]] || die "Source and destination environments must differ."

FRONTEND_ENABLED="$(cfg_env_get "$DST_ENV" '.frontend_enabled')"
VER="$(version_string)"

# ── Helper: retag one service image ──────────────────────────────────────────
retag_service() {
  local service="$1"
  local src_tag dst_tag
  src_tag="$(image_tag "$service" "$SRC_ENV")"
  dst_tag="$(image_tag "$service" "$DST_ENV")"

  log_info "Promoting $service"
  echo "  ${DIM}${src_tag}${RESET}"
  echo "  ${DIM}→ ${dst_tag}${RESET}"

  if $DRY_RUN; then
    echo "  ${YELLOW}[dry-run] docker pull $src_tag${RESET}"
    echo "  ${YELLOW}[dry-run] docker tag  $src_tag $dst_tag${RESET}"
    echo "  ${YELLOW}[dry-run] docker push $dst_tag${RESET}"
    return
  fi

  docker pull "$src_tag"
  docker tag  "$src_tag" "$dst_tag"
  docker push "$dst_tag"
  log_success "$service promoted → $dst_tag"
}

# ── Main ─────────────────────────────────────────────────────────────────────
log_section "Promoting '$SRC_ENV' → '$DST_ENV'  (v${VER})"

if $DRY_RUN; then
  log_warn "Dry-run mode — no changes will be made"
fi

retag_service "backend"

if [[ "$FRONTEND_ENABLED" == "true" ]]; then
  retag_service "frontend"
else
  log_info "Frontend disabled for '$DST_ENV' — skipping"
fi

if $DRY_RUN; then
  log_warn "Dry-run complete — run without --dry-run to apply"
  exit 0
fi

log_info "Deploying to '$DST_ENV'..."
bash "$SCRIPTS_DIR/deploy.sh" "$DST_ENV" up

log_success "Promotion complete: $SRC_ENV → $DST_ENV"
echo
echo "  ${DIM}Image version: ${VER}${RESET}"
echo "  ${DIM}The $SRC_ENV image was retagged — no rebuild occurred.${RESET}"
