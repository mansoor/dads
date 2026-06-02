#!/usr/bin/env bash
# =============================================================================
# lib.sh — Shared library for DADS (Docker App Deployment Simplified)
#
# TOOLKIT_ROOT  = location of this toolkit (scripts/, templates/)
# WORKSPACE_ROOT = location of the project workspace (config.json, envs/, backups/)
#
# When called from a workspace's run.sh, WORKSPACE_ROOT is pre-exported.
# When scripts are called directly from the toolkit root, WORKSPACE_ROOT
# falls back to TOOLKIT_ROOT for backward compatibility.
#
# Source at the top of every script:
#   source "$(dirname "$0")/scripts/lib.sh"      ← from toolkit root
#   source "$TOOLKIT_ROOT/scripts/lib.sh"        ← from run.sh
# =============================================================================

set -euo pipefail

# ── Paths ─────────────────────────────────────────────────────────────────────
# TOOLKIT_ROOT: where scripts/ and templates/ live (this file's parent's parent)
TOOLKIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS_DIR="$TOOLKIT_ROOT/scripts"
TEMPLATES_DIR="$TOOLKIT_ROOT/templates"
WORKSPACES_DIR="$TOOLKIT_ROOT/workspaces"
DEFAULTS_DIR="$SCRIPTS_DIR/defaults"

# WORKSPACE_ROOT: where config.json, envs/, backups/ live.
# Callers (init_workspace.sh, run.sh) export WORKSPACE_ROOT before sourcing.
# Falls back to TOOLKIT_ROOT so scripts can still be tested directly;
# CONFIG_FILE then points to scripts/defaults/config.json.
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$TOOLKIT_ROOT}"

if [[ -f "$WORKSPACE_ROOT/config.json" ]]; then
  CONFIG_FILE="$WORKSPACE_ROOT/config.json"
else
  CONFIG_FILE="$DEFAULTS_DIR/config.json"
fi

ENVS_DIR="$WORKSPACE_ROOT/envs"
BACKUPS_DIR="$WORKSPACE_ROOT/backups"

# ── Colours ───────────────────────────────────────────────────────────────────
# Use $'...' ANSI-C quoting so variables hold actual ESC bytes.
# This means cat/printf/echo all render colours correctly without -e.
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'
CYAN=$'\033[0;36m'
BOLD=$'\033[1m'
DIM=$'\033[2m'
RESET=$'\033[0m'

# ── Logging ───────────────────────────────────────────────────────────────────
log_info()    { echo -e "${BLUE}[INFO]${RESET}  $*" >&2; }
log_success() { echo -e "${GREEN}[OK]${RESET}    $*" >&2; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*" >&2; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
log_section() { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}" >&2; }
log_dim()     { echo -e "${DIM}$*${RESET}" >&2; }
die()         { log_error "$*"; exit 1; }

# ── Dependency checks ─────────────────────────────────────────────────────────
require_cmd() {
  for cmd in "$@"; do
    command -v "$cmd" &>/dev/null || die "Required command not found: $cmd  (please install it)"
  done
}

# ── jq helpers ────────────────────────────────────────────────────────────────
cfg_get() {
  local query="$1"
  jq -r "$query" "$CONFIG_FILE"
}

cfg_env_get() {
  local env="$1"
  local query="$2"
  jq -r ".environments.${env}${query}" "$CONFIG_FILE"
}

cfg_env_bool() {
  local env="$1"
  local query="$2"
  local val
  val="$(cfg_env_get "$env" "$query")"
  [[ "$val" == "true" ]]
}

cfg_envs() {
  jq -r '.environments | keys[]' "$CONFIG_FILE"
}

# Read a version from config, fall back to a default
cfg_version() {
  local key="$1"
  local default="$2"
  local val
  val="$(jq -r ".versions.${key} // \"${default}\"" "$CONFIG_FILE")"
  echo "${val:-$default}"
}

# ── Version helpers ───────────────────────────────────────────────────────────
version_string() {
  local major minor patch build
  major="$(cfg_get '.project.version.major')"
  minor="$(cfg_get '.project.version.minor')"
  patch="$(cfg_get '.project.version.patch')"
  build="$(cfg_get '.project.version.build')"
  echo "${major}.${minor}.${patch}-build.${build}"
}

image_tag() {
  local service="$1"
  local env="$2"
  local project registry ver
  project="$(cfg_get '.project.name')"
  registry="$(cfg_get '.project.registry')"
  ver="$(version_string)"
  echo "${registry}/${project}-${service}:${ver}-${env}"
}

# ── Environment helpers ───────────────────────────────────────────────────────
validate_env() {
  local env="$1"
  if ! cfg_envs | grep -q "^${env}$"; then
    local valid_envs
    valid_envs="$(cfg_envs | tr '\n' ' ')"
    die "Unknown environment '${env}'. Configured: ${valid_envs}"
  fi
}

env_dir()  { echo "$ENVS_DIR/$1"; }
env_file() { echo "$ENVS_DIR/$1/.env"; }

ensure_env_file() {
  local env="$1"
  local ef; ef="$(env_file "$env")"
  if [[ ! -f "$ef" ]]; then
    local example="$ENVS_DIR/$env/.env.example"
    if [[ -f "$example" ]]; then
      log_warn ".env not found for '$env' — copying from .env.example. Fill in secrets before deploying."
      cp "$example" "$ef"
    else
      die ".env missing for environment '$env': $ef"
    fi
  fi
}

# ── Docker / compose helpers ──────────────────────────────────────────────────
compose_file() { echo "$ENVS_DIR/$1/docker-compose.yml"; }
stack_name()   { local p; p="$(cfg_get '.project.name')"; echo "${p}_${1}"; }
service_prefix() { stack_name "$1"; }

# ── Confirmation prompt ───────────────────────────────────────────────────────
confirm() {
  local prompt="${1:-Are you sure?}"
  local default="${2:-n}"
  local hint
  [[ "$default" == "y" ]] && hint="[Y/n]" || hint="[y/N]"
  read -r -p "$(echo -e "${YELLOW}${prompt} ${hint}${RESET} ")" reply
  reply="${reply:-$default}"
  [[ "$(echo "$reply" | tr '[:upper:]' '[:lower:]')" == "y" ]]
}

# ── Slug validation ───────────────────────────────────────────────────────────
is_valid_slug() {
  [[ "$1" =~ ^[a-z][a-z0-9_-]{1,30}$ ]]
}
