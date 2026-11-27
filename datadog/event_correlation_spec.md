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
- A Work Management project with key **`GCC`** exists. To create it, open **Work Management > All Projects > New Project**
  and set Name `GCC Command Center` and Key `GCC`.
- At least one storm has run since the monitors were created. Grouping tags must exist as event facets, and the first
  monitor alerts create them.

Patterns are **not** created from the project's settings page. They have their own page, and the project is chosen inside
the form.

## Configuration

1. Open **Events > Correlation**, or go directly to `https://app.<DD_SITE>/event/correlation` (for example
   `https://app.datadoghq.com/event/correlation`).
2. Select **+ Add a Pattern**, then **+ Personalize From Scratch**. The suggested patterns group on other tags, so
   don't use **Continue With Pattern**.
3. Set the source and grouping:

   | Field | Value |
   | --- | --- |
   | Event source | **Monitor Alert** |
   | Filter by these events or tags | `env:gcc-poc domain:payments` |
   | Add grouping tags | `env`, `dependency` |
   | Customize work item title | `{{tag.dependency}} outage in {{tag.env}}` (optional) |

4. Select **Show Advanced Settings** and open the **Correlator Logic** tab:

   | Setting | Value |
   | --- | --- |
   | Minimum alert count | `1` |
   | Correlation window | `10 minutes` |
   | Deduplication window | `10 minutes` (short so that POC runs can follow each other quickly) |
   | Extend dedupe window until all alerts resolve | **On** |
   | Create a new work item after auto-closure | **On** |

5. Under **Select a Work Management destination**, choose **GCC Command Center** in the **Project** dropdown.
6. Select **Save and Activate**. Use the name `gcc-payments-cascading-outage` if the form asks for one.

Auto-close has no setting. A work item closes on its own once all of its alerts resolve. Leave **Intelligent
Correlation** off: its AI grouping could merge or split these alerts differently from this pattern.

The preview panel on the right shows the work items the pattern would create from recent events. After one storm it
should show a single work item that holds all three monitors. If you edit the pattern later, Datadog stops the open
work items, and the next matching alert starts a new one.

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
