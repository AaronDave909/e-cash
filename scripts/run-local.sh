#!/usr/bin/env bash
# Phase 1 without Docker: run the 5 app services as Node processes on localhost.
# dd-trace still loads (NODE_OPTIONS) and injects trace ids into logs; with no agent listening
# it simply drops its payloads. Logs go to .local/logs/<service>.log.
#   scripts/run-local.sh start | stop | status
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.local/logs"
PIDS="$ROOT/.local/pids"
SERVICES=(partner-gateway:8003 bills-pay:8001 wallet-transfer:8002 mock-jira:8004 fault-ui:8080)

dir_of() { [ "$1" = fault-ui ] && echo "$ROOT/fault-ui" || echo "$ROOT/services/$1"; }

start_one() {
  local name=$1 port=$2 dir
  dir="$(dir_of "$name")"
  [ -d "$dir/node_modules" ] || (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error)
  local env=(PORT="$port"
    PARTNER_GATEWAY_URL=http://localhost:8003
    BILLS_PAY_URL=http://localhost:8001
    WALLET_TRANSFER_URL=http://localhost:8002
    MOCK_JIRA_URL=http://localhost:8004)
  if [ "$name" != fault-ui ] && [ "$name" != mock-jira ]; then
    env+=(NODE_OPTIONS="--require dd-trace/init" DD_SERVICE="$name" DD_ENV=gcc-poc DD_VERSION=1.0.0
      DD_LOGS_INJECTION=true DD_TRACE_AGENT_URL="${DD_TRACE_AGENT_URL:-http://localhost:8126}"
      DD_TRACE_STARTUP_LOGS=false DD_INSTRUMENTATION_TELEMETRY_ENABLED=false)
  fi
  local entry_file; entry_file="$([ "$name" = fault-ui ] && echo server.js || echo index.js)"
  # `&` must background only the env/nohup/node exec chain, so $! is node's own pid.
  # (`cd x && cmd &` would background a wrapper subshell and record its pid instead.)
  (cd "$dir" || exit 1
   env "${env[@]}" nohup node "$entry_file" >"$LOGS/$name.log" 2>&1 &
   echo $! >"$PIDS/$name.pid")
}

# Waits until each process has exited and its port is free, so a restart never leaves the old
# process answering health checks while the new one dies on EADDRINUSE.
stop_all() {
  for entry in "${SERVICES[@]}"; do
    local name=${entry%%:*} port=${entry##*:} f="$PIDS/${entry%%:*}.pid"
    if [ -f "$f" ]; then
      local pid; pid="$(cat "$f")"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      rm -f "$f"
    fi
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "port $port is still held by another process; stop it first:"; lsof -nP -iTCP:"$port" -sTCP:LISTEN; exit 1
    fi
  done
}

wait_healthy() {
  for entry in "${SERVICES[@]}"; do
    local name=${entry%%:*} port=${entry##*:} path=/health
    [ "$name" = fault-ui ] && path=/
    for _ in $(seq 1 50); do
      curl -fs -o /dev/null "http://localhost:$port$path" && break
      sleep 0.2
    done
    if ! kill -0 "$(cat "$PIDS/$name.pid")" 2>/dev/null || ! curl -fs -o /dev/null "http://localhost:$port$path"; then
      echo "$name did not come up on :$port"; tail -20 "$LOGS/$name.log"; exit 1
    fi
    echo "$name up on :$port"
  done
}

case "${1:-start}" in
  start)
    mkdir -p "$LOGS" "$PIDS"
    stop_all
    for entry in "${SERVICES[@]}"; do start_one "${entry%%:*}" "${entry##*:}"; done
    wait_healthy ;;
  stop) stop_all; echo stopped ;;
  status) for entry in "${SERVICES[@]}"; do f="$PIDS/${entry%%:*}.pid"; printf '%s ' "${entry%%:*}"; [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && echo running || echo stopped; done ;;
  *) echo "usage: $0 start|stop|status"; exit 2 ;;
esac
