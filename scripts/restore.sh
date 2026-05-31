#!/usr/bin/env bash
# =============================================================================
# restore.sh — Restore a workspace environment from a backup snapshot
#
# Usage (via run.sh):
#   ./run.sh restore <env> <snapshot_date>
#
# Example:
#   ./run.sh restore prod 2024-01-15_10-30-00
#
# The snapshot directory must exist at:
#   WORKSPACE_ROOT/backups/<env>/<snapshot_date>/
# =============================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_cmd jq docker

ENV="${1:-}"
SNAPSHOT="${2:-}"
[[ -n "$ENV" ]]      || { echo "Usage: scripts/restore.sh <env> <snapshot_date>"; exit 1; }
[[ -n "$SNAPSHOT" ]] || { echo "Usage: scripts/restore.sh <env> <snapshot_date>"; exit 1; }
validate_env "$ENV"

PROJECT="$(cfg_get '.project.name')"
PREFIX="${PROJECT}_${ENV}"
PROJECT_TYPE="$(cfg_get '.project.type // "custom"')"
DATABASE="$(cfg_env_get "$ENV" '.database // "none"')"

BACKUP_DIR="$WORKSPACE_ROOT/backups/$ENV/$SNAPSHOT"
[[ -d "$BACKUP_DIR" ]] || die "Backup snapshot not found: $BACKUP_DIR"

ensure_env_file "$ENV"
# shellcheck disable=SC1090
source "$(env_file "$ENV")"

ENV_DIR="$(env_dir "$ENV")"

log_section "Restore: $ENV ← $SNAPSHOT"
echo "  Backup dir : $BACKUP_DIR"
echo "  Project    : $PROJECT  ($PROJECT_TYPE)"
echo ""

# ── Compose helpers ────────────────────────────────────────────────────────────

_compose_exec() {
  docker compose -p "$PREFIX" -f "$ENV_DIR/docker-compose.yml" exec -T "$@"
}

_compose_up_svc() {
  docker compose -p "$PREFIX" -f "$ENV_DIR/docker-compose.yml" up -d "$1"
  sleep 4  # give the container time to initialise before restoring
}

# ── DB restore helpers ─────────────────────────────────────────────────────────

_restore_postgres() {
  local svc="$1" db_user="$2" db_name="$3" file="$4"
  log_info "Starting service: $svc"
  _compose_up_svc "$svc"

  log_info "Dropping and recreating schema in $db_name…"
  _compose_exec "$svc" psql -U "$db_user" -d "$db_name" \
    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>/dev/null || true

  log_info "Restoring dump: $(basename "$file")"
  gunzip -c "$file" | _compose_exec "$svc" psql -U "$db_user" "$db_name"
  log_success "PostgreSQL restore complete: $svc"
}

_restore_mysql() {
  local svc="$1" root_pass="$2" db_name="$3" file="$4"
  log_info "Starting service: $svc"
  _compose_up_svc "$svc"

  log_info "Restoring dump: $(basename "$file")"
  gunzip -c "$file" | _compose_exec "$svc" mysql -u root -p"$root_pass" "$db_name"
  log_success "MySQL/MariaDB restore complete: $svc"
}

# ── DB restore ─────────────────────────────────────────────────────────────────

restore_db() {
  if [[ "$PROJECT_TYPE" == "image" ]]; then
    local img_count
    img_count="$(cfg_get '.images | length // 0')"
    local idx=0
    while [[ $idx -lt $img_count ]]; do
      local svc_name img_name
      svc_name="$(cfg_get ".images[${idx}].name")"
      img_name="$(cfg_get  ".images[${idx}].image" | tr '[:upper:]' '[:lower:]')"
      idx=$((idx + 1))

      # Find the dump file that matches this service label
      local dump_file
      dump_file="$(find "$BACKUP_DIR" -name "*_${svc_name}_*.sql.gz" 2>/dev/null | head -1 || true)"
      [[ -n "$dump_file" ]] || continue

      if [[ "$img_name" == *"postgres"* ]]; then
        local pg_user="${POSTGRES_USER:-postgres}"
        local pg_db="${POSTGRES_DB:-${PROJECT}}"
        _restore_postgres "$svc_name" "$pg_user" "$pg_db" "$dump_file"
      elif [[ "$img_name" == *"mysql"* || "$img_name" == *"mariadb"* ]]; then
        local my_pass="${MYSQL_ROOT_PASSWORD:-}"
        local my_db="${MYSQL_DATABASE:-${PROJECT}}"
        if [[ -z "$my_pass" ]]; then
          log_warn "MYSQL_ROOT_PASSWORD not set — skipping $svc_name"
          continue
        fi
        _restore_mysql "$svc_name" "$my_pass" "$my_db" "$dump_file"
      fi
    done

  else
    # Custom stack: use the database field from config
    if [[ "$DATABASE" == "postgres" ]]; then
      local dump_file
      dump_file="$(find "$BACKUP_DIR" -name "*_postgres_*.sql.gz" 2>/dev/null | head -1 || true)"
      if [[ -z "$dump_file" ]]; then
        log_warn "No PostgreSQL dump found in snapshot — skipping DB restore"
      else
        _restore_postgres "postgres" "$POSTGRES_USER" "$POSTGRES_DB" "$dump_file"
      fi

    elif [[ "$DATABASE" == "mysql" ]]; then
      local dump_file
      dump_file="$(find "$BACKUP_DIR" -name "*_mysql_*.sql.gz" 2>/dev/null | head -1 || true)"
      if [[ -z "$dump_file" ]]; then
        log_warn "No MySQL dump found in snapshot — skipping DB restore"
      else
        _restore_mysql "mysql" "$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" "$dump_file"
      fi

    else
      log_info "No database configured (database=$DATABASE) — skipping DB restore"
    fi
  fi
}

# ── Volume restore ─────────────────────────────────────────────────────────────

restore_volumes() {
  local restored=0
  for archive in "$BACKUP_DIR"/*.tar.gz; do
    [[ -f "$archive" ]] || continue

    # Extract the volume label from filename:
    #   {project}_{env}_{label}_{YYYY-MM-DD_HH-MM-SS}.tar.gz
    # The date suffix pattern: _YYYY-MM-DD_HH-MM-SS  (20 chars with leading _)
    local filename
    filename="$(basename "$archive" .tar.gz)"
    local after_prefix="${filename#${PROJECT}_${ENV}_}"
    # Strip the trailing _YYYY-MM-DD_HH-MM-SS date
    local vol_label="${after_prefix%_????-??-??_??-??-??}"

    local full_vol="${PREFIX}_${vol_label}"

    if docker volume inspect "$full_vol" &>/dev/null; then
      log_info "Restoring volume: $full_vol ← $(basename "$archive")"
      docker run --rm \
        -v "${full_vol}:/data" \
        -v "${archive}:/backup.tar.gz:ro" \
        alpine:3 \
        sh -c 'cd /data && find . -not -name "." -delete 2>/dev/null || true; tar xzf /backup.tar.gz'
      log_success "Volume restored: $full_vol"
      restored=$((restored + 1))
    else
      log_warn "Volume $full_vol not found — skipping (stack may not be deployed yet)"
    fi
  done
  [[ $restored -eq 0 ]] && log_info "No volume archives found in snapshot"
}

# ── Main sequence ──────────────────────────────────────────────────────────────

log_section "Step 1/3 — Stopping stack"
docker compose -p "$PREFIX" -f "$ENV_DIR/docker-compose.yml" stop 2>/dev/null || true
log_success "Stack stopped"

log_section "Step 2/3 — Restoring data"
restore_db
restore_volumes

log_section "Step 3/3 — Starting stack"
docker compose -p "$PREFIX" -f "$ENV_DIR/docker-compose.yml" up -d
log_success "Stack started"

log_section "Restore Complete"
echo "  Workspace : $PROJECT"
echo "  Env       : $ENV"
echo "  Snapshot  : $SNAPSHOT"
echo ""
log_success "Environment restored successfully from $SNAPSHOT"
