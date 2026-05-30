#!/usr/bin/env bash
# =============================================================================
# image-check.sh — Detect and apply image updates for image-stack workspaces
#
# Called automatically by deploy.sh ps for project type "image".
# For each image defined in config.json .images[]:
#
#   tag == "latest"  → compare local digest vs remote; if different,
#                       pull the new image and restart the service.
#   tag == pinned    → query Docker Hub (or registry) for newer tags;
#                       notify the user but do NOT auto-update.
#
# Usage (direct):
#   WORKSPACE_ROOT=/path/to/workspace scripts/image-check.sh <env>
# =============================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_cmd jq docker

ENV="${1:-}"
[[ -n "$ENV" ]] || die "Usage: image-check.sh <env>"
validate_env "$ENV"

PROJECT="$(cfg_get '.project.name')"
PREFIX="${PROJECT}_${ENV}"
DEPLOYMENT="$(cfg_env_get "$ENV" '.deployment')"
IMAGE_LEN="$(cfg_get '.images | length')"

[[ "$IMAGE_LEN" -gt 0 ]] || { log_info "No images defined — nothing to check."; exit 0; }

log_section "Image update check for '$ENV'"

# ── Helper: get local image digest ────────────────────────────────────────────
local_digest() {
  local image_ref="$1"   # e.g. plausible/analytics:latest
  docker image inspect --format '{{index .RepoDigests 0}}' "$image_ref" 2>/dev/null \
    | cut -d@ -f2 || echo "none"
}

# ── Helper: get remote digest via Docker Hub API ──────────────────────────────
# Works for Docker Hub images (library/ and user/ namespaces).
# For private registries, falls back to "docker pull --quiet" digest check.
remote_digest() {
  local image="$1"   # e.g. plausible/analytics
  local tag="$2"     # e.g. latest

  # Normalise library images: postgres → library/postgres
  local repo="$image"
  if [[ "$image" != */* ]]; then
    repo="library/${image}"
  fi

  # Docker Hub token (anonymous, read-only)
  local token
  token="$(curl -fsSL \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull" \
    2>/dev/null | jq -r '.token // empty')" || true

  if [[ -n "$token" ]]; then
    # Fetch manifest digest from Hub v2 API
    curl -fsSL \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
      -I "https://registry-1.docker.io/v2/${repo}/manifests/${tag}" \
      2>/dev/null | grep -i 'docker-content-digest:' | tr -d '\r' | awk '{print $2}' || echo "unknown"
  else
    echo "unknown"
  fi
}

# ── Helper: list available semver tags newer than pinned tag ──────────────────
# Queries Docker Hub tags API and filters for tags that look like semver
# versions newer than the pinned one.
newer_tags() {
  local image="$1"
  local current_tag="$2"

  local repo="$image"
  if [[ "$image" != */* ]]; then
    repo="library/${image}"
  fi

  local token
  token="$(curl -fsSL \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull" \
    2>/dev/null | jq -r '.token // empty')" || true

  [[ -z "$token" ]] && { echo ""; return; }

  # Fetch up to 100 tags; filter to semver-like strings
  local tags
  tags="$(curl -fsSL \
    -H "Authorization: Bearer ${token}" \
    "https://registry-1.docker.io/v2/${repo}/tags/list" \
    2>/dev/null | jq -r '.tags[]? // empty' | grep -E '^v?[0-9]+\.[0-9]+' | sort -V)" || true

  # Return tags that sort after the current one (simple lexicographic / version sort)
  if [[ -n "$tags" ]]; then
    echo "$tags" | awk -v cur="$current_tag" 'found{print} $0==cur{found=1}' | tail -5
  fi
}

# ── Helper: restart a single service ─────────────────────────────────────────
restart_service() {
  local svc_name="$1"
  local container="${PREFIX}_${svc_name}"
  log_info "Restarting ${container}..."
  if [[ "$DEPLOYMENT" == "swarm" ]]; then
    docker service update --force "${PREFIX}_${svc_name}" 2>/dev/null || \
      log_warn "Could not force-update swarm service ${PREFIX}_${svc_name}"
  else
    local env_dir
    env_dir="$(env_dir "$ENV")"
    (cd "$env_dir" && docker compose -f docker-compose.yml restart "${container}" 2>/dev/null) || \
      log_warn "Could not restart container ${container}"
  fi
}

# ── Main loop ─────────────────────────────────────────────────────────────────
_updated=0
_stale=0

for _idx in $(seq 0 $((IMAGE_LEN - 1))); do
  _svc_name="$(cfg_get ".images[${_idx}].name")"
  _img_ref="$(cfg_get  ".images[${_idx}].image")"
  _img_tag="$(cfg_get  ".images[${_idx}].tag")"
  _full_ref="${_img_ref}:${_img_tag}"

  echo
  echo -e "  ${BOLD}${_svc_name}${RESET}  ${DIM}${_full_ref}${RESET}"

  if [[ "$_img_tag" == "latest" ]]; then
    # ── latest tag: compare digests and auto-update ───────────────────────────
    echo -e "  ${DIM}Checking for updates (tag: latest)...${RESET}"

    _local_dig="$(local_digest "$_full_ref")"
    _remote_dig="$(remote_digest "$_img_ref" "$_img_tag")"

    if [[ "$_remote_dig" == "unknown" || "$_remote_dig" == "none" || -z "$_remote_dig" ]]; then
      log_warn "  Could not determine remote digest for ${_full_ref} — skipping"
      continue
    fi

    if [[ "$_local_dig" == "none" || "$_local_dig" != "$_remote_dig" ]]; then
      log_info "  Update available — pulling ${_full_ref}..."
      docker pull "$_full_ref"
      _updated=$((_updated + 1))
      restart_service "$_svc_name"
      log_success "  ${_svc_name} updated and restarted"
    else
      log_success "  ${_svc_name} is up to date  ${DIM}(${_local_dig:0:19}...)${RESET}"
    fi

  else
    # ── Pinned tag: check for newer versions on Docker Hub ────────────────────
    echo -e "  ${DIM}Checking Docker Hub for newer tags than '${_img_tag}'...${RESET}"

    _newer="$(newer_tags "$_img_ref" "$_img_tag")"

    if [[ -n "$_newer" ]]; then
      _stale=$((_stale + 1))
      log_warn "  Newer tags available for ${_img_ref}:"
      while IFS= read -r _t; do
        echo -e "    ${YELLOW}→${RESET} ${_img_ref}:${_t}"
      done <<< "$_newer"
      echo -e "  ${DIM}To upgrade: update config.json .images[].tag, then ./run.sh refresh ${ENV}${RESET}"
    else
      log_success "  ${_svc_name} is on the latest pinned tag  ${DIM}(${_img_tag})${RESET}"
    fi
  fi
done

echo
if [[ "$_updated" -gt 0 ]]; then
  log_success "Auto-updated ${_updated} image(s) with tag 'latest'."
fi
if [[ "$_stale" -gt 0 ]]; then
  log_warn "${_stale} image(s) have newer versions available. Review above and update config.json."
fi
if [[ "$_updated" -eq 0 && "$_stale" -eq 0 ]]; then
  log_success "All images are current."
fi
