#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy a stack for an environment (compose or swarm)
#
# Usage (via run.sh):
#   ./run.sh start   <env>              deploy/update the stack
#   ./run.sh stop    <env>              tear down the stack
#   ./run.sh ps      <env>              show running services
#   ./run.sh logs    <env> [service]    follow logs
#   ./run.sh restart <env> [service]    rolling restart
#   ./run.sh exec    <env> <svc> <cmd>  exec into a container
# =============================================================================

set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_cmd jq docker

ENV="${1:-}"
[[ -n "$ENV" ]] || { echo "Usage: scripts/deploy.sh <env> [up|stop|down|ps|logs|restart|exec]"; exit 1; }
validate_env "$ENV"

CMD="${2:-up}"
EXTRA_ARGS=("${@:3}")

PROJECT_TYPE="$(cfg_get '.project.type // "custom"')"
DEPLOYMENT="$(cfg_env_get "$ENV" '.deployment')"
STACK="$(stack_name "$ENV")"
CF="$(compose_file "$ENV")"
OUT_DIR="$(env_dir "$ENV")"

[[ -f "$CF" ]] || die "docker-compose.yml not found for '$ENV'. Run: ./run.sh init $ENV"
ensure_env_file "$ENV"

cd "$OUT_DIR"   # docker compose reads .env from CWD

compose_cmd() { docker compose -p "$STACK" -f docker-compose.yml "$@"; }
swarm_cmd()   { docker stack "$@"; }

case "$CMD" in
  up)
    log_section "Deploying '$STACK' ($DEPLOYMENT)"
    if [[ "$DEPLOYMENT" == "swarm" ]]; then
      swarm_cmd deploy --compose-file docker-compose.yml --with-registry-auth "$STACK"
    else
      compose_cmd up -d --remove-orphans
    fi
    log_success "Stack '$STACK' is up"
    ;;

  update)
    log_section "Updating images for '$STACK'..."
    # Check if the stack is currently running before pulling so we can restore
    # the same state afterward. A stopped stack should remain stopped after update.
    RUNNING_BEFORE=false
    if compose_cmd ps --status running --quiet 2>/dev/null | grep -q .; then
      RUNNING_BEFORE=true
    fi
    log_info "Pulling latest images..."
    compose_cmd pull
    if [[ "$RUNNING_BEFORE" == "true" ]]; then
      log_info "Recreating containers with new images..."
      compose_cmd up -d --remove-orphans
      log_success "Stack '$STACK' updated and restarted"
    else
      log_info "Stack was not running — images pulled, containers not started"
      log_success "Stack '$STACK' updated (stopped)"
    fi
    ;;

  stop)
    log_warn "Stopping stack '$STACK' (containers kept)..."
    if [[ "$DEPLOYMENT" == "swarm" ]]; then
      swarm_cmd rm "$STACK"
    else
      compose_cmd stop
    fi
    log_success "Stack '$STACK' stopped"
    ;;

  down)
    log_warn "Bringing down stack '$STACK' (containers removed)..."
    if [[ "$DEPLOYMENT" == "swarm" ]]; then
      swarm_cmd rm "$STACK"
    else
      compose_cmd down
    fi
    log_success "Stack '$STACK' is down"
    ;;

  ps)
    if [[ "$DEPLOYMENT" == "swarm" ]]; then
      docker stack services "$STACK"
    else
      compose_cmd ps
    fi
    # For image-stack workspaces, run update check after showing status
    if [[ "$PROJECT_TYPE" == "image" ]]; then
      echo
      bash "$SCRIPTS_DIR/image-check.sh" "$ENV"
    fi
    ;;

  logs)
    SVC="${EXTRA_ARGS[0]:-}"
    if [[ "$DEPLOYMENT" == "swarm" ]]; then
      [[ -n "$SVC" ]] || die "Specify a service: ./run.sh logs $ENV <service>"
      docker service logs -f "${STACK}_${SVC}" 2>&1
    else
      if [[ -n "$SVC" ]]; then
        compose_cmd logs -f "${STACK}_${SVC}"
      else
        compose_cmd logs -f
      fi
    fi
    ;;

  restart)
    SVC="${EXTRA_ARGS[0]:-}"
    log_info "Restarting ${SVC:-all services} in '$STACK'..."
    if [[ "$DEPLOYMENT" == "swarm" ]]; then
      if [[ -n "$SVC" ]]; then
        docker service update --force "${STACK}_${SVC}"
      else
        docker stack services "$STACK" --format '{{.Name}}' | while read -r s; do
          docker service update --force "$s"
        done
      fi
    else
      # Use 'up -d --remove-orphans' rather than 'restart' so this works whether
      # containers are currently running OR were previously removed with 'down'.
      # 'docker compose restart' only works on existing (stopped) containers and
      # silently does nothing if they have been removed.
      if [[ -n "$SVC" ]]; then
        compose_cmd up -d --remove-orphans "$SVC"
      else
        compose_cmd up -d --remove-orphans
      fi
    fi
    log_success "Restart complete"
    ;;

  exec)
    SVC="${EXTRA_ARGS[0]:-backend}"
    rest=("${EXTRA_ARGS[@]:1}")
    [[ "$DEPLOYMENT" == "swarm" ]] && die "'exec' is not supported in swarm mode"
    compose_cmd exec "${STACK}_${SVC}" "${rest[@]}"
    ;;

  *)
    die "Unknown command '$CMD'. Use: up | update | stop | down | ps | logs | restart | exec"
    ;;
esac
