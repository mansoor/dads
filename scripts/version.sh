#!/usr/bin/env bash
# =============================================================================
# version.sh — Semantic version management
# Usage:
#   ./scripts/version.sh current
#   ./scripts/version.sh bump [major|minor|patch|build]
#   ./scripts/version.sh set 2.1.3-build.0
# =============================================================================

source "$(dirname "$0")/lib.sh"
require_cmd jq

CMD="${1:-current}"

current_version() {
  version_string
}

bump_version() {
  local part="${1:-build}"
  local major minor patch build

  major="$(cfg_get '.project.version.major')"
  minor="$(cfg_get '.project.version.minor')"
  patch="$(cfg_get '.project.version.patch')"
  build="$(cfg_get '.project.version.build')"

  case "$part" in
    major)
      major=$((major + 1)); minor=0; patch=0; build=0 ;;
    minor)
      minor=$((minor + 1)); patch=0; build=0 ;;
    patch)
      patch=$((patch + 1)); build=0 ;;
    build)
      build=$((build + 1)) ;;
    *)
      die "Unknown version part '$part'. Use: major | minor | patch | build" ;;
  esac

  local tmp
  tmp="$(mktemp "${CONFIG_FILE}.XXXXXX")"
  jq \
    --argjson major "$major" \
    --argjson minor "$minor" \
    --argjson patch "$patch" \
    --argjson build "$build" \
    '.project.version = {major: $major, minor: $minor, patch: $patch, build: $build}' \
    "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

  log_success "Version bumped ($part): ${major}.${minor}.${patch}-build.${build}"
}

set_version() {
  local ver="$1"
  # Expected format: M.m.p-build.B
  if [[ ! "$ver" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)-build\.([0-9]+)$ ]]; then
    die "Invalid version format '$ver'. Expected: M.m.p-build.N"
  fi
  local major="${BASH_REMATCH[1]}"
  local minor="${BASH_REMATCH[2]}"
  local patch="${BASH_REMATCH[3]}"
  local build="${BASH_REMATCH[4]}"

  local tmp
  tmp="$(mktemp "${CONFIG_FILE}.XXXXXX")"
  jq \
    --argjson major "$major" \
    --argjson minor "$minor" \
    --argjson patch "$patch" \
    --argjson build "$build" \
    '.project.version = {major: $major, minor: $minor, patch: $patch, build: $build}' \
    "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"

  log_success "Version set to: ${major}.${minor}.${patch}-build.${build}"
}

case "$CMD" in
  current) echo "$(current_version)" ;;
  bump)    bump_version "${2:-build}" ;;
  set)     [[ -n "${2:-}" ]] || die "Usage: version.sh set M.m.p-build.N"; set_version "$2" ;;
  *)       die "Unknown command '$CMD'. Use: current | bump | set" ;;
esac
