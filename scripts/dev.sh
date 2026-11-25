#!/usr/bin/env bash
# Builds and runs all six services natively, logs in .local/logs/<service>.log.
#   scripts/dev.sh start|stop|status|restart
# dd-trace runs with no agent: DD_TRACE_AGENT_URL points at an unused local port.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
LOGS="$LOCAL/logs"
PIDS="$LOCAL/pids"
mkdir -p "$LOGS" "$PIDS"

# name:port, in start order
SERVICES=(ledger:8082 auth-kyc:8081 bank-rail:8084 transfer:8083 worker:8085 api-gateway:8080)

export DATABASE_URL="${DATABASE_URL:-postgres://ecash:ecash@127.0.0.1:54329/ecash}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:63799/0}"
export JWT_SECRET="${JWT_SECRET:-dev-jwt-secret-change-me}"
export QR_SECRET="${QR_SECRET:-dev-qr-secret-change-me}"
export RAIL_WEBHOOK_SECRET="${RAIL_WEBHOOK_SECRET:-dev-rail-webhook-secret}"
export ECASH_EXPOSE_OTP="${ECASH_EXPOSE_OTP:-true}"
export ECASH_SIMULATOR_ENABLED="${ECASH_SIMULATOR_ENABLED:-true}"
export AUTH_URL="http://127.0.0.1:8081"
export LEDGER_URL="http://127.0.0.1:8082"
export TRANSFER_URL="http://127.0.0.1:8083"
export BANK_RAIL_URL="http://127.0.0.1:8084"
export WORKER_URL="http://127.0.0.1:8085"
export RAIL_CALLBACK_URL="http://127.0.0.1:8083/webhooks/bank-rail"
export DD_ENV="${DD_ENV:-local}"
export DD_VERSION="${DD_VERSION:-1.0.0}"
export DD_LOGS_INJECTION=true
export DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED=false
export DD_TRACE_AGENT_URL="${DD_TRACE_AGENT_URL:-http://127.0.0.1:18126}"
export DD_TRACE_STARTUP_LOGS=false
export DD_INSTRUMENTATION_TELEMETRY_ENABLED=false
export DD_REMOTE_CONFIGURATION_ENABLED=false
export DD_AGENT_HOST="${DD_AGENT_HOST:-127.0.0.1}"

is_up() { curl -fsS -m 1 "http://127.0.0.1:$1/health" >/dev/null 2>&1; }

start_all() {
  "$ROOT/scripts/dev-infra.sh" start
  (cd "$ROOT" && npm run build --silent)
  for entry in "${SERVICES[@]}"; do
    name="${entry%%:*}"; port="${entry##*:}"
    if is_up "$port"; then echo "$name already up on :$port"; continue; fi
    (
      cd "$ROOT"
      PORT="$port" DD_SERVICE="ecash-$name" \
        nohup node -r dd-trace/init "services/$name/dist/index.js" >>"$LOGS/$name.log" 2>&1 &
      echo $! >"$PIDS/$name.pid"
    )
  done
  for entry in "${SERVICES[@]}"; do
    name="${entry%%:*}"; port="${entry##*:}"
    for _ in $(seq 1 120); do is_up "$port" && break; sleep 0.5; done
    if is_up "$port"; then echo "healthy  $name :$port"; else echo "FAILED   $name :$port (see $LOGS/$name.log)" >&2; exit 1; fi
  done
  echo "all services healthy; gateway at http://127.0.0.1:8080/api"
}

stop_all() {
  for entry in "${SERVICES[@]}"; do
    name="${entry%%:*}"
    if [ -f "$PIDS/$name.pid" ]; then
      pid="$(cat "$PIDS/$name.pid")"
      kill "$pid" 2>/dev/null && echo "stopped $name" || true
      rm -f "$PIDS/$name.pid"
    fi
  done
}

status_all() {
  for entry in "${SERVICES[@]}"; do
    name="${entry%%:*}"; port="${entry##*:}"
    if is_up "$port"; then echo "up    $name :$port"; else echo "down  $name :$port"; fi
  done
}

case "${1:-start}" in
  start) start_all ;;
  stop) stop_all ;;
  status) status_all ;;
  restart) stop_all; sleep 1; start_all ;;
  *) echo "usage: $0 start|stop|status|restart" >&2; exit 2 ;;
esac
