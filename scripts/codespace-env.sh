#!/usr/bin/env bash
# Writes .env for `docker compose up` from Codespaces secrets. Idempotent: keeps existing app secrets,
# refreshes the Datadog key and the git metadata on every start.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[ -f .env ] || cp .env.example .env

set_var() { # set_var KEY VALUE: replace or append KEY=VALUE in .env
  local k="$1" v="$2"
  if grep -q "^$k=" .env; then sed -i.bak "s|^$k=.*|$k=$v|" .env && rm -f .env.bak; else echo "$k=$v" >> .env; fi
}
fill_secret() { grep -q "^$1=.\+" .env || set_var "$1" "$(openssl rand -hex 32)"; }

fill_secret JWT_SECRET
fill_secret QR_SECRET
fill_secret RAIL_WEBHOOK_SECRET
[ -n "${DD_API_KEY:-}" ] && set_var DD_API_KEY "$DD_API_KEY"
[ -n "${DD_SITE:-}" ] && set_var DD_SITE "$DD_SITE"
set_var DD_GIT_REPOSITORY_URL "$(git config --get remote.origin.url 2>/dev/null | sed 's|\.git$||')"
set_var DD_GIT_COMMIT_SHA "$(git rev-parse HEAD)"
set_var DD_HOSTNAME "${CODESPACE_NAME:-ecash-local}"

grep -q "^DD_API_KEY=.\+" .env || echo "warning: DD_API_KEY is empty; add it as a Codespaces secret, then rebuild or rerun this script" >&2
echo ".env ready. Start with: docker compose up --build -d"
