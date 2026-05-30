#!/usr/bin/env bash
# =============================================================================
# init_workspace.sh — Interactive workspace initialiser for DADS (Docker App Deployment Simplified)
#
# Usage:
#   ./init_workspace.sh                   # fully interactive
#   ./init_workspace.sh --defaults        # accept all defaults (for CI / testing)
#
# Creates a workspace at a path you choose (default: ./workspaces/<project>)
# and generates: config.json, run.sh, envs/<env>/.env, docker-compose.yml,
# Dockerfiles, nginx config, and (optionally) garage.toml.
# =============================================================================

set -euo pipefail
TOOLKIT_ROOT="$(cd "$(dirname "$0")" && pwd)"
source "$TOOLKIT_ROOT/scripts/lib.sh"
require_cmd jq

DEFAULTS_MODE=false
[[ "${1:-}" == "--defaults" ]] && DEFAULTS_MODE=true

# ── UI helpers ────────────────────────────────────────────────────────────────
divider() { echo -e "${DIM}────────────────────────────────────────────────────${RESET}"; }
header() {
  clear 2>/dev/null || true
  echo -e "${BOLD}${CYAN}"
  echo "  ╔══════════════════════════════════════════════════╗"
  echo "  ║   DADS — Docker App Deployment Simplified        ║"
  echo "  ╚══════════════════════════════════════════════════╝"
  echo -e "${RESET}"
  echo -e "  ${DIM}This wizard generates a fully-configured workspace.${RESET}"
  echo -e "  ${DIM}Press Enter to accept the default shown in [brackets].${RESET}"
  echo
}

ask() {
  # ask VARNAME "prompt" "default"
  local varname="$1"
  local prompt="$2"
  local default="${3:-}"
  local hint=""
  [[ -n "$default" ]] && hint=" ${DIM}[${default}]${RESET}"

  if $DEFAULTS_MODE; then
    printf -v "$varname" '%s' "$default"
    echo -e "  ${BLUE}▸${RESET} ${prompt}${hint} ${DIM}→ ${default}${RESET}"
    return
  fi

  local answer
  echo -en "  ${BOLD}▸${RESET} ${prompt}${hint}: "
  read -r answer
  printf -v "$varname" '%s' "${answer:-$default}"
}

ask_choice() {
  # ask_choice VARNAME "prompt" default opt1 label1 opt2 label2 ...
  local varname="$1"
  local prompt="$2"
  local default="$3"
  shift 3

  echo -e "\n  ${BOLD}▸ ${prompt}${RESET}"

  local i=1
  local opts=()
  local labels=()
  while [[ $# -ge 2 ]]; do
    opts+=("$1"); labels+=("$2")
    local marker="" cur_label="$2"
    [[ "$1" == "$default" ]] && marker=" ${GREEN}(default)${RESET}"
    echo -e "    ${DIM}${i})${RESET} ${cur_label}${marker}"
    i=$((i+1)); shift 2
  done

  if $DEFAULTS_MODE; then
    printf -v "$varname" '%s' "$default"
    echo -e "    ${DIM}→ ${default}${RESET}"
    return
  fi

  local answer idx
  echo -en "  ${DIM}Enter number or value${RESET} [${default}]: "
  read -r answer
  answer="${answer:-$default}"

  # Accept number or direct value
  if [[ "$answer" =~ ^[0-9]+$ ]]; then
    idx=$((answer - 1))
    if [[ $idx -ge 0 && $idx -lt ${#opts[@]} ]]; then
      printf -v "$varname" '%s' "${opts[$idx]}"
    else
      printf -v "$varname" '%s' "$default"
    fi
  else
    printf -v "$varname" '%s' "$answer"
  fi
}

ask_yn() {
  # ask_yn VARNAME "prompt" y|n
  # Always stores "true" or "false" (JSON-safe), regardless of mode.
  local varname="$1"
  local prompt="$2"
  local default="${3:-n}"
  local hint; [[ "$default" == "y" ]] && hint="[Y/n]" || hint="[y/N]"

  local answer
  if $DEFAULTS_MODE; then
    answer="$default"
    echo -e "  ${BLUE}▸${RESET} ${prompt} ${DIM}${hint} → ${answer}${RESET}"
  else
    echo -en "  ${BOLD}▸${RESET} ${prompt} ${DIM}${hint}${RESET}: "
    read -r answer
    answer="${answer:-$default}"
  fi

  # Lowercase without Bash 4+ ${,,} — tr is always available on macOS
  local answer_lc
  answer_lc="$(echo "$answer" | tr '[:upper:]' '[:lower:]')"
  [[ "$answer_lc" == "y" ]] && printf -v "$varname" '%s' "true" || printf -v "$varname" '%s' "false"
}

# ── Start wizard ──────────────────────────────────────────────────────────────
header

# ══ Step 1: Project basics ════════════════════════════════════════════════════
echo -e "${BOLD}  Step 1 of 5 — Project${RESET}"
divider

while true; do
  ask PROJECT_NAME "Project name (lowercase, hyphens ok)" "myapp"
  if is_valid_slug "$PROJECT_NAME"; then break; fi
  echo -e "  ${RED}Invalid name. Use lowercase letters, numbers, hyphens. Min 2 chars.${RESET}"
done

ask REGISTRY "Container registry URL" "registry.example.com"

DEFAULT_WORKSPACE="$TOOLKIT_ROOT/workspaces/$PROJECT_NAME"
ask WORKSPACE_PATH "Workspace output path" "$DEFAULT_WORKSPACE"
# Resolve to absolute path (portable — macOS realpath lacks -m)
if [[ "$WORKSPACE_PATH" != /* ]]; then
  WORKSPACE_PATH="$(pwd)/$WORKSPACE_PATH"
fi
# Collapse any . or .. components without requiring the path to exist
WORKSPACE_PATH="$(python3 -c "import os,sys; print(os.path.normpath(sys.argv[1]))" "$WORKSPACE_PATH")"

if [[ -d "$WORKSPACE_PATH" ]]; then
  echo -e "\n  ${YELLOW}⚠  Workspace already exists: $WORKSPACE_PATH${RESET}"
  if $DEFAULTS_MODE || confirm "  Overwrite / re-init?" "n"; then
    log_warn "Re-initialising existing workspace."
  else
    echo "Aborted."; exit 0
  fi
fi

# ══ Step 2: Stack type and configuration ══════════════════════════════════════
echo
echo -e "${BOLD}  Step 2 of 5 — Application Stack${RESET}"
divider

ask_choice PROJECT_TYPE "Project type" "custom" \
  "custom"   "Custom build — bring your own source code and Dockerfiles" \
  "image"    "Image stack — deploy existing Docker images (configure manually)" \
  "prebuilt" "Pre-built stack — choose from popular app templates (WordPress, Ghost, …)"

IMAGE_COUNT=0              # always defined; non-zero only for image/prebuilt type
PREBUILT_DEFAULT_ENV_JSON="" # template default_env_vars JSON (set for prebuilt stacks)
_tmpl_file=""              # path to selected template file (set for prebuilt stacks)

# ── Pre-built stack selection ─────────────────────────────────────────────────
if [[ "$PROJECT_TYPE" == "prebuilt" ]]; then
  echo
  echo -e "  ${DIM}Available pre-built stacks:${RESET}"
  echo

  # Discover templates from templates/stacks/ — build indexed list
  _tmpl_names=()
  _tmpl_files=()
  _tmpl_labels=()
  _tmpl_tags=()
  _ti=0
  for _tf in "$TOOLKIT_ROOT/templates/stacks/"*.json; do
    [[ -f "$_tf" ]] || continue
    _tn="$(jq -r '.name'        "$_tf")"
    _tl="$(jq -r '.label'       "$_tf")"
    _tt="$(jq -r '.tags | join(", ")' "$_tf")"
    _ti=$((_ti + 1))
    _tmpl_names+=("$_tn")
    _tmpl_files+=("$_tf")
    _tmpl_labels+=("$_tl")
    _tmpl_tags+=("$_tt")
    printf "    ${DIM}%2d)${RESET} %-40s ${DIM}[%s]${RESET}\n" "$_ti" "$_tl" "$_tt"
  done

  if [[ "$_ti" -eq 0 ]]; then
    die "No templates found in $TOOLKIT_ROOT/templates/stacks/"
  fi

  echo
  _tmpl_choice=""
  if $DEFAULTS_MODE; then
    _tmpl_choice=1
    echo -e "  ${BLUE}▸${RESET} Template ${DIM}→ 1${RESET}"
  else
    echo -en "  ${BOLD}▸${RESET} Choose a template ${DIM}[1]${RESET}: "
    read -r _tmpl_choice
    _tmpl_choice="${_tmpl_choice:-1}"
  fi

  # Validate choice
  if ! [[ "$_tmpl_choice" =~ ^[0-9]+$ ]] || [[ "$_tmpl_choice" -lt 1 || "$_tmpl_choice" -gt "$_ti" ]]; then
    die "Invalid selection '$_tmpl_choice'. Enter a number between 1 and $_ti."
  fi

  # Arrays are 0-indexed, choice is 1-indexed
  _tmpl_idx=$((_tmpl_choice - 1))
  _tmpl_file="${_tmpl_files[$_tmpl_idx]}"
  _tmpl_label="${_tmpl_labels[$_tmpl_idx]}"

  echo
  echo -e "  ${GREEN}✓${RESET} Selected: ${BOLD}${_tmpl_label}${RESET}"
  echo -e "  ${DIM}$(jq -r '.description' "$_tmpl_file")${RESET}"
  echo

  # Load images from template into flat vars
  IMAGE_COUNT="$(jq -r '.images | length' "$_tmpl_file")"
  echo -e "  ${DIM}Images included in this stack:${RESET}"
  for _si in $(seq 0 $((IMAGE_COUNT - 1))); do
    _img_num=$((_si + 1))
    _v_name="$(jq -r  ".images[${_si}].name"              "$_tmpl_file")"
    _v_ref="$(jq -r   ".images[${_si}].image"             "$_tmpl_file")"
    _v_tag="$(jq -r   ".images[${_si}].tag"               "$_tmpl_file")"
    _v_port="$(jq -r  ".images[${_si}].port"              "$_tmpl_file")"
    _v_hport="$(jq -r ".images[${_si}].host_port // \"\""  "$_tmpl_file")"
    _v_hc="$(jq -r    ".images[${_si}].healthcheck // \"\"" "$_tmpl_file")"
    _v_cmd="$(jq -r   ".images[${_si}].command // \"\""   "$_tmpl_file")"

    # Store JSON blobs for multi-valued fields (volumes, env_vars, depends_on, extra_ports)
    _v_vols_json="$(jq -c   ".images[${_si}].volumes // []"      "$_tmpl_file")"
    _v_envs_json="$(jq -c   ".images[${_si}].env_vars // {}"     "$_tmpl_file")"
    _v_deps_json="$(jq -c   ".images[${_si}].depends_on // []"   "$_tmpl_file")"
    _v_xprt_json="$(jq -c   ".images[${_si}].extra_ports // []"  "$_tmpl_file")"
    _v_hc_json="$(jq -c     ".images[${_si}].healthcheck_config // {}" "$_tmpl_file")"

    printf -v "IMAGE_NAME__${_img_num}"        '%s' "$_v_name"
    printf -v "IMAGE_REF__${_img_num}"         '%s' "$_v_ref"
    printf -v "IMAGE_PORT__${_img_num}"        '%s' "$_v_port"
    printf -v "IMAGE_HOST_PORT__${_img_num}"   '%s' "$_v_hport"
    printf -v "IMAGE_HEALTHCHECK__${_img_num}" '%s' "$_v_hc"
    printf -v "IMAGE_CMD__${_img_num}"         '%s' "$_v_cmd"
    printf -v "IMAGE_VOLS_JSON__${_img_num}"   '%s' "$_v_vols_json"
    printf -v "IMAGE_ENVS_JSON__${_img_num}"   '%s' "$_v_envs_json"
    printf -v "IMAGE_DEPS_JSON__${_img_num}"   '%s' "$_v_deps_json"
    printf -v "IMAGE_XPRT_JSON__${_img_num}"   '%s' "$_v_xprt_json"
    printf -v "IMAGE_HC_JSON__${_img_num}"     '%s' "$_v_hc_json"

    # Show the image and allow tag override
    printf "    ${DIM}%d)${RESET} %-12s %s:${BOLD}%s${RESET}\n" "$_img_num" "$_v_name" "$_v_ref" "$_v_tag"
    ask "IMAGE_TAG__${_img_num}" "     Override tag for '${_v_name}'" "$_v_tag"
  done

  # Load template default env vars (merged with user additions later)
  PREBUILT_DEFAULT_ENV_JSON="$(jq -c '.default_env_vars // {}' "$_tmpl_file")"

  # PROJECT_TYPE in config.json is always "image" — prebuilt just means wizard-assisted
  PROJECT_TYPE="image"

  # Unused custom-type fields — safe defaults
  BACKEND="image"; FRONTEND_ENABLED="false"; FRONTEND="none"
  DATABASE="none"; REDIS_ENABLED="false"; GARAGE_ENABLED="false"

elif [[ "$PROJECT_TYPE" == "custom" ]]; then

  ask_choice BACKEND "Backend framework" "laravel" \
    "laravel" "Laravel (PHP-FPM)" \
    "nodejs"  "Node.js (Express / Fastify / etc.)"

  ask_choice FRONTEND_TYPE "Frontend" "none" \
    "none"   "None — API / backend only" \
    "nextjs" "Next.js" \
    "react"  "React (Vite SPA)"

  [[ "$FRONTEND_TYPE" == "none" ]] && FRONTEND_ENABLED="false" || FRONTEND_ENABLED="true"
  FRONTEND="${FRONTEND_TYPE}"
  [[ "$FRONTEND_TYPE" == "none" ]] && FRONTEND="nextjs"   # placeholder value, won't be used

  ask_choice DATABASE "Database" "postgres" \
    "postgres" "PostgreSQL" \
    "mysql"    "MySQL"

  ask_yn REDIS_ENABLED  "Enable Redis cache?"                  "y"
  ask_yn GARAGE_ENABLED "Enable Garage S3-compatible storage?" "n"

else
  # ── Manual image stack: collect Docker images one-by-one ─────────────────────
  echo
  echo -e "  ${DIM}Add each Docker image you want to run as a service.${RESET}"

  while true; do
    IMAGE_COUNT=$((IMAGE_COUNT + 1))
    echo
    echo -e "  ${BOLD}${CYAN}── Image #${IMAGE_COUNT} ──${RESET}"

    while true; do
      ask "IMAGE_NAME__${IMAGE_COUNT}" "  Service name (e.g. app, db, cache)" "service${IMAGE_COUNT}"
      _k="IMAGE_NAME__${IMAGE_COUNT}"
      if is_valid_slug "${!_k}"; then break; fi
      echo -e "  ${RED}Invalid. Use lowercase letters, numbers, hyphens (2-30 chars).${RESET}"
    done

    ask "IMAGE_REF__${IMAGE_COUNT}"       "  Docker image (e.g. plausible/analytics)" ""
    ask "IMAGE_TAG__${IMAGE_COUNT}"       "  Tag (use 'latest' for auto-update detection)" "latest"
    ask "IMAGE_PORT__${IMAGE_COUNT}"      "  Container port (internal)" "8080"
    ask "IMAGE_HOST_PORT__${IMAGE_COUNT}"  "  Host port mapping (e.g. 8080 or \${WP_PORT} — blank = internal only)" ""
    ask "IMAGE_VOL__${IMAGE_COUNT}"        "  Volume mount (e.g. \${DATA_DIR}:/data — leave blank for none)" ""
    ask "IMAGE_HEALTHCHECK__${IMAGE_COUNT}" "  Healthcheck command (e.g. curl -f http://localhost/health — blank to skip)" ""

    # Per-image env vars → go into compose environment: block
    # Values can be static (WORDPRESS_DB_HOST=db) or reference .env vars (WORDPRESS_DB_USER=${MYSQL_USER})
    _ie_count=0
    if ! $DEFAULTS_MODE; then
      _k="IMAGE_NAME__${IMAGE_COUNT}"; _ie_svc="${!_k}"
      echo
      echo -e "  ${DIM}Environment variables for '${_ie_svc}' container (these go into the compose environment: block):${RESET}"
      echo -e "  ${DIM}Use KEY=static_value  or  KEY=\${DOT_ENV_VAR} to reference a .env variable.${RESET}"
      while true; do
        echo -en "    ${DIM}▸${RESET} KEY=VALUE (blank to stop): "
        read -r _ie_kv
        [[ -z "$_ie_kv" ]] && break
        if [[ "$_ie_kv" == *"="* ]]; then
          _ie_count=$((_ie_count + 1))
          _ie_key="${_ie_kv%%=*}"
          _ie_val="${_ie_kv#*=}"
          printf -v "IMAGE_ENV_KEY__${IMAGE_COUNT}__${_ie_count}" '%s' "$_ie_key"
          printf -v "IMAGE_ENV_VAL__${IMAGE_COUNT}__${_ie_count}" '%s' "$_ie_val"
        else
          echo -e "    ${RED}Expected KEY=VALUE format${RESET}"
        fi
      done
    fi
    printf -v "IMAGE_ENV_COUNT__${IMAGE_COUNT}" '%s' "$_ie_count"

    ask_yn _img_more "  Add another image?" "n"
    [[ "$_img_more" == "false" ]] && break
  done

  # Unused fields — safe defaults so config.json is always valid
  BACKEND="image"; FRONTEND_ENABLED="false"; FRONTEND="none"
  DATABASE="none"; REDIS_ENABLED="false"; GARAGE_ENABLED="false"
fi

# ══ Step 3: Environments ══════════════════════════════════════════════════════
echo
echo -e "${BOLD}  Step 3 of 5 — Environments${RESET}"
divider

ask ENVS_RAW "Environments to create (space-separated)" "dev stage prod"
read -ra ENVS <<< "$ENVS_RAW"

# Validate env names
VALID_ENVS=()
for e in "${ENVS[@]}"; do
  if [[ "$e" =~ ^[a-z][a-z0-9_-]{0,15}$ ]]; then
    VALID_ENVS+=("$e")
  else
    log_warn "Skipping invalid env name '$e'"
  fi
done
[[ ${#VALID_ENVS[@]} -gt 0 ]] || die "No valid environment names provided."
ENVS=("${VALID_ENVS[@]}")

# Per-environment config stored as flat vars: ENV_DOMAIN__dev, ENV_HTTP_PORT__prod, etc.
# (Bash 3.2 compatible — no associative arrays used)

# Sensible defaults per well-known env names
default_port() {
  case "$1" in dev) echo 8080 ;; stage) echo 8180 ;; prod) echo 80 ;; *) echo 8080 ;; esac
}
default_https_port() {
  case "$1" in dev) echo 8443 ;; stage) echo 8543 ;; prod) echo 443 ;; *) echo 8443 ;; esac
}
default_traefik() {
  case "$1" in prod|stage) echo "y" ;; *) echo "n" ;; esac
}
default_replicas() {
  case "$1" in prod) echo 2 ;; *) echo 1 ;; esac
}

for env in "${ENVS[@]}"; do
  echo
  echo -e "  ${BOLD}${CYAN}── Environment: ${env} ──${RESET}"

  ask    "ENV_DOMAIN__${env}"      "  Domain"                     "${env}.${PROJECT_NAME}.com"
  ask    "ENV_HTTP_PORT__${env}"   "  HTTP port"                  "$(default_port "$env")"
  ask    "ENV_HTTPS_PORT__${env}"  "  HTTPS port"                 "$(default_https_port "$env")"
  ask_yn "ENV_TRAEFIK__${env}"     "  Enable Traefik routing?"    "$(default_traefik "$env")"
  ask    "ENV_TRAEFIK_NET__${env}" "  Traefik network name"       "traefik_net"

  ask_choice "ENV_DEPLOYMENT__${env}" "  Deployment engine" "compose" \
    "compose" "Docker Compose" \
    "swarm"   "Docker Swarm"

  if [[ "$PROJECT_TYPE" == "custom" ]]; then
    ask    "ENV_BE_REPLICAS__${env}" "  Backend replicas"           "$(default_replicas "$env")"
    ask    "ENV_FE_REPLICAS__${env}" "  Frontend replicas"          "$(default_replicas "$env")"

    ask_yn "ENV_GIT_ENABLED__${env}" "  Enable git sync for this env?" "n"
    _git_key="ENV_GIT_ENABLED__${env}"
    if [[ "${!_git_key}" == "true" ]]; then
      ask "ENV_GIT_REPO__${env}"   "  Git repository URL"          "git@github.com:org/repo.git"
      case "$env" in
        prod)  _default_branch="main" ;;
        stage) _default_branch="staging" ;;
        *)     _default_branch="develop" ;;
      esac
      ask "ENV_GIT_BRANCH__${env}" "  Branch"                      "$_default_branch"
    else
      printf -v "ENV_GIT_REPO__${env}"   '%s' "git@github.com:org/repo.git"
      printf -v "ENV_GIT_BRANCH__${env}" '%s' "develop"
    fi
  else
    # Image type: set defaults — no replicas per-service, no git
    printf -v "ENV_BE_REPLICAS__${env}" '%s' "$(default_replicas "$env")"
    printf -v "ENV_FE_REPLICAS__${env}" '%s' "1"
    printf -v "ENV_GIT_ENABLED__${env}" '%s' "false"
    printf -v "ENV_GIT_REPO__${env}"    '%s' ""
    printf -v "ENV_GIT_BRANCH__${env}"  '%s' ""
  fi

  # ── .env file variables ───────────────────────────────────────────────────────
  # For image type: these are the actual secret/path values that the compose
  #   environment: blocks reference via ${VAR} interpolation.
  # For custom type: additional vars appended to the generated .env.
  # For prebuilt stacks: template default_env_vars are pre-loaded; user can override.
  _ev_count=0

  # Show pre-built defaults (if any) so the user knows what's already wired up
  if [[ -n "$PREBUILT_DEFAULT_ENV_JSON" && "$PREBUILT_DEFAULT_ENV_JSON" != "{}" ]]; then
    echo
    echo -e "  ${DIM}Pre-loaded .env defaults from template (edit secrets before starting):${RESET}"
    while IFS='=' read -r _dk _dv; do
      [[ -z "$_dk" ]] && continue
      printf "    ${DIM}%-30s = %s${RESET}\n" "$_dk" "$_dv"
    done < <(jq -r '.default_env_vars | to_entries[] | "\(.key)=\(.value)"' "$_tmpl_file" 2>/dev/null || true)
    echo -e "  ${DIM}Add overrides or extra vars below (blank to finish):${RESET}"
  elif ! $DEFAULTS_MODE; then
    echo
    if [[ "$PROJECT_TYPE" == "image" ]]; then
      echo -e "  ${DIM}.env values for '${env}' — secrets and paths your images reference:${RESET}"
      echo -e "  ${DIM}e.g. MYSQL_PASSWORD=secret  DATA_DIR=./data  APP_PORT=8080${RESET}"
    else
      echo -e "  ${DIM}Additional .env variables for '${env}' (KEY=VALUE — blank to finish):${RESET}"
    fi
  fi

  if ! $DEFAULTS_MODE; then
    while true; do
      echo -en "    ${DIM}▸${RESET} KEY=VALUE (blank to stop): "
      read -r _ev_kv
      [[ -z "$_ev_kv" ]] && break
      if [[ "$_ev_kv" == *"="* ]]; then
        _ev_count=$((_ev_count + 1))
        _ev_key="${_ev_kv%%=*}"
        _ev_val="${_ev_kv#*=}"
        printf -v "ENV_VAR_KEY__${env}__${_ev_count}" '%s' "$_ev_key"
        printf -v "ENV_VAR_VAL__${env}__${_ev_count}" '%s' "$_ev_val"
      else
        echo -e "    ${RED}Expected KEY=VALUE format${RESET}"
      fi
    done
  fi
  printf -v "ENV_VAR_COUNT__${env}" '%s' "$_ev_count"
done

# ══ Step 4: Dependency versions ═══════════════════════════════════════════════
if [[ "$PROJECT_TYPE" == "custom" ]]; then
  echo
  echo -e "${BOLD}  Step 4 of 5 — Dependency Versions${RESET}"
  divider
  echo -e "  ${DIM}These become docker image tags. Press Enter to use the defaults.${RESET}"
  echo

  if [[ "$DATABASE" == "postgres" ]]; then
    ask VER_POSTGRES "PostgreSQL image tag" "15-alpine"
    VER_MYSQL="8.0"
  else
    ask VER_MYSQL    "MySQL image tag"      "8.0"
    VER_POSTGRES="15-alpine"
  fi

  [[ "$REDIS_ENABLED" == "true" ]] && ask VER_REDIS "Redis image tag" "7-alpine" || VER_REDIS="7-alpine"
  [[ "$GARAGE_ENABLED" == "true" ]] && ask VER_GARAGE "Garage image tag" "v1.0.1" || VER_GARAGE="v1.0.1"
  ask VER_NGINX "Nginx image tag" "1.25-alpine"

  if [[ "$BACKEND" == "nodejs" ]]; then
    ask VER_NODE "Node.js image tag" "20-alpine"
    VER_PHP="8.3-fpm-alpine"; VER_COMPOSER="2.7"
  else
    ask VER_PHP  "PHP-FPM image tag" "8.3-fpm-alpine"
    ask VER_COMPOSER "Composer image tag" "2.7"
    VER_NODE="20-alpine"
  fi
else
  # Image type: set defaults (stored in config but not used for builds)
  VER_POSTGRES="15-alpine"; VER_MYSQL="8.0";     VER_REDIS="7-alpine"
  VER_GARAGE="v1.0.1";      VER_NGINX="1.25-alpine"
  VER_NODE="20-alpine";     VER_PHP="8.3-fpm-alpine"; VER_COMPOSER="2.7"
fi

# ══ Step 5: Review & confirm ══════════════════════════════════════════════════
echo
echo -e "${BOLD}  Step 5 of 5 — Review${RESET}"
divider
echo
echo -e "  ${BOLD}Project:${RESET}      $PROJECT_NAME"
echo -e "  ${BOLD}Type:${RESET}         $PROJECT_TYPE"
echo -e "  ${BOLD}Registry:${RESET}     $REGISTRY"
echo -e "  ${BOLD}Workspace:${RESET}    $WORKSPACE_PATH"
if [[ "$PROJECT_TYPE" == "custom" ]]; then
  echo -e "  ${BOLD}Backend:${RESET}      $BACKEND"
  echo -e "  ${BOLD}Frontend:${RESET}     $([ "$FRONTEND_ENABLED" == "true" ] && echo "$FRONTEND" || echo "none")"
  echo -e "  ${BOLD}Database:${RESET}     $DATABASE"
  echo -e "  ${BOLD}Redis:${RESET}        $REDIS_ENABLED"
  echo -e "  ${BOLD}Garage:${RESET}       $GARAGE_ENABLED"
else
  echo -e "  ${BOLD}Images:${RESET}"
  for _ri in $(seq 1 "$IMAGE_COUNT"); do
    _k="IMAGE_NAME__${_ri}"; _v_name="${!_k}"
    _k="IMAGE_REF__${_ri}";  _v_ref="${!_k}"
    _k="IMAGE_TAG__${_ri}";  _v_tag="${!_k}"
    _k="IMAGE_PORT__${_ri}"; _v_port="${!_k}"
    echo -e "    ${DIM}${_ri})${RESET} ${_v_name}: ${_v_ref}:${_v_tag} (port ${_v_port})"
  done
fi
echo -e "  ${BOLD}Environments:${RESET} ${ENVS[*]}"
echo

if ! $DEFAULTS_MODE; then
  confirm "  Looks good — generate workspace?" "y" || { echo "Aborted."; exit 0; }
fi

# ══ Generate workspace ════════════════════════════════════════════════════════
log_section "Generating workspace: $WORKSPACE_PATH"

mkdir -p "$WORKSPACE_PATH"

# ── Build images JSON array (image type only) ─────────────────────────────────
IMAGES_JSON="[]"
if [[ "$PROJECT_TYPE" == "image" && "$IMAGE_COUNT" -gt 0 ]]; then
  IMAGES_JSON="["
  _img_first=true
  for _i in $(seq 1 "$IMAGE_COUNT"); do
    $_img_first || IMAGES_JSON+=","
    _img_first=false
    _k="IMAGE_NAME__${_i}";        _v_name="${!_k:-}"
    _k="IMAGE_REF__${_i}";         _v_ref="${!_k:-}"
    _k="IMAGE_TAG__${_i}";         _v_tag="${!_k:-latest}"
    _k="IMAGE_PORT__${_i}";        _v_port="${!_k:-8080}"
    _k="IMAGE_HOST_PORT__${_i}";   _v_hport="${!_k:-}"
    _k="IMAGE_HEALTHCHECK__${_i}"; _v_hc="${!_k:-}"
    _k="IMAGE_CMD__${_i}";         _v_cmd="${!_k:-}"

    # Volumes: prebuilt stacks use a JSON array blob; manual stacks use a single vol string
    _k="IMAGE_VOLS_JSON__${_i}"
    if [[ -n "${!_k:-}" ]]; then
      _vol_arr="${!_k}"
    else
      _k2="IMAGE_VOL__${_i}"; _v_vol="${!_k2:-}"
      [[ -n "$_v_vol" ]] && _vol_arr="[\"${_v_vol}\"]" || _vol_arr="[]"
    fi

    # env_vars: prebuilt stacks use a JSON object blob; manual stacks build from KEY/VAL pairs
    _k="IMAGE_ENVS_JSON__${_i}"
    if [[ -n "${!_k:-}" ]]; then
      _ie_json="${!_k}"
    else
      _k2="IMAGE_ENV_COUNT__${_i}"; _ie_count="${!_k2:-0}"
      _ie_json="{"
      _ie_first=true
      for _j in $(seq 1 "$_ie_count"); do
        $_ie_first || _ie_json+=","
        _ie_first=false
        _k2="IMAGE_ENV_KEY__${_i}__${_j}"; _ie_key="${!_k2:-}"
        _k2="IMAGE_ENV_VAL__${_i}__${_j}"; _ie_val="${!_k2:-}"
        # jq -Rs '.' safely encodes the value — preserves ${VAR} refs as literal strings
        _ie_encoded="$(printf '%s' "$_ie_val" | jq -Rs '.')"
        _ie_json+="\"${_ie_key}\": ${_ie_encoded}"
      done
      _ie_json+="}"
    fi

    # depends_on / extra_ports / healthcheck_config — prebuilt has JSON blobs; manual uses empty defaults
    _k="IMAGE_DEPS_JSON__${_i}"; _deps_json="${!_k:-[]}"
    _k="IMAGE_XPRT_JSON__${_i}"; _xprt_json="${!_k:-[]}"
    _k="IMAGE_HC_JSON__${_i}";   _hc_cfg_json="${!_k:-{}}"

    _v_hc_encoded="$(printf '%s' "$_v_hc"  | jq -Rs '.')"
    _v_cmd_encoded="$(printf '%s' "$_v_cmd" | jq -Rs '.')"

    IMAGES_JSON+="
      {
        \"name\":             \"${_v_name}\",
        \"image\":            \"${_v_ref}\",
        \"tag\":              \"${_v_tag}\",
        \"port\":             ${_v_port},
        \"host_port\":        \"${_v_hport}\",
        \"healthcheck\":      ${_v_hc_encoded},
        \"command\":          ${_v_cmd_encoded},
        \"healthcheck_config\": ${_hc_cfg_json},
        \"volumes\":          ${_vol_arr},
        \"env_vars\":         ${_ie_json},
        \"depends_on\":       ${_deps_json},
        \"extra_ports\":      ${_xprt_json}
      }"
  done
  IMAGES_JSON+="
  ]"
fi

# ── Build environments JSON ───────────────────────────────────────────────────
ENVS_JSON="{"
first=true
for env in "${ENVS[@]}"; do
  $first || ENVS_JSON+=","
  first=false
  # Read flat vars via indirect expansion (Bash 3.2 compatible)
  # Use :- defaults so a missing var produces an empty string rather than aborting.
  _k="ENV_DOMAIN__${env}";       _v_domain="${!_k:-}"
  _k="ENV_HTTP_PORT__${env}";    _v_http="${!_k:-8080}"
  _k="ENV_HTTPS_PORT__${env}";   _v_https="${!_k:-8443}"
  _k="ENV_TRAEFIK__${env}";      _v_traefik="${!_k:-false}"
  _k="ENV_TRAEFIK_NET__${env}";  _v_tnet="${!_k:-traefik_net}"
  _k="ENV_DEPLOYMENT__${env}";   _v_deploy="${!_k:-compose}"
  _k="ENV_BE_REPLICAS__${env}";  _v_be_rep="${!_k:-1}"
  _k="ENV_FE_REPLICAS__${env}";  _v_fe_rep="${!_k:-1}"
  _k="ENV_GIT_ENABLED__${env}";  _v_git_en="${!_k:-false}"
  _k="ENV_GIT_REPO__${env}";     _v_git_repo="${!_k:-}"
  _k="ENV_GIT_BRANCH__${env}";   _v_git_br="${!_k:-}"

  # Build env_vars JSON object from collected KEY=VALUE pairs.
  # For prebuilt stacks: template default_env_vars are the base; user additions/overrides
  # are merged on top using jq so there are no duplicate keys in the final JSON.
  _k="ENV_VAR_COUNT__${env}"; _ev_count="${!_k:-0}"
  _ev_user_json="{"
  _ev_first=true
  for _i in $(seq 1 "$_ev_count"); do
    _k="ENV_VAR_KEY__${env}__${_i}"; _ev_key="${!_k:-}"
    _k="ENV_VAR_VAL__${env}__${_i}"; _ev_val="${!_k:-}"
    # Skip if key is empty (defensive: handles any edge-case where count is ahead of storage)
    [[ -z "$_ev_key" ]] && continue
    $_ev_first || _ev_user_json+=","
    _ev_first=false
    # jq -Rs '.' safely JSON-encodes the value (escapes quotes, backslashes, etc.)
    _ev_encoded="$(printf '%s' "$_ev_val" | jq -Rs '.')"
    _ev_user_json+="\"${_ev_key}\": ${_ev_encoded}"
  done
  _ev_user_json+="}"

  if [[ -n "$PREBUILT_DEFAULT_ENV_JSON" && "$PREBUILT_DEFAULT_ENV_JSON" != "{}" ]]; then
    # Merge: template defaults + user additions (user wins on key conflicts)
    _ev_json="$(printf '%s\n%s\n' "$PREBUILT_DEFAULT_ENV_JSON" "$_ev_user_json" | jq -s '.[0] * .[1]')"
  else
    _ev_json="$_ev_user_json"
  fi

  ENVS_JSON+="
    \"${env}\": {
      \"domain\":           \"${_v_domain}\",
      \"http_port\":        ${_v_http},
      \"https_port\":       ${_v_https},
      \"backend\":          \"${BACKEND}\",
      \"frontend_enabled\": ${FRONTEND_ENABLED},
      \"frontend\":         \"${FRONTEND}\",
      \"database\":         \"${DATABASE}\",
      \"redis_enabled\":    ${REDIS_ENABLED},
      \"garage_enabled\":   ${GARAGE_ENABLED},
      \"deployment\":       \"${_v_deploy}\",
      \"traefik_enabled\":  ${_v_traefik},
      \"traefik_network\":  \"${_v_tnet}\",
      \"git\": {
        \"enabled\":        ${_v_git_en},
        \"repo\":           \"${_v_git_repo}\",
        \"branch\":         \"${_v_git_br}\",
        \"backend_path\":   \"./src/backend\",
        \"frontend_path\":  \"./src/frontend\"
      },
      \"replicas\": {
        \"backend\":  ${_v_be_rep},
        \"frontend\": ${_v_fe_rep}
      },
      \"env_vars\": ${_ev_json}
    }"
done
ENVS_JSON+="
  }"

# ── Write workspace config.json ───────────────────────────────────────────────
cat > "$WORKSPACE_PATH/config.json" <<JSON
{
  "project": {
    "name": "${PROJECT_NAME}",
    "type": "${PROJECT_TYPE}",
    "registry": "${REGISTRY}",
    "version": {
      "major": 1,
      "minor": 0,
      "patch": 0,
      "build": 0
    }
  },
  "images": ${IMAGES_JSON},
  "versions": {
    "postgres":     "${VER_POSTGRES}",
    "mysql":        "${VER_MYSQL}",
    "redis":        "${VER_REDIS}",
    "garage":       "${VER_GARAGE}",
    "garage_webui": "latest",
    "nginx":        "${VER_NGINX}",
    "node":         "${VER_NODE}",
    "php":          "${VER_PHP}",
    "composer":     "${VER_COMPOSER}"
  },
  "environments": ${ENVS_JSON}
}
JSON

log_success "config.json written"

# ── Generate run.sh ───────────────────────────────────────────────────────────
cat > "$WORKSPACE_PATH/run.sh" <<'RUNSH'
#!/usr/bin/env bash
# =============================================================================
# run.sh — Command runner for this workspace
# Generated by init_workspace.sh — do not move without also updating TOOLKIT_ROOT.
#
# Usage:
#   ./run.sh <command> [env] [options]
#
# Commands:
#   init    <env>                  Re-bootstrap an environment
#   start   <env>                  Start / deploy the stack
#   stop    <env>                  Stop / tear down the stack
#   restart <env> [service]        Rolling restart (all or a single service)
#   ps      <env>                  Show running containers
#   logs    <env> [service]        Follow logs
#   build   <env> [--push] [--bump [major|minor|patch|build]]
#   sync    <env> [--pull-only] [--no-deploy]
#   backup  <env> [db|files|all]
#   refresh <env>                  Regen docker-compose.yml + redeploy
#   exec    <env> <service> <cmd>  Run command inside a container
#   version [current|bump|set]     Manage semver
#   help                           Show this message
# =============================================================================

set -euo pipefail

WORKSPACE_ROOT="$(cd "$(dirname "$0")" && pwd)"
# Walk up from workspaces/<name>/ to find toolkit root
TOOLKIT_ROOT="$(cd "$WORKSPACE_ROOT/../.." && pwd)"

# If the workspace is not inside workspaces/, try to find toolkit via marker
if [[ ! -f "$TOOLKIT_ROOT/scripts/lib.sh" ]]; then
  echo "ERROR: Cannot locate toolkit root from $WORKSPACE_ROOT"
  echo "Expected scripts/lib.sh at: $TOOLKIT_ROOT"
  exit 1
fi

export WORKSPACE_ROOT TOOLKIT_ROOT
source "$TOOLKIT_ROOT/scripts/lib.sh"

CMD="${1:-help}"
ENV="${2:-}"
shift 2 2>/dev/null || shift 1 2>/dev/null || true
EXTRA=("$@")

need_env() {
  [[ -n "$ENV" ]] || { echo "Usage: ./run.sh $CMD <env> [options]"; exit 1; }
}

case "$CMD" in

  init|bootstrap)
    need_env
    bash "$TOOLKIT_ROOT/scripts/bootstrap.sh" "$ENV" "${EXTRA[@]:-}"
    ;;

  start|up|deploy)
    need_env
    bash "$TOOLKIT_ROOT/scripts/deploy.sh" "$ENV" up "${EXTRA[@]:-}"
    ;;

  stop|down)
    need_env
    bash "$TOOLKIT_ROOT/scripts/deploy.sh" "$ENV" down "${EXTRA[@]:-}"
    ;;

  restart)
    need_env
    bash "$TOOLKIT_ROOT/scripts/deploy.sh" "$ENV" restart "${EXTRA[@]:-}"
    ;;

  ps|status)
    need_env
    bash "$TOOLKIT_ROOT/scripts/deploy.sh" "$ENV" ps
    ;;

  logs)
    need_env
    bash "$TOOLKIT_ROOT/scripts/deploy.sh" "$ENV" logs "${EXTRA[@]:-}"
    ;;

  build)
    need_env
    bash "$TOOLKIT_ROOT/scripts/build.sh" "$ENV" "${EXTRA[@]:-}"
    ;;

  sync|pull)
    need_env
    bash "$TOOLKIT_ROOT/scripts/sync.sh" "$ENV" "${EXTRA[@]:-}"
    ;;

  promote)
    need_env
    DST_ENV="${EXTRA[0]:-}"
    [[ -n "$DST_ENV" ]] || { echo "Usage: ./run.sh promote <src_env> <dst_env> [--dry-run]"; exit 1; }
    bash "$TOOLKIT_ROOT/scripts/promote.sh" "$ENV" "${EXTRA[@]:-}"
    ;;

  backup)
    need_env
    bash "$TOOLKIT_ROOT/scripts/backup.sh" "$ENV" "${EXTRA[@]:-all}"
    ;;

  refresh)
    need_env
    echo "Regenerating docker-compose.yml for '$ENV'..."
    bash "$TOOLKIT_ROOT/scripts/compose-gen.sh" "$ENV"
    bash "$TOOLKIT_ROOT/scripts/deploy.sh" "$ENV" up
    ;;

  exec)
    need_env
    bash "$TOOLKIT_ROOT/scripts/deploy.sh" "$ENV" exec "${EXTRA[@]:-}"
    ;;

  version|ver)
    bash "$TOOLKIT_ROOT/scripts/version.sh" "${ENV:-current}" "${EXTRA[@]:-}"
    ;;

  help|--help|-h|"")
    cat <<HELP

  ${BOLD}Usage:${RESET} ./run.sh <command> [env] [options]

  ${BOLD}Lifecycle:${RESET}
    start   <env>                   Deploy / bring up the stack
    stop    <env>                   Tear down the stack
    restart <env> [service]         Rolling restart
    refresh <env>                   Regenerate compose file + redeploy

  ${BOLD}Build & Release:${RESET}
    build   <env> [backend|frontend] [--push] [--bump [part]]
    promote <src_env> <dst_env> [--dry-run]   Retag + redeploy (no rebuild)
    sync    <env> [--pull-only] [--no-deploy]

  ${BOLD}Operations:${RESET}
    ps      <env>                   Show running containers / services
                                    (image stacks: also checks for updates)
    logs    <env> [service]         Follow container logs
    exec    <env> <service> <cmd>   Shell into a service
    backup  <env> [db|files|all]    Run backup

  ${BOLD}Configuration:${RESET}
    init    <env>                   Re-bootstrap environment (regen files)
    version [current|bump|set]      Manage project semver in config.json

  ${BOLD}Environments:${RESET} $(jq -r '.environments | keys | join(", ")' "$WORKSPACE_ROOT/config.json")
HELP
    ;;

  *)
    echo "Unknown command: $CMD  (run ./run.sh help)"
    exit 1
    ;;
esac
RUNSH

chmod +x "$WORKSPACE_PATH/run.sh"
log_success "run.sh generated"

# ── Bootstrap each environment ────────────────────────────────────────────────
export WORKSPACE_ROOT="$WORKSPACE_PATH"
export _INIT_SH_RUNNING=true
for env in "${ENVS[@]}"; do
  bash "$TOOLKIT_ROOT/scripts/bootstrap.sh" "$env"
done

# ══ Done ══════════════════════════════════════════════════════════════════════
divider
echo
log_success "Workspace ready: ${BOLD}${WORKSPACE_PATH}${RESET}"
echo
echo -e "  ${BOLD}Next steps:${RESET}"
echo -e "  ${DIM}1.${RESET}  cd ${WORKSPACE_PATH}"
if [[ "$PROJECT_TYPE" == "image" ]]; then
  echo -e "  ${DIM}2.${RESET}  Edit ${BOLD}envs/<env>/.env${RESET} — add any secrets or additional env vars"
  echo -e "  ${DIM}3.${RESET}  ${BOLD}./run.sh start dev${RESET}"
  echo -e "  ${DIM}4.${RESET}  ${BOLD}./run.sh ps dev${RESET}    — check status + image update notifications"
else
  echo -e "  ${DIM}2.${RESET}  Edit ${BOLD}envs/<env>/.env${RESET} — fill in DB passwords, app keys, etc."
  echo -e "  ${DIM}3.${RESET}  Place your source code in ${BOLD}envs/<env>/backend/${RESET} (and ${BOLD}frontend/${RESET} if applicable)"
  echo -e "  ${DIM}4.${RESET}  ${BOLD}./run.sh build dev${RESET}"
  echo -e "  ${DIM}5.${RESET}  ${BOLD}./run.sh start dev${RESET}"
fi
echo
echo -e "  ${DIM}Edit${RESET} ${BOLD}config.json${RESET} ${DIM}at any time to change image tags or env settings,${RESET}"
echo -e "  ${DIM}then run${RESET} ${BOLD}./run.sh refresh <env>${RESET} ${DIM}to regenerate and redeploy.${RESET}"
echo
