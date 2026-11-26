# gcc-aiops-poc

A small Node.js/Express environment that shows Datadog AIOps for an e-wallet operations team (GCC / L2 App Support).
A partner-gateway outage cascades through bills-pay and wallet-transfer. Datadog then handles the incident end to end:

1. It collapses the alert storm into **one Work Item**.
2. It runs **Bits Investigation once** for an error it has not seen before.
3. It caches the root cause in a **Datadog Datastore**, so a repeat outage costs **0 AI credits**.
4. It heals the gateway immediately through a **Private Action Runner**.
5. It records a ticket in a local `mock-jira`.

The demo is black-box by design. Datadog has no access to this repository, and root-cause analysis uses only
runtime telemetry.

```text
[ fault-ui :8080: control panel + live ticket table, proxies /api/* ]
        ├──► bills-pay :8001 ───────┐
        ├──► wallet-transfer :8002 ─┴──► partner-gateway :8003
        └──► mock-jira :8004 ◄──────────────┼─── [ Datadog Private Action Runner ] ──► Datadog Cloud
                                                   (outbound HTTPS only)            Event Mgmt, Workflow,
                                                                                    Datastore, Bits AI
```

| Service | Port | What it does |
| --- | --- | --- |
| `bills-pay` | 8001 | `POST /pay-bill` calls the gateway (200, or 502/504 when the gateway is degraded). `POST /pay-bill/invalid` returns a normal user error (400 `INVALID_BILLER_ACCOUNT`). `GET /health`, and `?deep=true` also checks the gateway |
| `wallet-transfer` | 8002 | `POST /transfer` calls the gateway (200, or 502/504). `GET /health` |
| `partner-gateway` | 8003 | `POST /settle` returns 200, or 503 `503_POOL_EXHAUSTED` in fault mode. `GET /health`. `POST /admin/fault`. `POST /admin/reset` is idempotent |
| `mock-jira` | 8004 | In-memory tickets: `GET`/`POST`/`DELETE /tickets` and `PATCH /tickets/:id`. A POST with the fingerprint of an Open ticket increments its `duplicate_count` |
| `fault-ui` | 8080 | One static page plus a proxy from `/api/<service>/*` to the services, so there is one port and no CORS |
| `datadog-agent` | none | APM on 8126 inside the network, container logs, and Process/Container monitoring |
| `dd-private-action-runner` | none | Profile `runner`. Runs `com.datadoghq.http.request` against the Compose hostnames |

## Telemetry and the zero-PII contract

- `bills-pay`, `wallet-transfer` and `partner-gateway` load `dd-trace` through `NODE_OPTIONS="--require dd-trace/init"`
  with `DD_ENV=gcc-poc`, `DD_VERSION=1.0.0`, `DD_LOGS_INJECTION=true` and `DD_SERVICE=<name>`. The trace context passes
  from bills-pay and wallet-transfer into partner-gateway, so the Service Map links all three.
- Every response writes one compact JSON completion log to stdout:
  `msg, method, path, status_code, error_code (on 4xx/5xx), dependency, duration_ms, request_id`. dd-trace adds
  `dd.trace_id`, `dd.span_id`, `dd.service` and `dd.env`. 5xx responses log at `error` and 4xx at `warn`, and the
  monitors filter on `@status_code`.
- `services/shared/requestIdMiddleware.js` reads `X-Request-ID` (or generates a UUIDv4), echoes it back, passes it to
  the gateway, and tags the active span with `request.id` and `dependency`.
- Payloads carry only synthetic `biller_code` and `channel` values. `user_id`, `account_number`, `mobile_number` and
  `transaction_id` never appear, and `scripts/smoke.mjs` fails if they do.

## Run it in GitHub Codespaces

The repository includes `.devcontainer/devcontainer.json` (Node 20 + Docker-in-Docker, port 8080 forwarded).
**Code > Codespaces > Create codespace** gives you a shell with Docker and Compose ready. The steps below work the same
on any machine with Docker.

### Stage 1: application containers (no Datadog key needed)

```bash
docker compose up -d --build bills-pay wallet-transfer partner-gateway mock-jira fault-ui
```

```bash
node scripts/smoke.mjs
```

Open the forwarded port **8080**. The smoke test drives every behavior through fault-ui and exits non-zero on any
mismatch: baseline 200s, 15 × 400, the 503 storm (25 × 502), an idempotent reset, and mock-jira CRUD.

### Stage 2: the Datadog Agent

```bash
cp .env.example .env
```

Set `DD_API_KEY` and `DD_SITE` (for example `datadoghq.com` or `ap1.datadoghq.com`) in `.env`, then start the agent:

```bash
docker compose up -d
```

Start **Baseline Traffic** in fault-ui. Within a few minutes, **APM > Service Map** for `env:gcc-poc` shows
bills-pay and wallet-transfer, both linked to partner-gateway.

### Private Action Runner enrollment (3 steps)

1. **Create the runner in Datadog.** Open **Actions > Private Action Runners > New Private Action Runner**. Name it
   `gcc-runner`, choose **Docker** and **Workflow Automation**, and allow only the **HTTP request** action
   (`com.datadoghq.http.request`).
2. **Enroll into `runner-config/`.** Run the enrollment command the page shows, but change its config volume to
   `-v "$PWD/runner-config:/etc/dd-action-runner/config"` and add
   `-e DD_PRIVATE_RUNNER_CONFIG_DIR=/etc/dd-action-runner/config`. Enrollment writes `runner-config/config.yaml`, which
   is git-ignored and holds the runner's private key. Compare it with `runner-config/config.yaml.example` and keep
   `actionsAllowlist` limited to `com.datadoghq.http.request`.
3. **Start the runner.**

   ```bash
   docker compose --profile runner up -d
   ```

   Wait until the runner shows **Connected** in Datadog. It only makes outbound HTTPS connections, and it reaches
   `partner-gateway:8003` and `mock-jira:8004` by Compose service name.

### Datadog configuration (in this order)

| # | What | Guide |
| --- | --- | --- |
| 1 | Log facets (`@status_code` as a measure, plus `@error_code`, `@dependency`, `@request_id`) | [workflow_setup.md §0](datadog/workflow_setup.md#0-prerequisites) |
| 2 | 3 log monitors, with auto-investigate **off** | [datadog/monitors.json](datadog/monitors.json) |
| 3 | Correlation pattern and `GCC` project | [datadog/event_correlation_spec.md](datadog/event_correlation_spec.md) |
| 4 | Datastore `gcc_known_error_cache` | [datadog/datastore_schema.md](datadog/datastore_schema.md) |
| 5 | HTTP connections through the runner, the workflow, and the "Upon work item creation" rule | [datadog/workflow_setup.md](datadog/workflow_setup.md) |

To import the monitors through the API instead of **Import from JSON**, run this. It needs an application key with
monitor write permission:

```bash
jq -c '.[]' datadog/monitors.json | while read -r m; do curl -sS -X POST "https://api.${DD_SITE}/api/v1/monitor" -H "DD-API-KEY: ${DD_API_KEY}" -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" -H "Content-Type: application/json" -d "$m"; echo; done
```

[`datadog/workflow_blueprint.json`](datadog/workflow_blueprint.json) is a reference skeleton with `REPLACE_WITH_*`
placeholders. It cannot be imported in one click. The authoritative guide is
[`workflow_setup.md`](datadog/workflow_setup.md), and the human-readable runbook is
[`playbooks/rb-partner-gateway-reset.yaml`](playbooks/rb-partner-gateway-reset.yaml).

## Demo runbook and verification criteria

Before each rehearsal, select **Clear Local Tickets** in fault-ui. To make Run #1 a cache miss again, delete the
Datastore item (see [datastore_schema.md](datadog/datastore_schema.md#reset-the-demo)).

1. **Phase 1 local smoke test (no `DD_API_KEY`).** Start the 5 app containers and run `node scripts/smoke.mjs`. It
   should end with `PASS`. In fault-ui, check baseline 200s, 400 user errors, the 503 storm, **Manual Reset Gateway**,
   and the ticket table.
2. **Multi-service telemetry.** With the agent running and baseline traffic on, the APM Service Map shows the 3
   services linked. In the Log Explorer, select a bills-pay log and open **View Trace**. The trace spans bills-pay →
   partner-gateway, and `request_id` is the same in both services' logs. No PII appears, and Datadog has no GitHub
   connection.
3. **Normal user errors are ignored.** Select **Simulate Normal User Errors (15x 400)**. The 400 logs and traces appear
   in Datadog, but no monitor alerts, no Work Item or ticket is created, and no Bits credits are used.
4. **Run #1: alert storm with an unseen error.** With the runner started, select **Trigger Cascading 503 Storm (25x)**.
   The three monitors go **RED**, and 25 or more errors collapse into **1 Work Item**. **1 Bits Investigation** runs, and
   **1 ticket** (`rca_source: bits_ai`) appears in fault-ui and becomes Resolved. The gateway badge returns to
   **GREEN**, and `gcc_known_error_cache` now holds the fingerprint with `hit_count: 1`.
5. **Run #2: known repeat error with 0 credits.** Before you start, check that Work Item #1 is **Closed** (it closes
   automatically after the monitors recover, about 1–2 min after the heal) and that 5 minutes have passed since the
   heal. Trigger the storm again. **Work Item #2** opens and the workflow hits the cache. Bits AI is skipped, so 0
   credits are used. A new ticket with `rca_source: datadog_datastore_cache` appears and becomes Resolved, the gateway
   heals immediately, and `hit_count` becomes 2.

## Local development without Docker

Use this when Docker is not available. It runs the same five services as Node processes on localhost. dd-trace still
loads and injects trace IDs into the logs, and it drops spans because no agent is listening.

```bash
npm install
```

```bash
npm run local:start
```

```bash
LOG_DIR=.local/logs npm run smoke
```

```bash
npm run check
```

```bash
npm run local:stop
```

`npm run smoke` with `LOG_DIR` set also checks the logs. Every line must be JSON, and every completion log must carry
`status_code`, `dependency`, `request_id` and `error_code` (on errors). The three traced services must also carry
`dd.trace_id`, and no log may contain a PII field name. `npm run check` checks what cannot run without Docker or a
Datadog org: the Compose topology, every Dockerfile `COPY` source inside its build context, the devcontainer, the
runner allowlist, and the structure of the Datadog artifacts.

## Repository layout

```text
docker-compose.yml        5 app containers + datadog-agent + private action runner (profile runner)
.env.example              DD_API_KEY, DD_SITE
.devcontainer/            Codespaces: Node 20 + Docker-in-Docker, port 8080
runner-config/            config.yaml.example (allowlist: com.datadoghq.http.request)
services/shared/          logger.js, requestIdMiddleware.js, upstream.js
services/<service>/       index.js, package.json, Dockerfile (built with context ./services)
fault-ui/                 server.js (static + /api proxy), public/index.html
datadog/                  monitors.json, event_correlation_spec.md, datastore_schema.md,
                          workflow_setup.md, workflow_blueprint.json
playbooks/                rb-partner-gateway-reset.yaml
scripts/                  run-local.sh, smoke.mjs, check-static.mjs
```

## Out of scope

There is no consumer wallet UI, login, real database or real payment integration. The demo has no code-fix or PR
scenarios and no GitHub linking. It uses no live Jira, has no L3 escalation, and adds no artificial delay before
remediation.
