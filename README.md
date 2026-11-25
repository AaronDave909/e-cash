# E-Cash backend

E-Cash is a microservices e-wallet modeled on Philippine wallets such as GCash. Six Node/TypeScript services sit behind one gateway. A double-entry ledger holds the money. The contract is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Where the code differs from it, [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md) says why.

## Architecture in brief

```
web (:3000) ── /api ──▶ api-gateway :8080 ──┬─▶ auth-kyc   :8081   schema auth
                                            ├─▶ transfer   :8083   schema transfer ──▶ ledger :8082 (schema ledger)
                                            │        │  ▲                          └─▶ bank-rail :8084 (schema bankrail)
                                            │        │  └── signed webhook ───────────────┘
                                            │        └── outbox ─▶ Redis Stream ecash:events ─▶ worker :8085 (schema worker)
                                            └─▶ sim/system routes (fan-out to the above)
```

- **Money lives only in the ledger.** Wallet balances are `SUM(CREDIT) - SUM(DEBIT)` over append-only postings. Triggers reject any UPDATE, DELETE, or TRUNCATE. Each journal locks its accounts in id order (`SELECT ... FOR UPDATE`), checks the balance and the month limit under that lock, then inserts. That makes double-spend impossible and keeps debits equal to credits.
- **The transfer service owns the state machine.** `PENDING → COMPLETED | FAILED` and `COMPLETED → REVERSED` are a table in `packages/common`. `transition(from, to)` is the only way a status changes, and a SQL guard (`WHERE status = $from`) backs it. What each transfer type does to money is also a table (`MONEY_EFFECTS`), not branches in handlers.
- **Everything is idempotent.** Clients send `Idempotency-Key`. Every ledger journal uses the key `transfer:<id>:<phase>`. The bank rail is idempotent on `reference`. A reconciler loop re-drives PENDING transfers after a crash or timeout.
- **Events use an outbox.** A state change and its event commit in one transaction. A relay publishes to the Redis Stream `ecash:events`. The worker consumes with a consumer group, dedupes on `event_id`, writes receipts and an audit log, and simulates the biller for bills.
- **Each service owns one Postgres schema** and runs its own idempotent migrations at boot.
- **Observability.** `node -r dd-trace/init` traces every service. Logs are JSON with `service`, `correlation_id`, and `dd.trace_id`/`dd.span_id`. The outbox stores a trace carrier so the worker continues the request's trace.

## Run natively (no Docker)

Needs Node 20, `postgresql@16` and `redis` (Homebrew works). The scripts start their own instances inside the repo (`.local/`, gitignored) on Postgres port 54329 and Redis port 63799. They never touch Homebrew's global services.

```bash
npm install
npm run build
scripts/dev-infra.sh start     # Postgres + Redis, idempotent; also: stop | status
scripts/dev.sh start           # builds, starts all six services, waits for /health
curl localhost:8080/api/system/health
scripts/dev.sh stop            # also: status | restart
scripts/dev-infra.sh stop
```

Logs go to `.local/logs/<service>.log`. Native runs point `DD_TRACE_AGENT_URL` at an unused port, so dd-trace runs with no agent.

Try it:

```bash
G=http://localhost:8080/api
curl -s -X POST $G/auth/register -H 'content-type: application/json' \
  -d '{"mobile":"09171234567","display_name":"Ana"}'          # dev_otp is in the response
curl -s -X POST $G/auth/verify-otp -H 'content-type: application/json' \
  -d '{"mobile":"09171234567","otp":"<dev_otp>","mpin":"1234"}'  # returns { token, user }
curl -s -X POST $G/cash-in -H "authorization: Bearer $TOKEN" -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' -d '{"bank":"BPI","amount_centavos":100000}'
curl -s $G/wallet -H "authorization: Bearer $TOKEN"
```

## Run with Docker Compose

```bash
cp .env.example .env     # set DD_API_KEY (and DD_SITE if not datadoghq.com)
docker compose up --build
```

| URL | What |
|-----|------|
| http://localhost:3000 | web app (nginx, proxies `/api` to the gateway) |
| http://localhost:8080/api | gateway |
| localhost:8126/tcp, 8125/udp | Datadog APM and DogStatsD, published by the agent |

One root `Dockerfile` builds every service: `docker build --build-arg SERVICE=ledger .`. The web image comes from `web/Dockerfile`, which another owner provides. Compose gives the gateway the network aliases `gateway` and `ecash-gateway` as well as its service name `api-gateway`.

## Datadog setup

1. Put `DD_API_KEY` and `DD_SITE` in `.env`.
2. `docker compose up`. The `datadog-agent` container receives traces on 8126, metrics on 8125/udp, and collects every container's logs (`DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL`).
3. Services are tagged `service:ecash-<name>`, `env:local-prod`, `version:1.0.0` through `DD_*` env and Docker labels (Unified Service Tagging). `DD_LOGS_INJECTION=true` puts the trace id in each log line, so APM traces link to their logs.
4. Create the monitors: `DD_API_KEY=... DD_APP_KEY=... datadog/import-monitors.sh`, or paste each object from `datadog/monitors.json` into the monitor editor's JSON mode. The p95 monitor needs percentile aggregations enabled for `ecash.bank_rail.settlement_ms` in Metrics Summary, because the service sends it as a distribution.

Custom metrics: `ecash.transfer.count` (tags `type`, `status`), `ecash.transfer.amount_php`, `ecash.bank_rail.settlement_ms`, `ecash.auth.mpin_failed`, `ecash.ledger.invariant_errors`, plus `ecash.ledger.journals`, `ecash.outbox.published`, `ecash.worker.events`.

## Tests

```bash
npm test     # builds, then runs vitest
```

`tests/integration/global-setup.ts` creates a throwaway database, starts all six services as child processes on free ports with 100 to 300 ms rail settlement, waits for `/health`, and drops everything afterwards. If Postgres and Redis are not running, it starts them with `scripts/dev-infra.sh` and stops them when done. Tests call the gateway's public API. The ledger contract test and the webhook tests also call internal ports. Service logs for the trace test land in `.local/test-logs/<database>/`.

| File | Proves |
|------|--------|
| `idempotency.test.ts` | replay returns one transfer and `Idempotent-Replay: true`; a changed body gives 422; a missing key gives 400 |
| `concurrency.test.ts` | 20 concurrent sends from a 1,000-peso wallet: exactly 10 succeed; two 60% sends: one succeeds; a 30-send burst keeps total money and balance |
| `auth-kyc.test.ts` | 3 wrong MPINs lock the account until unlock; Basic is capped at 100,000 a month, Fully Verified is not |
| `rails.test.ts` | cash-in settles by signed webhook; forged, unsigned, and stale signatures get 401; failed cash-out returns the hold |
| `bills.test.ts` | worker-driven bills, SMS receipts, `...0000` fails and refunds |
| `qr-reversal.test.ts` | a dynamic QR pays once; reversal restores balances |
| `trace.test.ts` | one trace id across gateway, transfer, ledger, and (via the event) the worker |
| `ledger.test.ts`, `system.test.ts`, `domain.test.ts` | ledger contract, system routes, domain tables |

## Public API

All errors are `{ "error": CODE, "message": "..." }`. Money fields are integer centavos. Money-moving POSTs need an `Idempotency-Key` header. Everything except `/api/auth/*`, `/api/sim/*`, and `/api/system/*` needs `Authorization: Bearer <jwt>`.

| Route | Success | Notes |
|-------|---------|-------|
| `POST /api/auth/register {mobile, display_name}` | 201 `{mobile, expires_in_s, dev_otp?}` | `dev_otp` only when `ECASH_EXPOSE_OTP=true` |
| `POST /api/auth/verify-otp {mobile, otp, mpin}` | 200 `{token, user}` | MPIN is 4 to 6 digits |
| `POST /api/auth/login {mobile, mpin}` | 200 `{token, user}` | 401 `INVALID_CREDENTIALS` (with `attempts_remaining`), 423 `ACCOUNT_LOCKED` |
| `GET /api/wallet` | 200 `{balance_centavos, tier, month_out_centavos, month_limit_centavos, month_cash_in_centavos}` | |
| `POST /api/transfers/p2p {to_mobile, amount_centavos, note?}` | 201 transfer | 404 `RECIPIENT_NOT_FOUND`, 422 `SELF_TRANSFER` |
| `POST /api/qr {amount_centavos?}` | 201 `{qr_id, payload, amount_centavos, single_use, expires_at}` | with an amount: single use, 15 minutes |
| `POST /api/qr/pay {payload, amount_centavos?}` | 201 transfer | 400 `QR_INVALID`, 409 `QR_ALREADY_PAID`, 422 `QR_EXPIRED`/`AMOUNT_MISMATCH` |
| `POST /api/cash-in`, `/api/cash-out {bank, amount_centavos}` | 201 transfer (`PENDING`) | settles later through the rail |
| `POST /api/bills {biller, account_number, amount_centavos}` | 201 transfer (`PENDING`) | worker settles it |
| `GET /api/transfers?limit=`, `GET /api/transfers/:id` | 200 | the detail view has `status_history`; list items have `direction` `IN`/`OUT` |

A new transfer returns 201 with the transfer object. A replay of the same key and body returns 200 with `Idempotent-Replay: true`. The same key with a different body returns 422 `IDEMPOTENCY_KEY_REUSED`. A send the ledger rejects (`INSUFFICIENT_FUNDS`, `LIMIT_EXCEEDED`) returns 422 `{error, message, transfer}`, and the transfer is stored as `FAILED`. The gateway rate limit returns 429 with `Retry-After`.

Simulator routes (no JWT; the web app's Users tab and chaos controls): `GET /api/sim/users`, `POST /api/sim/users/:id/unlock` (3 per user per 10 minutes), `POST /api/sim/users/:id/kyc {tier}`, `GET|PUT /api/sim/chaos {latency_ms, failure_rate}`, `GET /api/sim/activity`, `GET /api/sim/receipts?user_id=`. They exist only when `ECASH_SIMULATOR_ENABLED=true`. They let anyone unlock accounts and change KYC tiers, so enable them in dev and staging only, never in production. `scripts/dev.sh` and the tests turn them on; Compose reads the flag from `.env`.

System routes (no JWT): `GET /api/system/health`, `GET /api/system/journals`, `GET /api/system/reconcile`. Ops reversal is internal only: `POST /internal/transfers/:id/reverse` on the transfer service.

## Known limits

- A bill or cash-out that fails still counts toward the month's outgoing total, because the ledger limit sums DEBIT postings and the refund is a CREDIT.
- A reversal needs the recipient to still hold the money (422 `NOT_REVERSIBLE` otherwise).
- Docker and Compose were not run while writing this. `docker compose config` and a first `docker compose up --build` are the checks.
