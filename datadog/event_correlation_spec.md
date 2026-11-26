# Event Management correlation: `gcc-payments-cascading-outage`

One partner-gateway outage fires all three log monitors. bills-pay and wallet-transfer return 502 and partner-gateway
returns 503, which is 25 or more errors across 3 services. This pattern groups those alerts into **one Work Item**
before any workflow or AI step runs. The Datadog Workflow triggers on Work Item creation, so this deduplication is
what keeps Bits Investigation to one run per outage.

> **Naming.** This guide uses the names in the POC spec: *Work Management*, *Work Item*, *project*. If your org still
> labels the product **Case Management**, read *Work Item* as *Case* and *Work Management project* as *Case Management
> project*. The settings are the same.

## Prerequisites

- The three monitors in [`monitors.json`](monitors.json) exist and carry the tags `env:gcc-poc`, `domain:payments`,
  `dependency:partner-gateway`.
- A Work Management project with key **`GCC`** exists. To create it, open **Work Management (Case Management) > Projects >
  New Project** and set Name `GCC Command Center` and Key `GCC`.

## Configuration

Open **Events > Correlation**. Select **+ Add a Pattern** and set these values:

| Setting | Value |
| --- | --- |
| Pattern name | `gcc-payments-cascading-outage` |
| Source filter | Source **Monitor Alert**, query `env:gcc-poc domain:payments` |
| Grouping facets | `{{tag.env}}`, `{{tag.dependency}}` |
| Correlation window | `10 minutes` |
| Deduplication window | `10 minutes` (short so that POC runs can follow each other quickly) |
| Extend dedupe window until all alerts resolve | **On** |
| Create a new work item after auto-closure | **On** |
| Destination | Work Management project **`GCC`** |
| Auto-close on alert resolution | **On** |

Select **Save**, then switch the pattern to **Active**.

## Why each setting matters

- **Grouping on `env` + `dependency`.** All three monitors share `env:gcc-poc` and `dependency:partner-gateway`, so they
  fall into one group. A future outage of a different dependency gets its own Work Item.
- **Extend dedupe until all alerts resolve.** Baseline traffic keeps failing until the reset. With this setting on, a
  late alert from the same outage joins the open Work Item and does not start a second one.
- **Auto-close + new work item after auto-closure.** After the reset, all three monitors recover and the Work Item
  closes. The next outage then opens **Work Item #2**, and the workflow runs again. That second run is the cache-hit
  path in [`workflow_setup.md`](workflow_setup.md).
- **4xx never enters the pattern.** User errors (`INVALID_BILLER_ACCOUNT`, 400) match none of the monitors, so no alert
  is created and they never reach Event Management.

## Expected behavior

| Event | Work Items in `GCC` |
| --- | --- |
| 15× 400 user errors | 0 |
| Storm #1, monitors go RED | 1 (Open) |
| Reset, then about 1–2 min until the monitors recover | Work Item #1 closes automatically |
| Wait 5 min (loop-guard cooldown), then storm #2 | 2 (#2 Open, #1 Closed) |

## Check it

1. Open **Events > Correlation**, select `gcc-payments-cascading-outage`, and confirm the pattern is Active with these
   settings.
2. After a storm, open **Events > Explorer** and filter on `env:gcc-poc`. The three `Monitor Alert` events should
   appear grouped under one correlation.
3. Open the `GCC` project. It should contain exactly one new Work Item that references all three monitors.
