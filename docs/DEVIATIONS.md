# Deviations from ARCHITECTURE.md

Each entry is additive or fills a gap. None changes a contract the document states.

| # | What | Why |
|---|------|-----|
| 1 | Ledger `limits[]` entries accept an optional `kinds: string[]`. Only postings from journals of those kinds count toward the month total. Journal kinds are `<type>.<phase>` (for example `p2p.post`, `cash_out.hold`). | The contract sums "that direction" for the account. Unfiltered, a Basic user's cash-in cap would also count money received by P2P, and a reversal's debit would count as spending. The product rule is "outgoing sends and cash-in credits". |
| 2 | Extra internal ledger endpoints: `GET /accounts/:code/month-total?direction=&kinds=` and `GET /balances?prefix=`. | `GET /api/wallet` needs `month_out_centavos`, and `GET /api/sim/users` needs every wallet balance without one call per user. |
| 3 | `journal_entries.balances jsonb` stores the post-journal balances. | The contract says a replay returns "same body". Recomputing balances on replay would change them. |
| 4 | `POST /api/sim/transfers/:id/reverse` on the gateway, forwarding to `POST /internal/transfers/:id/reverse`. | Tests and the Users tab can only reach the public gateway, and the contract has no gateway route for reversal. |
| 5 | Response shapes and status codes for the transfer API are fixed: 201 new, 200 replay with `Idempotent-Replay: true`, 422 with `{error, message, transfer}` for a ledger rejection. `GET /api/wallet` also returns `month_cash_in_centavos`. | The contract names the codes but not the shapes. See the README table. |
| 6 | The QR signature is HMAC-SHA256 over the string `ECASH1.<base64url(json)>`, base64url encoded. | The contract does not say which bytes are signed. |
| 7 | Transfer tier comes from a live call to auth, not from the JWT `tier` claim or `X-User-Tier`. | A KYC upgrade must apply to the next request. A JWT lives for an hour. |
| 8 | A single-use QR is released again when its payment ends `FAILED`. | A rejected payment moved no money, so the payer should be able to retry the same QR. |
| 9 | `bank_rail` tables have extra delivery columns (`settle_after`, `delivered_at`, `next_delivery_at`, `delivery_attempts`). `PUT /rail/chaos` accepts a partial body and merges it. | The webhook retry state must survive a restart. |
| 10 | The reconciler tick and minimum age are env-tunable (`RECONCILER_INTERVAL_MS`, `RECONCILER_MIN_AGE_MS`, defaults 5000 and 5000). | Tests shorten them. Defaults match the contract. |
| 11 | Env `RAIL_CALLBACK_URL` sets the webhook URL the transfer service gives the rail. | In Compose the rail reaches transfer by service name, not localhost. |
| 12 | Simulator `GET /api/sim/activity` adds `user: {mobile, display_name}` to each transfer. | The Users tab needs a name for the sender. |
| 13 | The gateway answers 404 for `/api/auth/users/*` (unlock and KYC). The simulator routes `/api/sim/users/:id/unlock` and `/kyc` are the public way. | The contract routes `/api/auth/*` without a JWT, which would let anyone unlock accounts or raise limits through the auth prefix. |

## Behavior the contract left open

- Cash-in credit that the ledger rejects at settlement (`LIMIT_EXCEEDED`) moves the transfer to `FAILED` with that reason.
- The reconciler never fails a p2p or qr transfer by deadline. It only retries the idempotent ledger call, because failing after an unseen success would lose track of moved money. Rail transfers fail by deadline only when the rail has no record. Bills fail by deadline when the worker never reports.
- `register` for a number that finished sign-up returns 409 `MOBILE_ALREADY_REGISTERED`. A half-finished sign-up can request a new OTP.
