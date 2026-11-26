# Workflow setup: `gcc-known-error-self-heal`

This is the authoritative build guide. [`workflow_blueprint.json`](workflow_blueprint.json) is a reference skeleton
with the same steps and names, and it cannot be imported in one click. Build the workflow in the UI by following this
page.

The workflow runs **once per Work Item**. It looks up the error fingerprint in the Datadog Datastore and then takes
one of three paths:

```text
Work Item created (GCC project)
  └─ Build_fingerprint ─ Lookup_known_error ─ Classify
        ├─ cooldown  (cached, last reset < 5 min ago)  → stop. No reset, no ticket, no Bits.
        ├─ miss      (never seen)                       → Branch A: Bits Investigation once, heal, cache it
        └─ hit       (cached, cooldown elapsed)         → Branch B: 0 Bits credits, heal with cached RCA
```

> **Check names against your org.** Action and trigger names change between Datadog releases. Where this guide
> names an action (for example *Trigger Investigation*), search the action catalog for that name. If your org labels
> Work Management as **Case Management**, *Work Item* means *Case*.

## 0. Prerequisites

Do these once, in this order.

1. **Log facets.** Open **Logs > Configuration > Facets** (or select any log attribute in the Log Explorer) and create
   these facets:
   - `@status_code` as a **measure** (integer). The monitor query `@status_code:>=500` needs a numeric facet.
   - `@error_code`, `@dependency` and `@request_id` as facets (string).
2. **Monitors.** Import the three monitors in [`monitors.json`](monitors.json): open **Monitors > New Monitor >
   Import from JSON** once for each array entry, or use the API loop in the README. On each monitor, confirm that
   **Bits AI auto-investigate is OFF**. The workflow owns investigation, so it runs once per Work Item and not once per
   monitor.
3. **Event correlation.** Set it up as described in [`event_correlation_spec.md`](event_correlation_spec.md). This also
   creates the `GCC` project.
4. **Datastore.** Set up `gcc_known_error_cache` as described in [`datastore_schema.md`](datastore_schema.md).
5. **Private Action Runner.** Enroll it (README, *Private Action Runner enrollment*) and confirm it shows as
   **Connected** in **Actions > Private Action Runners**.
6. **HTTP connections through the runner.** Open **Actions > Connections > New Connection > HTTP** and create two
   connections. For both, set **Private Action Runner** to the runner you enrolled and set Authentication to **None**:

   | Connection name | Base URL |
   | --- | --- |
   | `gcc-partner-gateway` | `http://partner-gateway:8003` |
   | `gcc-mock-jira` | `http://mock-jira:8004` |

   These hostnames resolve only inside the Compose network. The runner reaches them, and nothing is exposed to the
   internet.
7. **Black-box only.** Under **Integrations**, confirm that GitHub (and any other source-code integration) is **not**
   installed for this org. Do not set `DD_GIT_*` variables on the services. Bits Investigation must work from telemetry
   alone: spans, status codes, JSON logs and container metrics.

## 1. Create the workflow

1. Open **Actions > Workflow Automation > New Workflow**. Name it `gcc-known-error-self-heal`.
2. Under **Run as**, pick a service account that has Datastore Editor access, Bits AI access, and use of both
   connections.
3. Add the trigger **Work Management (Case) trigger**. You attach the automation rule in step 5 below.

## 2. Shared steps

**Build_fingerprint**. Action *Data Transformation > Function* (JavaScript):

```js
// Work Item tags come from the correlated monitors, for example
// ["env:gcc-poc", "dependency:partner-gateway", "error_code:503_POOL_EXHAUSTED", ...].
// Use the trigger output preview to confirm the path to the tags in your org.
const tags = $.Trigger.workItem?.tags ?? $.Trigger.case?.attributes?.tags ?? [];
const tag = (key) => (tags.find((t) => t.startsWith(`${key}:`)) || '').slice(key.length + 1);
const dependency = tag('dependency');
const errorCode = tag('error_code');
if (!dependency || !errorCode) throw new Error(`Work item has no dependency/error_code tags: ${tags.join(',')}`);
return { fingerprint: `${dependency}:${errorCode}`, dependency, error_code: errorCode };
```

**Lookup_known_error**. Action *Datastore > Get Item*. Datastore `gcc_known_error_cache`, primary key
`{{ Steps.Build_fingerprint.data.fingerprint }}`. Turn on **Continue on error** if your version raises an error for a
missing item, because a missing item is a normal cache miss.

**Classify**. Action *Data Transformation > Function*. This step holds the loop guard:

```js
const COOLDOWN_MS = 5 * 60 * 1000;
const item = $.Steps.Lookup_known_error.data?.item?.value ?? $.Steps.Lookup_known_error.data?.item ?? null;
if (!item) return { path: 'miss' };
const sinceReset = Date.now() - Date.parse(item.last_reset_at);
if (sinceReset < COOLDOWN_MS) return { path: 'cooldown', seconds_since_reset: Math.round(sinceReset / 1000) };
return { path: 'hit', cached_rca: item.cached_rca, playbook_id: item.playbook_id, hit_count: Number(item.hit_count) || 0 };
```

**Loop_guard**. Action *If condition*: `{{ Steps.Classify.data.path }}` equals `cooldown`.
- **True**: end the workflow. Nothing else runs. The 5-minute guard stops a reset loop even if a Work Item is somehow
  created during the cooldown.
- **False**: go to **Cache_hit**.

**Cache_hit**. Action *If condition*: `{{ Steps.Classify.data.path }}` equals `hit`. **True** goes to Branch B and
**False** goes to Branch A.

## 3. Branch A: cache miss (first time this error is seen)

| # | Step name | Action | Settings |
| --- | --- | --- | --- |
| A1 | `Trigger_investigation` | *Bits AI > Trigger Investigation* | Scope it to the Work Item or its monitor alert. Prompt: *"Black-box RCA from APM spans, HTTP status codes, JSON logs and container metrics only. Services: bills-pay, wallet-transfer, partner-gateway in env:gcc-poc."* |
| A2 | `Get_investigation` | *Bits AI > Get Investigation* | Investigation ID from A1. Turn on retries (for example every 30 s, up to 10 times) until the status is complete. |
| A3 | `Create_ticket` | *HTTP > Make request*, connection `gcc-mock-jira` | `POST /tickets`, body below with `rca_source: "bits_ai"` and `rca_summary` set to the A2 summary |
| A4 | `Reset_gateway` | *HTTP > Make request*, connection `gcc-partner-gateway` | `POST /admin/reset`. Expect `200` and `{"status":"reset_complete","healthy":true}` |
| A5 | `Verify_health` | *HTTP > Make request*, connection `gcc-partner-gateway` | `GET /health`. Expect `200`. Retry 3 times, 2 s apart |
| A6 | `Cache_known_error` | *Datastore > Put Item* | Item below, with `hit_count: 1` |
| A7 | `Resolve_ticket` | *HTTP > Make request*, connection `gcc-mock-jira` | `PATCH /tickets/{{ Steps.Create_ticket.data.body.id }}` with `{"status":"Resolved","resolution_note":"Auto-healed by RB-GCC-L2-001 (bits_ai RCA)."}` |

A3 body:

```json
{
  "fingerprint": "{{ Steps.Build_fingerprint.data.fingerprint }}",
  "title": "{{ Steps.Build_fingerprint.data.dependency }} {{ Steps.Build_fingerprint.data.error_code }}: cascading payments outage",
  "rca_source": "bits_ai",
  "rca_summary": "{{ Steps.Get_investigation.data.summary }}"
}
```

Bits summaries often contain quotes and newlines. Build the body as a JSON **object** in the HTTP action, not as a
raw string, so the summary is escaped. A raw string body breaks on the first `"` in the summary. Do the same in B1.

A6 item:

```json
{
  "fingerprint": "{{ Steps.Build_fingerprint.data.fingerprint }}",
  "playbook_id": "RB-GCC-L2-001",
  "cached_rca": "{{ Steps.Get_investigation.data.summary }}",
  "remediation_url": "http://partner-gateway:8003/admin/reset",
  "last_reset_at": "{{ Steps.Reset_time.data.now }}",
  "hit_count": 1
}
```

`Reset_time` is a one-line *Function* step placed right after A5: `return { now: new Date().toISOString() };`.

## 4. Branch B: cache hit (known repeat error, 0 Bits credits)

Branch B has no Bits AI step.

| # | Step name | Action | Settings |
| --- | --- | --- | --- |
| B1 | `Create_cached_ticket` | *HTTP > Make request*, connection `gcc-mock-jira` | `POST /tickets` with `rca_source: "datadog_datastore_cache"` and `rca_summary: "{{ Steps.Classify.data.cached_rca }}"` |
| B2 | `Reset_gateway_cached` | *HTTP > Make request*, connection `gcc-partner-gateway` | `POST /admin/reset`. Expect `200` |
| B3 | `Verify_health_cached` | *HTTP > Make request*, connection `gcc-partner-gateway` | `GET /health`. Expect `200`. Retry 3 times, 2 s apart |
| B4 | `Next_cache_values` | *Data Transformation > Function* | `return { last_reset_at: new Date().toISOString(), hit_count: $.Steps.Classify.data.hit_count + 1 };` |
| B5 | `Update_known_error` | *Datastore > Update Item* | Key `{{ Steps.Build_fingerprint.data.fingerprint }}`. Set `last_reset_at` and `hit_count` from B4 |
| B6 | `Resolve_cached_ticket` | *HTTP > Make request*, connection `gcc-mock-jira` | `PATCH /tickets/{{ Steps.Create_cached_ticket.data.body.id }}` with `{"status":"Resolved","resolution_note":"Auto-healed by RB-GCC-L2-001 (cached RCA, 0 Bits credits)."}` |

## When verification fails

If A5 or B3 still does not get `200` after its retries, the reset did not heal the gateway. Add an error path on that
step that:

1. sends `PATCH /tickets/<id>` with `{"resolution_note":"Self-heal verification failed: partner-gateway /health not 200. L2 on-call to investigate."}`
   so the ticket stays **Open**, and
2. ends the workflow without writing to the datastore in Branch A. A fix that was never verified must not become
   cached knowledge.

## 5. Connect the trigger: "Upon work item creation"

1. Open the `GCC` project and go to **Settings > Automation** (Case Management: **Project settings > Automation
   rules**). Select **+ New rule**.
2. Set **When** to `Upon work item creation` and **Then** to *Run workflow* `gcc-known-error-self-heal`.
3. Save the rule and **publish** the workflow.

The rule fires once per Work Item, and correlation produces one Work Item per outage. Together they make one workflow
run per outage, whatever the number of failed requests.

## 6. Check it

| Check | Where | Expected |
| --- | --- | --- |
| Run #1 took Branch A | Workflow **Run history** | `Classify.path = miss`, with A1–A7 green |
| One Bits Investigation | **Bits AI > Investigations** | Exactly 1 new investigation for Run #1 |
| Cache written | **Actions > Datastore > gcc_known_error_cache** | Item `partner-gateway:503_POOL_EXHAUSTED`, `hit_count: 1` |
| Run #2 took Branch B | Run history | `Classify.path = hit`, with B1–B6 green and no Bits step |
| No new investigation | Bits AI > Investigations | Still 1 |
| Cache updated | Datastore | `hit_count: 2`, `last_reset_at` updated |
| Tickets | fault-ui on `:8080` | `GCC-1` `bits_ai` Resolved, then `GCC-2` `datadog_datastore_cache` Resolved |
| Loop guard | Use **Run** in the workflow editor with the last Work Item, less than 5 min after a heal | Run ends at `Loop_guard` with `path = cooldown`, and no reset or ticket happens |
