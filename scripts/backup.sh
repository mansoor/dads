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
# docker compose -p resolves the correct container regardless of Compose v1/v2 naming.
_compose_exec() {
  docker compose -p "$PREFIX" -f "$ENV_DIR/docker-compose.yml" exec -T "$@"
}

# ── DB backup helpers ──────────────────────────────────────────────────────────

_backup_postgres() {
  local svc="$1" db_user="$2" db_name="$3" label="${4:-postgres}"
  local file="$BACKUP_DIR/${PROJECT}_${ENV}_${label}_${DATE_DIR}.sql.gz"
  _compose_exec "$svc" pg_dump -U "$db_user" "$db_name" | gzip > "$file"
  log_success "PostgreSQL dump: $(basename "$file") ($(du -sh "$file" | cut -f1))"
}

_backup_mysql() {
  local svc="$1" root_pass="$2" db_name="$3" label="${4:-mysql}"
  local file="$BACKUP_DIR/${PROJECT}_${ENV}_${label}_${DATE_DIR}.sql.gz"
  _compose_exec "$svc" mysqldump -u root -p"$root_pass" "$db_name" | gzip > "$file"
  log_success "MySQL/MariaDB dump: $(basename "$file") ($(du -sh "$file" | cut -f1))"
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
      local container="${PREFIX}_${svc_name}"
      idx=$((idx + 1))

      if [[ "$img_name" == *"postgres"* ]]; then
        found_db=true
        log_info "Found PostgreSQL service: $svc_name"
        local pg_user="${POSTGRES_USER:-postgres}"
        local pg_db="${POSTGRES_DB:-${PROJECT}}"
        _backup_postgres "$svc_name" "$pg_user" "$pg_db" "${svc_name}"

      elif [[ "$img_name" == *"mysql"* || "$img_name" == *"mariadb"* ]]; then
        found_db=true
        log_info "Found MySQL/MariaDB service: $svc_name"
        local my_pass="${MYSQL_ROOT_PASSWORD:-}"
        local my_db="${MYSQL_DATABASE:-${PROJECT}}"
        if [[ -z "$my_pass" ]]; then
          log_warn "MYSQL_ROOT_PASSWORD not set in .env — skipping $svc_name"
          continue
        fi
        _backup_mysql "$svc_name" "$my_pass" "$my_db" "${svc_name}"
      fi
    done

    if [[ "$found_db" == "false" ]]; then
      log_info "No recognized database containers in image stack — skipping DB backup"
    fi

  else
    # ── Custom stack: use the database field from config ───────────────────────
    log_info "Backing up $DATABASE database..."

    if [[ "$DATABASE" == "postgres" ]]; then
      _backup_postgres "postgres" "$POSTGRES_USER" "$POSTGRES_DB"

    elif [[ "$DATABASE" == "mysql" ]]; then
      _backup_mysql "mysql" "$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"

    else
      log_info "No database configured (database=$DATABASE) — skipping DB backup"
    fi
  fi
}

backup_files() {
  if [[ "$PROJECT_TYPE" == "image" ]]; then
    # ── Image stack: back up every named volume defined in images[] ────────────
    local img_count vol_count backed=0
    img_count="$(cfg_get '.images | length // 0')"
    local idx=0
    while [[ $idx -lt $img_count ]]; do
      local svc_name
      svc_name="$(cfg_get ".images[${idx}].name")"
      vol_count="$(cfg_get ".images[${idx}].volumes | length // 0")"
      local vidx=0
      while [[ $vidx -lt $vol_count ]]; do
        local vol_entry vol_name
        vol_entry="$(cfg_get ".images[${idx}].volumes[${vidx}]")"
        # Volume entries are "vol_name:/container/path" — extract the vol_name part
        vol_name="${vol_entry%%:*}"
        local full_vol="${PREFIX}_${vol_name}"
        # Verify the volume exists before trying to back it up
        if docker volume inspect "$full_vol" &>/dev/null; then
          local vol_file="$BACKUP_DIR/${PROJECT}_${ENV}_${vol_name}_${DATE_DIR}.tar.gz"
          log_info "Archiving volume: $full_vol"
          docker run --rm \
            -v "${full_vol}:/data:ro" \
            alpine:3 \
            tar czf - -C /data . > "$vol_file"
          log_success "Volume archive: $(basename "$vol_file") ($(du -sh "$vol_file" | cut -f1))"
          backed=$((backed + 1))
        else
          log_warn "Volume $full_vol not found — skipping (stack may not be deployed)"
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
