#!/usr/bin/env bash
# Creates every monitor in monitors.json through the Datadog API.
# Needs DD_API_KEY and DD_APP_KEY (an application key with monitors_write); DD_SITE defaults to datadoghq.com.
set -euo pipefail
: "${DD_API_KEY:?set DD_API_KEY}"
: "${DD_APP_KEY:?set DD_APP_KEY}"
SITE="${DD_SITE:-datadoghq.com}"
FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/monitors.json"
COUNT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$FILE")"
for i in $(seq 0 $((COUNT - 1))); do
  BODY="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[Number(process.argv[2])];process.stdout.write(JSON.stringify(m))' "$FILE" "$i")"
  curl -fsS -X POST "https://api.${SITE}/api/v1/monitor" \
    -H "DD-API-KEY: ${DD_API_KEY}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
    -H "Content-Type: application/json" -d "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log("created monitor",m.id,m.name)})'
done
