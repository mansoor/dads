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
[[ -n "$ENV" ]] || { echo "Usage: scripts/deploy.sh <env> [up|down|ps|logs|restart|exec]"; exit 1; }
validate_env "$ENV"

CMD="${2:-up}"
EXTRA_ARGS=("${@:3}")

DEPLOYMENT="$(cfg_env_get "$ENV" '.deployment')"
STACK="$(stack_name "$ENV")"
CF="$(compose_file "$ENV")"
OUT_DIR="$(env_dir "$ENV")"

[[ -f "$CF" ]] || die "docker-compose.yml not found for '$ENV'. Run: ./run.sh init $ENV"
ensure_env_file "$ENV"

cd "$OUT_DIR"   # docker compose reads .env from CWD

compose_cmd() { docker compose -f docker-compose.yml "$@"; }
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

  down)
    log_warn "Stopping stack '$STACK'..."
    if [[ "$DEPLOYMENT" == "swarm" ]]; then
      swarm_cmd rm "$STACK"
    else
      if confirm "Remove volumes too? (destructive)" "n"; then
        compose_cmd down -v
      else
        compose_cmd down
      fi
    fi
    log_success "Stack '$STACK' stopped"
    ;;

  ps)
    if [[ "$DEPLOYMENT" == "swarm" ]]; then
      docker stack services "$STACK"
    else
      compose_cmd ps
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
      if [[ -n "$SVC" ]]; then
        compose_cmd restart "${STACK}_${SVC}"
      else
        compose_cmd restart
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
    die "Unknown command '$CMD'. Use: up | down | ps | logs | restart | exec"
    ;;
esac
