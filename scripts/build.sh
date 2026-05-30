#!/usr/bin/env bash
# =============================================================================
# build.sh — Build and push Docker images for an environment
#
# Usage (via run.sh):
#   ./run.sh build <env>                         # build backend + frontend
#   ./run.sh build <env> backend                 # build backend only
#   ./run.sh build <env> frontend                # build frontend only
#   ./run.sh build <env> --push                  # build + push to registry
#   ./run.sh build <env> --bump [major|minor|patch|build]
# =============================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_cmd jq docker

ENV="${1:-}"
[[ -n "$ENV" ]] || { echo "Usage: scripts/build.sh <env> [backend|frontend] [--push] [--bump [part]]"; exit 1; }
validate_env "$ENV"

TARGET="all"
PUSH=false
BUMP=false
BUMP_PART="build"

for arg in "${@:2}"; do
  case "$arg" in
    --push)                        PUSH=true ;;
    --bump)                        BUMP=true ;;
    major|minor|patch|build)       BUMP_PART="$arg" ;;
    backend|frontend|all)          TARGET="$arg" ;;
  esac
done

if $BUMP; then
  log_info "Bumping version ($BUMP_PART)..."
  bash "$SCRIPTS_DIR/version.sh" bump "$BUMP_PART"
fi

TAG="$(version_string)-${ENV}"
PROJECT="$(cfg_get '.project.name')"
REGISTRY="$(cfg_get '.project.registry')"
FRONTEND_ENABLED="$(cfg_env_get "$ENV" '.frontend_enabled')"
OUT_DIR="$(env_dir "$ENV")"

build_image() {
  local service="$1"
  local context_dir="$OUT_DIR/$service"
  local img_tag
  img_tag="$(image_tag "$service" "$ENV")"

  [[ -d "$context_dir" ]] || die "Build context not found: $context_dir  (run ./run.sh init $ENV first)"
  [[ -f "$context_dir/Dockerfile" ]] || die "Dockerfile not found: $context_dir/Dockerfile"

  log_section "Building $service image: $img_tag"

  docker build \
    --build-arg BUILD_ENV="$ENV" \
    --build-arg VERSION="$(version_string)" \
    --label "project=${PROJECT}" \
    --label "environment=${ENV}" \
    --label "version=$(version_string)" \
    --label "service=${service}" \
    -t "$img_tag" \
    -f "$context_dir/Dockerfile" \
    "$context_dir"

  log_success "Built: $img_tag"

  if $PUSH; then
    log_info "Pushing $img_tag ..."
    docker push "$img_tag"
    log_success "Pushed: $img_tag"
  fi
}

case "$TARGET" in
  backend)
    build_image "backend"
    ;;
  frontend)
    [[ "$FRONTEND_ENABLED" == "true" ]] || die "Frontend is disabled for '$ENV' in config.json"
    build_image "frontend"
    ;;
  all)
    build_image "backend"
    if [[ "$FRONTEND_ENABLED" == "true" ]]; then
      build_image "frontend"
    else
      log_info "Frontend disabled for '$ENV' — skipping"
    fi
    ;;
  *)
    die "Unknown target '$TARGET'. Use: backend | frontend | all"
    ;;
esac

log_section "Build Summary"
echo "  Project:     $PROJECT"
echo "  Environment: $ENV"
echo "  Tag:         $TAG"
$PUSH && echo "  Registry:    $REGISTRY" || echo "  Push:        skipped (add --push to push)"
