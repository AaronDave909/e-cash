# Datadog Datastore: `gcc_known_error_cache`

The known-error cache lives inside Datadog, so the workflow can decide "seen this before?" without any code or database
of our own. Each item is one error fingerprint, the root cause that Bits Investigation found for it the first time, and
the time of the last automated reset.

## Create it

1. Open **Actions > Datastore** and select **+ New Datastore**.
2. Set Name `gcc_known_error_cache` and Primary key `fingerprint`.
3. Select **Create**. Copy the datastore ID: the workflow blueprint calls it `REPLACE_WITH_DATASTORE_ID`.
4. On the datastore's **Permissions** tab, give the identity that runs the workflow (its service account) **Editor**
   access.

You do not need to seed any items. The workflow's first cache-miss run writes the first one.

## Item schema

| Attribute | Type | Example | Written by |
| --- | --- | --- | --- |
| `fingerprint` (primary key) | string | `partner-gateway:503_POOL_EXHAUSTED` | Branch A |
| `playbook_id` | string | `RB-GCC-L2-001` | Branch A |
| `cached_rca` | string | The summary from the first Bits Investigation | Branch A |
| `remediation_url` | string | `http://partner-gateway:8003/admin/reset` | Branch A |
| `last_reset_at` | string, ISO-8601 UTC | `2026-11-27T03:14:15.000Z` | Branch A and Branch B |
| `hit_count` | number | `1` after the first heal, then +1 for each cached heal | Branch A sets `1`; Branch B increments it |

The fingerprint is `<dependency>:<error_code>`, built from the Work Item's monitor tags
(`dependency:partner-gateway`, `error_code:503_POOL_EXHAUSTED`). It never contains user, account, mobile number or
transaction data.

## How the workflow reads it

| State of the item | Decision |
| --- | --- |
| No item for the fingerprint | **Cache miss.** Run Bits Investigation once, then heal and write the item. |
| Item exists, `last_reset_at` less than 5 minutes ago | **Cooldown.** Stop. Do not reset, ticket or investigate. This is the loop guard. |
| Item exists, `last_reset_at` 5 minutes ago or more | **Cache hit.** Skip Bits, heal using `cached_rca`, and increment `hit_count`. |

`hit_count - 1` is the number of outages healed with 0 Bits credits.

## Example item after Run #2

```json
{
  "fingerprint": "partner-gateway:503_POOL_EXHAUSTED",
  "playbook_id": "RB-GCC-L2-001",
  "cached_rca": "partner-gateway returned 503 503_POOL_EXHAUSTED on /settle; bills-pay and wallet-transfer propagated 502s. Resetting the gateway connection pool restores service.",
  "remediation_url": "http://partner-gateway:8003/admin/reset",
  "last_reset_at": "2026-11-27T03:24:40.000Z",
  "hit_count": 2
}
```

## Reset the demo

To make the next storm a cache miss again, so it shows Bits Investigation one more time, delete the
`partner-gateway:503_POOL_EXHAUSTED` item in **Actions > Datastore > gcc_known_error_cache**.
