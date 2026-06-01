#!/usr/bin/env bash
# =============================================================================
# backup.sh — Backup databases and persistent file volumes
#
# Usage (via run.sh):
#   ./run.sh backup <env>              # backup DB + uploads + garage (if enabled)
#   ./run.sh backup <env> db           # database only
#   ./run.sh backup <env> files        # uploads + garage only
#
# Backups are written to: WORKSPACE_ROOT/backups/<env>/<YYYY-MM-DD_HH-MM-SS>/
# =============================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_cmd jq docker

ENV="${1:-}"
[[ -n "$ENV" ]] || { echo "Usage: scripts/backup.sh <env> [db|files|all]"; exit 1; }
validate_env "$ENV"

TARGET="${2:-all}"

PROJECT="$(cfg_get '.project.name')"
PREFIX="${PROJECT}_${ENV}"
PROJECT_TYPE="$(cfg_get '.project.type // "custom"')"
DATABASE="$(cfg_env_get "$ENV" '.database // "none"')"
GARAGE_ENABLED="$(cfg_env_get "$ENV" '.garage_enabled // "false"')"

BACKUP_ROOT="$WORKSPACE_ROOT/backups/$ENV"
DATE_DIR="$(date -u '+%Y-%m-%d_%H-%M-%S')"
BACKUP_DIR="$BACKUP_ROOT/$DATE_DIR"
mkdir -p "$BACKUP_DIR"

ensure_env_file "$ENV"
# shellcheck disable=SC1090
source "$(env_file "$ENV")"

ENV_DIR="$(env_dir "$ENV")"

log_section "Backup: $ENV → $BACKUP_DIR"

# ── Compose exec helper — uses project name so container naming doesn't matter ─
# Service names in the generated compose file include the stack prefix
# (e.g. "techcellence-home_prod_db"). _compose_exec accepts either the short
# name ("db") or the full prefixed name and normalises automatically.
_compose_exec() {
  local svc="$1"; shift
  # If the service name doesn't already carry the stack prefix, add it.
  # This mirrors the resolve_svc() logic in deploy.sh.
  if [[ "$svc" != "${PREFIX}_"* ]]; then
    svc="${PREFIX}_${svc}"
  fi
  docker compose -p "$PREFIX" -f "$ENV_DIR/docker-compose.yml" exec -T "$svc" "$@"
}

# ── DB backup helpers ──────────────────────────────────────────────────────────
# SQL dump is attempted first using the container's own binary and env vars.
# If the dump fails for any reason, a filesystem archive fallback is used:
#   the DB service is stopped briefly, its bind-mount directories are tar'd,
#   then the service is restarted. This ensures a consistent snapshot without
#   needing to know which dump tool the container uses.

# _fs_archive_svc <svc_name> <label> <img_idx>
# Archives all bind-mount volumes for the given service image index.
# Stops the service before archiving and restarts it after.
_fs_archive_svc() {
  local svc="$1" label="$2" img_idx="$3"
  local full_svc="${PREFIX}_${svc}"

  log_warn "  Stopping $svc for consistent filesystem snapshot..."
  docker compose -p "$PREFIX" -f "$ENV_DIR/docker-compose.yml" stop "$full_svc" 2>/dev/null \
    || docker compose -p "$PREFIX" -f "$ENV_DIR/docker-compose.yml" stop "$svc" 2>/dev/null \
    || true

  local archived=0
  local vol_count
  vol_count="$(cfg_get ".images[${img_idx}].volumes | length // 0" 2>/dev/null || echo 0)"
  local vidx=0
  while [[ $vidx -lt $vol_count ]]; do
    local vol_entry vol_src
    vol_entry="$(cfg_get ".images[${img_idx}].volumes[${vidx}]")"
    vol_src="${vol_entry%%:*}"
    vidx=$((vidx + 1))

    local fs_file="$BACKUP_DIR/${PROJECT}_${ENV}_${label}_fs_${archived}_${DATE_DIR}.tar.gz"

    if [[ "$vol_src" == ./* || "$vol_src" == /* ]]; then
      local host_path
      [[ "$vol_src" == ./* ]] && host_path="${ENV_DIR}/${vol_src#./}" || host_path="$vol_src"
      if [[ -d "$host_path" ]]; then
        tar czf "$fs_file" -C "$host_path" .
        log_success "  Filesystem archive: $(basename "$fs_file") ($(du -sh "$fs_file" | cut -f1))"
        archived=$((archived + 1))
      fi
    elif [[ "$vol_src" != .* && "$vol_src" != /* ]]; then
      local full_vol="${PREFIX}_${vol_src}"
      if docker volume inspect "$full_vol" &>/dev/null; then
        docker run --rm -v "${full_vol}:/data:ro" alpine:3 tar czf - -C /data . > "$fs_file"
        log_success "  Volume archive: $(basename "$fs_file") ($(du -sh "$fs_file" | cut -f1))"
        archived=$((archived + 1))
      fi
    fi
  done

  log_warn "  Restarting $svc..."
  docker compose -p "$PREFIX" -f "$ENV_DIR/docker-compose.yml" start "$full_svc" 2>/dev/null \
    || docker compose -p "$PREFIX" -f "$ENV_DIR/docker-compose.yml" start "$svc" 2>/dev/null \
    || true

  if [[ $archived -gt 0 ]]; then
    log_warn "⚠ DB backup used filesystem archive fallback — not a SQL dump."
    log_warn "  Restore: stop the service, unpack the archive over the bind mount, restart."
    return 0
  else
    log_warn "⚠ Filesystem archive also failed — no backup created for $svc"
    return 1
  fi
}

# _try_sql_dump <type> <svc> <label> — attempts SQL dump; returns 0 on success.
# type: "postgres" | "mysql"
_try_sql_dump() {
  local db_type="$1" svc="$2" label="$3"
  local sql_file="$BACKUP_DIR/${PROJECT}_${ENV}_${label}_${DATE_DIR}.sql.gz"

  log_info "Attempting SQL dump ($db_type) from $svc..."

  local dump_ok=true
  if [[ "$db_type" == "postgres" ]]; then
    # Use the container's own pg_dump with its own POSTGRES_USER / POSTGRES_DB env vars
    if ! _compose_exec "$svc" sh -c \
        'pg_dump -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}"' \
        | gzip > "$sql_file"; then
      dump_ok=false
    fi
  else
    # MySQL/MariaDB: auto-detect dump binary inside the container
    if ! _compose_exec "$svc" sh -c '
      if   command -v mariadb-dump >/dev/null 2>&1; then _DUMP=mariadb-dump
      elif command -v mysqldump    >/dev/null 2>&1; then _DUMP=mysqldump
      else echo "no dump binary found in container" >&2; exit 1; fi
      $_DUMP -u root -p"${MYSQL_ROOT_PASSWORD}" "${MYSQL_DATABASE}"
    ' | gzip > "$sql_file"; then
      dump_ok=false
    fi
  fi

  # Also treat an empty output file as failure (dump ran but wrote nothing)
  if [[ "$dump_ok" == "true" ]] && [[ -s "$sql_file" ]]; then
    log_success "SQL dump: $(basename "$sql_file") ($(du -sh "$sql_file" | cut -f1))"
    return 0
  fi

  rm -f "$sql_file"
  return 1
}

backup_db() {
  if [[ "$PROJECT_TYPE" == "image" ]]; then
    # ── Image stack: scan images[] to find DB services ─────────────────────────
    local found_db=false
    local img_count
    img_count="$(cfg_get '.images | length // 0')"
    local idx=0
    while [[ $idx -lt $img_count ]]; do
      local svc_name img_name
      svc_name="$(cfg_get ".images[${idx}].name")"
      img_name="$(cfg_get  ".images[${idx}].image" | tr '[:upper:]' '[:lower:]')"
      local cur_idx=$idx
      idx=$((idx + 1))

      local db_type=""
      if   [[ "$img_name" == *"postgres"* ]]; then db_type="postgres"
      elif [[ "$img_name" == *"mysql"* || "$img_name" == *"mariadb"* ]]; then db_type="mysql"
      fi
      [[ -z "$db_type" ]] && continue

      found_db=true
      log_info "Found $db_type service: $svc_name"

      if ! _try_sql_dump "$db_type" "$svc_name" "$svc_name"; then
        log_warn "⚠ SQL dump failed for $svc_name — falling back to filesystem archive"
        _fs_archive_svc "$svc_name" "$svc_name" "$cur_idx"
      fi
    done

    [[ "$found_db" == "false" ]] && \
      log_info "No recognized database containers in image stack — skipping DB backup"

  else
    # ── Custom stack: use the database field from config ───────────────────────
    log_info "Backing up $DATABASE database..."

    if [[ "$DATABASE" == "postgres" ]]; then
      if ! _try_sql_dump "postgres" "postgres" "postgres"; then
        log_warn "⚠ SQL dump failed — filesystem fallback not available for custom stacks"
      fi
    elif [[ "$DATABASE" == "mysql" ]]; then
      if ! _try_sql_dump "mysql" "mysql" "mysql"; then
        log_warn "⚠ SQL dump failed — filesystem fallback not available for custom stacks"
      fi
    else
      log_info "No database configured (database=$DATABASE) — skipping DB backup"
    fi
  fi
}

backup_files() {
  if [[ "$PROJECT_TYPE" == "image" ]]; then
    # ── Image stack: back up every volume defined in images[] ──────────────────
    # Volumes can be either:
    #   Bind mounts: "./volumes/db_data:/var/lib/mysql"  (source starts with . or /)
    #   Named volumes: "db_data:/var/lib/mysql"          (plain name, prefixed at runtime)
    local img_count vol_count backed=0
    local seen_vols=" "   # dedup: same bind path may appear in multiple services
    img_count="$(cfg_get '.images | length // 0')"
    local idx=0
    while [[ $idx -lt $img_count ]]; do
      vol_count="$(cfg_get ".images[${idx}].volumes | length // 0")"
      local vidx=0
      while [[ $vidx -lt $vol_count ]]; do
        local vol_entry vol_src
        vol_entry="$(cfg_get ".images[${idx}].volumes[${vidx}]")"
        vol_src="${vol_entry%%:*}"   # everything before the first colon

        # Deduplicate: skip if we've already backed this source up
        if [[ "$seen_vols" == *" ${vol_src} "* ]]; then
          vidx=$((vidx + 1)); continue
        fi
        seen_vols="${seen_vols}${vol_src} "

        # Sanitise vol_src for use in filenames (replace / and . with _)
        local vol_label
        vol_label="${vol_src//\//_}"
        vol_label="${vol_label//\./_}"
        vol_label="${vol_label#__volumes_}"   # strip leading __volumes_ for cleaner names
        local vol_file="$BACKUP_DIR/${PROJECT}_${ENV}_${vol_label}_${DATE_DIR}.tar.gz"

        if [[ "$vol_src" == ./* || "$vol_src" == /* ]]; then
          # ── Bind mount: source is a host path relative to the env dir ─────────
          # Resolve relative paths against the env directory
          local host_path
          if [[ "$vol_src" == ./* ]]; then
            host_path="${ENV_DIR}/${vol_src#./}"
          else
            host_path="$vol_src"
          fi

          if [[ -d "$host_path" ]]; then
            log_info "Archiving bind mount: $host_path"
            tar czf "$vol_file" -C "$host_path" .
            log_success "Bind mount archive: $(basename "$vol_file") ($(du -sh "$vol_file" | cut -f1))"
            backed=$((backed + 1))
          else
            log_warn "Bind mount path $host_path not found — skipping (stack may not be deployed)"
          fi
        else
          # ── Named Docker volume: prefixed with stack name ─────────────────────
          local full_vol="${PREFIX}_${vol_src}"
          if docker volume inspect "$full_vol" &>/dev/null; then
            log_info "Archiving named volume: $full_vol"
            docker run --rm \
              -v "${full_vol}:/data:ro" \
              alpine:3 \
              tar czf - -C /data . > "$vol_file"
            log_success "Volume archive: $(basename "$vol_file") ($(du -sh "$vol_file" | cut -f1))"
            backed=$((backed + 1))
          else
            log_warn "Named volume $full_vol not found — skipping (stack may not be deployed)"
          fi
        fi

        vidx=$((vidx + 1))
      done
      idx=$((idx + 1))
    done
    [[ $backed -eq 0 ]] && log_info "No volumes found to archive"

  else
    # ── Custom stack: back up the uploads volume ───────────────────────────────
    log_info "Archiving upload volume..."
    local upload_file="$BACKUP_DIR/${PROJECT}_${ENV}_uploads_${DATE_DIR}.tar.gz"
    docker run --rm \
      -v "${PREFIX}_uploads:/data:ro" \
      alpine:3 \
      tar czf - -C /data . > "$upload_file"
    log_success "Uploads archive: $(basename "$upload_file") ($(du -sh "$upload_file" | cut -f1))"

    if [[ "$GARAGE_ENABLED" == "true" ]]; then
      log_info "Archiving Garage S3 data..."
      local garage_file="$BACKUP_DIR/${PROJECT}_${ENV}_garage_${DATE_DIR}.tar.gz"
      docker run --rm \
        -v "${PREFIX}_garage_data:/garage-data:ro" \
        -v "${PREFIX}_garage_meta:/garage-meta:ro" \
        alpine:3 \
        sh -c "tar czf - -C / garage-data garage-meta" > "$garage_file"
      log_success "Garage archive: $(basename "$garage_file") ($(du -sh "$garage_file" | cut -f1))"
    fi
  fi
}

prune_old_backups() {
  log_info "Pruning backups older than 30 days..."
  find "$BACKUP_ROOT" -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true
  log_success "Pruning complete"
}

case "$TARGET" in
  db)    backup_db ;;
  files) backup_files ;;
  all)
    backup_db
    backup_files
    prune_old_backups
    ;;
  *)
    die "Unknown target '$TARGET'. Use: db | files | all"
    ;;
esac

log_section "Backup Complete"
echo "  Location: $BACKUP_DIR"
ls -lh "$BACKUP_DIR"
