#!/usr/bin/env bash
# Starts or stops this worktree's own Postgres (port 54329) and Redis (port 63799).
# Idempotent. Never touches Homebrew's global services. Data lives in .local/ (gitignored).
#   scripts/dev-infra.sh start|stop|status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="$ROOT/.local"
PG_PORT="${ECASH_PG_PORT:-54329}"
REDIS_PORT="${ECASH_REDIS_PORT:-63799}"
PG_DB="${ECASH_PG_DB:-ecash}"
PG_USER="${ECASH_PG_USER:-ecash}"

find_bin_dir() {
  local name="$1"; shift
  local d
  for d in "$@"; do
    if [ -x "$d/$name" ]; then echo "$d"; return 0; fi
  done
  if command -v "$name" >/dev/null 2>&1; then dirname "$(command -v "$name")"; return 0; fi
  echo "cannot find $name; install postgresql@16 and redis (brew install postgresql@16 redis)" >&2
  return 1
}

PG_BIN="$(find_bin_dir pg_ctl /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@16/bin /usr/lib/postgresql/16/bin)"
REDIS_BIN="$(find_bin_dir redis-server /opt/homebrew/opt/redis/bin /usr/local/opt/redis/bin /usr/bin)"

# macOS postmaster aborts ("became multithreaded") without a valid locale.
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
PGDATA="$LOCAL/pgdata"
PGSOCK="$LOCAL/pgsock"
REDIS_DIR="$LOCAL/redis"
mkdir -p "$LOCAL" "$PGSOCK" "$REDIS_DIR" "$LOCAL/logs"

pg_running() { "$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PG_PORT"; }
redis_running() { "$REDIS_BIN/redis-cli" -h 127.0.0.1 -p "$REDIS_PORT" ping >/dev/null 2>&1; }

start_pg() {
  if pg_running; then echo "postgres already running on :$PG_PORT"; return; fi
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "initializing postgres data dir"
    "$PG_BIN/initdb" -D "$PGDATA" -U "$PG_USER" --auth=trust --encoding=UTF8 --locale=C >/dev/null
  fi
  # fsync off: this is a throwaway dev/test database and the tests hammer it.
  "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$LOCAL/logs/postgres.log" -w -t 60 \
    -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$PGSOCK -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200" start >/dev/null
  if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1; then
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" "$PG_DB"
  fi
  echo "postgres up on :$PG_PORT (db $PG_DB, user $PG_USER)"
}

start_redis() {
  if redis_running; then echo "redis already running on :$REDIS_PORT"; return; fi
  "$REDIS_BIN/redis-server" --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$REDIS_DIR" \
    --save "" --appendonly no --daemonize yes --pidfile "$REDIS_DIR/redis.pid" \
    --logfile "$LOCAL/logs/redis.log" >/dev/null
  for _ in $(seq 1 50); do redis_running && break; sleep 0.1; done
  redis_running || { echo "redis failed to start; see $LOCAL/logs/redis.log" >&2; exit 1; }
  echo "redis up on :$REDIS_PORT"
}

stop_pg() {
  if [ -f "$PGDATA/postmaster.pid" ]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null && echo "postgres stopped"
  else
    echo "postgres not running"
  fi
}

stop_redis() {
  if redis_running; then
    "$REDIS_BIN/redis-cli" -h 127.0.0.1 -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
    echo "redis stopped"
  else
    echo "redis not running"
  fi
}

case "${1:-start}" in
  start) start_pg; start_redis ;;
  stop) stop_redis; stop_pg ;;
  status)
    pg_running && echo "postgres: up (:$PG_PORT)" || echo "postgres: down"
    redis_running && echo "redis: up (:$REDIS_PORT)" || echo "redis: down"
    ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
