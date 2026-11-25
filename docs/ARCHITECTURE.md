# E-Cash architecture

E-Cash is a microservices e-wallet modeled on Philippine mobile wallets. This file is the contract every service implements. Change it before you change a boundary.

## Stack

- Node.js 20, TypeScript (strict), CommonJS output, npm workspaces.
- Fastify for HTTP, zod for parsing at every boundary, `pg` for Postgres, `ioredis` for Redis.
- `dd-trace` loaded with `node -r dd-trace/init` (configured only by `DD_*` env), `pino` JSON logs with `DD_LOGS_INJECTION=true`, `hot-shots` for DogStatsD.
- One Postgres instance. Each service owns one schema (`auth`, `ledger`, `transfer`, `bankrail`, `worker`) and never reads another service's schema. Each service runs its own idempotent migrations at boot.
- Redis: gateway rate limits, Redis Stream `ecash:events` for domain events, chaos settings.
- Vite + React + TypeScript web app (`web/`), served by nginx in Compose, proxying `/api` to the gateway.

## Layout

```
packages/common/      tracer helpers, logger, metrics, config, db, outbox, http client, money, phone, errors
services/api-gateway/ :8080  public entry point
services/auth-kyc/    :8081
services/ledger/      :8082
services/transfer/    :8083
services/bank-rail/   :8084
services/worker/      :8085  (health + internal read API only)
web/                  :5173 dev, :3000 in Compose
tests/integration/    vitest suites that boot every service against a throwaway database
datadog/              monitors.json for import
```

## Domain types (packages/common)

- `Centavos`: branded integer (`bigint` in SQL, `number` in TS, safe below 2^53). All money is centavos. The API accepts and returns `amount_centavos`; the UI formats `₱1,234.50`.
- `MobileNumber`: branded string matching `^\+639\d{9}$`. `parseMobile` also accepts `09XXXXXXXXX` and normalizes.
- `KycTier`: `"BASIC" | "FULLY_VERIFIED"`. Monthly limit table: `BASIC → 100_000_00`, `FULLY_VERIFIED → 500_000_00` centavos. The limit caps the month's outgoing debits from the wallet (P2P, QR, bills, cash-out) and the month's incoming credits from cash-in.
- `TransferType`: `"p2p" | "qr" | "bills" | "cash_in" | "cash_out"`.
- `TransferStatus`: `"PENDING" | "COMPLETED" | "FAILED" | "REVERSED"`.

### Transfer state machine

The transfer service owns the only state machine. One table of legal moves, enforced in one function (`transition(from, to)`) and by a SQL guard (`UPDATE ... WHERE status = $from`):

| from      | to        | when |
|-----------|-----------|------|
| PENDING   | COMPLETED | ledger journal posted (p2p, qr), bank webhook success (cash_in, cash_out), biller success (bills) |
| PENDING   | FAILED    | ledger rejected, bank webhook failure, biller failure, or pending deadline passed |
| COMPLETED | REVERSED  | ops reversal; posts a compensating journal |

Terminal states never move except COMPLETED → REVERSED. Every move appends a row to `transfer.status_history` and an outbox event in the same database transaction.

Money effect per type:

| type     | on create (PENDING)                          | on COMPLETED                               | on FAILED |
|----------|-----------------------------------------------|--------------------------------------------|-----------|
| p2p, qr  | nothing                                       | journal: wallet(sender) DEBIT, wallet(recipient) CREDIT | nothing |
| cash_in  | nothing, rail request sent                    | journal: bank clearing DEBIT, wallet CREDIT | nothing |
| cash_out | journal: wallet DEBIT, cash-out clearing CREDIT (funds held) | journal: cash-out clearing DEBIT, bank clearing CREDIT | journal: hold released back to wallet |
| bills    | journal: wallet DEBIT, biller clearing CREDIT (funds held)   | nothing more (biller settles off-ledger)   | journal: hold released back to wallet |

For p2p and qr, the transfer service creates the PENDING row, calls the ledger with `idempotency_key = "transfer:<id>:post"`, then records COMPLETED or FAILED. A crash between the ledger call and the status update leaves PENDING. The reconciler loop (every 5 s) retries the ledger call with the same key for PENDING p2p/qr rows older than 5 s, which converges because the ledger is idempotent. Every journal the transfer service posts uses the key `transfer:<id>:<phase>` with phase in `post | hold | settle | release | reverse`.

## Ledger (`ecash-ledger`)

Schema `ledger`:

```sql
accounts(id bigserial pk, code text unique not null,       -- 'wallet:<user_id>', 'system:bank_clearing:<bank>', 'system:cashout_clearing', 'system:biller:<biller>'
         kind text not null check (kind in ('USER_WALLET','SYSTEM')),
         created_at timestamptz default now())
journal_entries(id uuid pk, idempotency_key text unique not null, request_hash text not null,
                kind text not null, metadata jsonb not null default '{}', created_at timestamptz default now())
ledger_postings(id bigserial pk, journal_id uuid references journal_entries, account_id bigint references accounts,
                direction text check (direction in ('DEBIT','CREDIT')), amount_centavos bigint check (amount_centavos > 0),
                created_at timestamptz default now())
-- index ledger_postings(account_id, created_at)
```

No table has a balance column, and no row is ever updated or deleted (enforce with a trigger that raises on UPDATE/DELETE of journal_entries and ledger_postings). A wallet's balance is `SUM(CREDIT) - SUM(DEBIT)` over its postings. SYSTEM accounts may go negative. USER_WALLET accounts never go negative.

`POST /journals` (internal):

```ts
{ idempotency_key: string, kind: string, metadata?: object,
  postings: { account_code: string, direction: "DEBIT"|"CREDIT", amount_centavos: number }[],
  limits?: { account_code: string, direction: "DEBIT"|"CREDIT", max_month_centavos: number }[] }
→ 201 { journal_id, postings: [...], balances: { [account_code]: number } }   // new journal
→ 200 same body                                                               // replay with the same key and same request hash
→ 409 { error: "IDEMPOTENCY_CONFLICT" }   same key, different request
→ 422 { error: "INSUFFICIENT_FUNDS" | "LIMIT_EXCEEDED" | "UNBALANCED" }
```

Algorithm in one transaction: reject unless debits equal credits; return the stored journal if the key exists; ensure accounts exist (`INSERT ... ON CONFLICT DO NOTHING`, kind from the code prefix); `SELECT id FROM accounts WHERE code = ANY($1) ORDER BY id FOR UPDATE` (fixed lock order prevents deadlocks); for each debited USER_WALLET compute the balance and reject on overdraft; for each `limits` entry compute the calendar month (Asia/Manila) sum for that direction and reject when the new total exceeds the cap; insert the journal and postings. A unique violation on the key under a race means another request won, so read and return its journal.

Other endpoints: `GET /accounts/:code/balance`, `GET /accounts/:code/postings?limit=`, `GET /journals/recent?limit=` (journal with postings), `GET /reconcile` → `{ status: "BALANCED"|"IMBALANCE_DETECTED", total_debits, total_credits, unbalanced_journals: [], negative_wallets: [] }`. Reconcile increments `ecash.ledger.invariant_errors` on imbalance. A background loop runs reconcile every 30 s.

## Identity & KYC (`ecash-auth-kyc`)

Schema `auth`: `users(id uuid pk, mobile text unique, display_name, kyc_tier, mpin_hash, mpin_salt, failed_mpin_attempts int, locked_at timestamptz null, persona text null, created_at)`, `otps(mobile, code_hash, expires_at, consumed_at)`.

- `POST /auth/register {mobile, display_name}` → creates the user (no MPIN yet), issues a 6-digit OTP valid 5 min. The simulated SMS is logged, and the response includes `dev_otp` when `ECASH_EXPOSE_OTP=true`.
- `POST /auth/verify-otp {mobile, otp, mpin}` → sets the MPIN (scrypt, 16-byte random salt), returns `{ token, user }`.
- `POST /auth/login {mobile, mpin}` → JWT (HS256, `JWT_SECRET`, 1 h, claims `sub`, `mobile`, `tier`). A wrong MPIN increments the counter in one statement (`UPDATE ... SET failed = failed + 1, locked_at = CASE WHEN failed + 1 >= 3 THEN now() END ... RETURNING`) and emits `ecash.auth.mpin_failed`. A locked account returns 423 `ACCOUNT_LOCKED` even with the right MPIN. Success resets the counter.
- `POST /auth/users/:id/unlock` and `POST /auth/users/:id/kyc {tier}` are simulator/admin endpoints.
- Internal: `GET /users/by-mobile/:mobile`, `GET /users/:id`, `GET /users` (list for the Users tab).

## Transfer (`ecash-transfer`)

Schema `transfer`:

```sql
transfers(id uuid pk, type text, status text, user_id uuid not null, idempotency_key text not null,
          request_hash text not null, amount_centavos bigint check (> 0),
          source_account text, dest_account text, counterparty jsonb, failure_reason text,
          rail_reference text, created_at, updated_at, unique (user_id, idempotency_key))
status_history(id bigserial, transfer_id uuid, from_status text null, to_status text, reason text, at timestamptz)
qr_codes(id uuid pk, owner_user_id uuid, amount_centavos bigint null, payload text, single_use bool, paid_transfer_id uuid null, expires_at)
outbox(id bigserial pk, event_id uuid unique, type text, payload jsonb, trace_carrier jsonb, created_at, published_at null)
```

Public (via gateway, user from JWT, `Idempotency-Key` required on every POST that moves money):

- `POST /transfers/p2p {to_mobile, amount_centavos, note?}`: looks up the recipient in auth (404 `RECIPIENT_NOT_FOUND`), rejects a self-send, gets the sender tier, posts the journal with a DEBIT limit for the sender.
- `POST /qr {amount_centavos?}` → `{ qr_id, payload }`. The payload is `ECASH1.<base64url(json {qr, to, amt, exp})>.<hmac-sha256 base64url>` signed with `QR_SECRET`. A dynamic QR (with an amount) is single use and expires in 15 min. A static QR has no amount and no single-use rule.
- `POST /qr/pay {payload, amount_centavos?}`: verifies the signature and expiry, claims a single-use QR atomically, then runs the p2p path with type `qr`.
- `POST /cash-in {bank, amount_centavos}` and `POST /cash-out {bank, amount_centavos}`: bank in `INSTAPAY | PESONET | BPI | UNIONBANK | OTC_7ELEVEN`.
- `POST /bills {biller, account_number, amount_centavos}`: biller in `MERALCO | MAYNILAD | GLOBE`.
- `GET /transfers?limit=` (mine), `GET /transfers/:id` (with status_history), `GET /wallet` → `{ balance_centavos, tier, month_out_centavos, month_limit_centavos }`.

Idempotency: `(user_id, idempotency_key)` is unique, and `request_hash` is a sha256 of the canonical body plus the route. A replay with the same hash returns the stored transfer with header `Idempotent-Replay: true`. A different hash returns 422 `IDEMPOTENCY_KEY_REUSED`.

Internal:

- `POST /webhooks/bank-rail`: verifies `X-ECash-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<raw body>")>` with `RAIL_WEBHOOK_SECRET`, rejects a timestamp older than 300 s or a bad signature with 401 before any parsing, and applies the outcome idempotently (a terminal transfer returns 200 with no change). It emits `ecash.bank_rail.settlement_ms` (now minus transfer created_at).
- `POST /internal/bills/:id/result {success, reason?}`: called by the worker.
- `POST /internal/transfers/:id/reverse`: ops reversal, COMPLETED → REVERSED.
- `GET /internal/transfers/recent`: the Users tab's live activity feed.

The outbox relay publishes unpublished rows in id order with `XADD ecash:events * event <json>`, then sets `published_at`. Consumers dedupe on `event_id`, so a crash between XADD and the update is safe.

Metrics: `ecash.transfer.count` (tags `type`, `status` in `success|failed|pending`) on create and on each terminal move, `ecash.transfer.amount_php` (distribution, pesos) on success.

## Bank rail simulator (`ecash-bank-rail`)

Schema `bankrail`: `rail_transfers(reference text pk, direction, bank, amount_centavos, callback_url, status, created_at, settled_at)`, `webhook_deliveries(reference, attempt, status_code, at)`.

- `POST /rail/transfers {reference, direction, bank, amount_centavos, callback_url}`: idempotent on `reference`, returns 202 `{ reference, status: "PENDING" }` after the injected latency.
- `GET /rail/transfers/:reference`.
- `GET|PUT /rail/chaos {latency_ms, failure_rate}` stored in Redis key `ecash:chaos:bank_rail`.
- A settlement loop picks PENDING rows older than a random delay (`RAIL_SETTLE_MIN_MS`..`RAIL_SETTLE_MAX_MS`, default 1500..4000), settles COMPLETED or FAILED (failure probability from chaos), and delivers the signed webhook. It retries delivery with backoff until it gets a 2xx.

The transfer service calls the rail with a 2 s timeout. On a timeout the transfer stays PENDING, and the reconciler re-sends the same `reference` (the rail is idempotent). A cash_in or cash_out still PENDING after `PENDING_DEADLINE_MS` (default 120 s) with no rail record moves to FAILED (cash_out releases the hold).

## Worker (`ecash-worker`)

Schema `worker`: `processed_events(event_id pk, processed_at)`, `receipts(id, transfer_id, user_id, channel 'SMS'|'IN_APP', body, created_at)`, `audit_log(id, event_id, type, payload jsonb, created_at)` with an append-only trigger.

Consumer group `worker` on `ecash:events` (`XREADGROUP`, `XACK` after processing, `XAUTOCLAIM` for stale pending entries). For each event it extracts the trace carrier and runs under a child span, then in one transaction inserts `processed_events` (skips duplicates), writes the audit row, and writes receipts for terminal transfer events. On `transfer.created` with type `bills` it simulates the biller (latency 300–1500 ms, fails when the account number ends in `0000`) and calls `POST /internal/bills/:id/result`.

Internal read API: `GET /receipts?user_id=`, `GET /audit?limit=`.

## Gateway (`ecash-api-gateway`)

- Public prefix `/api`. The gateway percent-decodes the path once, answers 404 to any path with a `.` or `..` segment, an empty segment, an encoded slash or backslash (`%2f`, `%5c`), or a literal backslash, and both matches and forwards that one canonical path. A path that differs from what an upstream URL parser would resolve never reaches a route.
- Routes `/api/auth/*` to auth (no JWT). Other routes need `Authorization: Bearer <jwt>`, which the gateway verifies, and the gateway forwards `X-User-Id`, `X-User-Mobile`, `X-User-Tier`. Downstream services trust these headers only on their internal port.
- `X-Correlation-Id`: kept from the client or generated, forwarded, echoed, and logged.
- Rate limit per user (per IP for auth) with a Redis fixed window, default 120 requests per 10 s, 429 with `Retry-After`.
- POSTs to `/api/transfers/*`, `/api/qr/pay`, `/api/cash-in`, `/api/cash-out`, `/api/bills` without `Idempotency-Key` get 400 `IDEMPOTENCY_KEY_REQUIRED`.
- Simulator routes (no JWT, for the Users tab): `GET /api/sim/users` (users with balance and lock status), `POST /api/sim/users/:id/unlock`, `POST /api/sim/users/:id/kyc`, `GET|PUT /api/sim/chaos`, `GET /api/sim/activity` (recent transfers with history), `GET /api/sim/receipts?user_id=`. They exist only when `ECASH_SIMULATOR_ENABLED=true` and answer 404 otherwise. Enable them in dev and staging only, never in production. Unlock is limited to 3 calls per target user per 10 minutes. Ops reversal has no gateway route.
- System routes: `GET /api/system/health` (fans out to every service's `/health` with a 1 s timeout, plus Postgres and Redis), `GET /api/system/journals`, `GET /api/system/reconcile`.

## Observability

Every service process starts with `node -r dd-trace/init`. Compose sets `DD_SERVICE=ecash-<name>`, `DD_ENV=local-prod`, `DD_VERSION=1.0.0`, `DD_AGENT_HOST=datadog-agent`, `DD_LOGS_INJECTION=true`, plus Docker labels `com.datadoghq.tags.service/env/version`. HTTP propagation comes from dd-trace's http/fastify plugins. Queue propagation: the outbox writer calls `tracer.inject(activeSpan, 'text_map', carrier)` and stores the carrier, and the worker calls `tracer.extract('text_map', carrier)` and starts `worker.process_event` as a child.

Logs go as JSON to stdout with fields `service`, `correlation_id`, and `dd.trace_id`/`dd.span_id` (injected).

## Errors

Every error response is `{ error: CODE, message }`. Services map domain errors to status codes at the HTTP boundary only.
