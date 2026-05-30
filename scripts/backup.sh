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
DATABASE="$(cfg_env_get "$ENV" '.database')"
GARAGE_ENABLED="$(cfg_env_get "$ENV" '.garage_enabled')"

BACKUP_ROOT="$WORKSPACE_ROOT/backups/$ENV"
DATE_DIR="$(date -u '+%Y-%m-%d_%H-%M-%S')"
BACKUP_DIR="$BACKUP_ROOT/$DATE_DIR"
mkdir -p "$BACKUP_DIR"

ensure_env_file "$ENV"
# shellcheck disable=SC1090
source "$(env_file "$ENV")"

log_section "Backup: $ENV → $BACKUP_DIR"

backup_db() {
  log_info "Backing up $DATABASE database..."

  if [[ "$DATABASE" == "postgres" ]]; then
    local container="${PREFIX}_postgres"
    local file="$BACKUP_DIR/${PROJECT}_${ENV}_postgres_${DATE_DIR}.sql.gz"
    docker exec "$container" \
      pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
      | gzip > "$file"
    log_success "PostgreSQL dump: $(basename "$file") ($(du -sh "$file" | cut -f1))"

  elif [[ "$DATABASE" == "mysql" ]]; then
    local container="${PREFIX}_mysql"
    local file="$BACKUP_DIR/${PROJECT}_${ENV}_mysql_${DATE_DIR}.sql.gz"
    docker exec "$container" \
      mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" \
      | gzip > "$file"
    log_success "MySQL dump: $(basename "$file") ($(du -sh "$file" | cut -f1))"
  fi
}

backup_files() {
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
