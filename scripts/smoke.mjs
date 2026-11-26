#!/usr/bin/env node
// Phase 1 smoke test. Drives every behavior through fault-ui's /api proxy, exactly the path the
// browser uses, and exits non-zero on the first mismatch.
//   node scripts/smoke.mjs                      # against http://localhost:8080
//   BASE=http://localhost:8080 LOG_DIR=.local/logs node scripts/smoke.mjs   # also checks logs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE || 'http://localhost:8080';
const LOG_DIR = process.env.LOG_DIR;
let checks = 0;

function fail(message, detail) {
  console.error(`FAIL ${message}`);
  if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
  process.exit(1);
}
function expect(cond, message, detail) {
  if (!cond) fail(message, detail);
  checks++;
}

async function call(path, { method = 'GET', body, requestId } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (requestId) headers['X-Request-ID'] = requestId;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, requestId: res.headers.get('x-request-id') };
}
const statuses = (rs) => rs.map((r) => r.status);

function step(name) { console.log(`\n== ${name}`); }

// Clean state so the script can be rerun any number of times.
step('reset to a clean state');
expect((await call('/api/partner-gateway/admin/reset', { method: 'POST' })).status === 200, 'initial reset');
expect((await call('/api/mock-jira/tickets', { method: 'DELETE' })).status === 200, 'initial ticket clear');

step('fault-ui serves the control panel');
const page = await call('/');
expect(page.status === 200 && String(page.data).includes('Trigger Cascading 503 Storm'), 'index.html served');
expect((await call('/api/not-a-service/x')).status === 404, 'unknown upstream is 404');

step('baseline traffic is 200');
const rid = 'smoke-req-0001';
const pay = await call('/api/bills-pay/pay-bill', { method: 'POST', body: { biller_code: 'MERALCO', channel: 'app' }, requestId: rid });
expect(pay.status === 200 && pay.data.status === 'paid', 'bills-pay 200', pay);
expect(pay.requestId === rid && pay.data.request_id === rid, 'X-Request-ID propagated and echoed', pay);
const baseline = await Promise.all(Array.from({ length: 10 }, (_, i) => i % 2
  ? call('/api/bills-pay/pay-bill', { method: 'POST', body: { biller_code: 'MERALCO', channel: 'app' } })
  : call('/api/wallet-transfer/transfer', { method: 'POST', body: { channel: 'app' } })));
expect(baseline.every((r) => r.status === 200), 'baseline all 200', statuses(baseline));
expect((await call('/api/bills-pay/health?deep=true')).status === 200, 'bills-pay deep health 200 while healthy');
for (const s of ['bills-pay', 'wallet-transfer', 'partner-gateway', 'mock-jira']) {
  expect((await call(`/api/${s}/health`)).status === 200, `${s} /health 200`);
}

step('15x normal user errors are 400');
const invalid = await Promise.all(Array.from({ length: 15 }, () =>
  call('/api/bills-pay/pay-bill/invalid', { method: 'POST', body: { biller_code: 'GLOBE', channel: 'app' } })));
expect(invalid.every((r) => r.status === 400 && r.data.error_code === 'INVALID_BILLER_ACCOUNT'), '15x 400 INVALID_BILLER_ACCOUNT', statuses(invalid));

step('cascading 503 storm');
const fault = await call('/api/partner-gateway/admin/fault', { method: 'POST' });
expect(fault.status === 200, 'admin/fault 200', fault);
const gwHealth = await call('/api/partner-gateway/health');
expect(gwHealth.status === 503 && gwHealth.data.error_code === '503_POOL_EXHAUSTED', 'gateway /health 503 in fault mode', gwHealth);
const settle = await call('/api/partner-gateway/settle', { method: 'POST', body: { channel: 'app' } });
expect(settle.status === 503 && settle.data.dependency === 'partner-gateway', 'gateway /settle 503 with dependency', settle);
const storm = await Promise.all(Array.from({ length: 25 }, (_, i) => i % 2 === 0
  ? call('/api/bills-pay/pay-bill', { method: 'POST', body: { biller_code: 'MAYNILAD', channel: 'app' } })
  : call('/api/wallet-transfer/transfer', { method: 'POST', body: { channel: 'app' } })));
expect(storm.every((r) => r.status === 502 && r.data.error_code === '503_POOL_EXHAUSTED' && r.data.dependency === 'partner-gateway'),
  '25/25 storm requests are 502 carrying 503_POOL_EXHAUSTED', storm.map((r) => [r.status, r.data.error_code]));
expect((await call('/api/bills-pay/health?deep=true')).status === 503, 'bills-pay deep health 503 during outage');
expect((await call('/api/bills-pay/health')).status === 200, 'bills-pay shallow health stays 200');

step('idempotent self-healing reset');
for (let i = 1; i <= 2; i++) {
  const reset = await call('/api/partner-gateway/admin/reset', { method: 'POST' });
  expect(reset.status === 200 && reset.data.status === 'reset_complete' && reset.data.healthy === true, `reset #${i} answers reset_complete`, reset);
}
expect((await call('/api/partner-gateway/health')).status === 200, 'gateway healthy after reset');
const after = await Promise.all([
  call('/api/bills-pay/pay-bill', { method: 'POST', body: { biller_code: 'MERALCO', channel: 'app' } }),
  call('/api/wallet-transfer/transfer', { method: 'POST', body: { channel: 'app' } }),
]);
expect(after.every((r) => r.status === 200), 'traffic 200 after reset', statuses(after));

step('mock-jira ticket CRUD');
const fp = 'partner-gateway:503_POOL_EXHAUSTED';
const t1 = await call('/api/mock-jira/tickets', { method: 'POST', body: { fingerprint: fp, title: 'partner-gateway 503 pool exhausted', rca_source: 'bits_ai', rca_summary: 'Connection pool exhausted at partner-gateway.' } });
expect(t1.status === 201 && t1.data.id === 'GCC-1' && t1.data.status === 'Open' && t1.data.duplicate_count === 0, 'create GCC-1', t1);
const dup = await call('/api/mock-jira/tickets', { method: 'POST', body: { fingerprint: fp, title: 'again', rca_source: 'bits_ai' } });
expect(dup.status === 200 && dup.data.id === 'GCC-1' && dup.data.duplicate_count === 1, 'duplicate POST bumps duplicate_count', dup);
const resolved = await call('/api/mock-jira/tickets/GCC-1', { method: 'PATCH', body: { status: 'Resolved', resolution_note: 'reset via runner' } });
expect(resolved.status === 200 && resolved.data.status === 'Resolved' && resolved.data.resolved_at && resolved.data.resolution_notes.length === 1, 'resolve GCC-1', resolved);
const t2 = await call('/api/mock-jira/tickets', { method: 'POST', body: { fingerprint: fp, title: 'repeat outage', rca_source: 'datadog_datastore_cache', rca_summary: 'cached' } });
expect(t2.status === 201 && t2.data.id === 'GCC-2', 'a resolved ticket does not absorb a new outage', t2);
const bump = await call('/api/mock-jira/tickets/GCC-2', { method: 'PATCH', body: { increment_duplicate: true } });
expect(bump.status === 200 && bump.data.duplicate_count === 1, 'PATCH increment_duplicate', bump);
const list = await call('/api/mock-jira/tickets');
expect(list.status === 200 && list.data.map((t) => t.id).join() === 'GCC-2,GCC-1', 'GET lists newest first', list.data);
expect(list.data.map((t) => t.rca_source).join() === 'datadog_datastore_cache,bits_ai', 'rca_source kept per ticket');
expect((await call('/api/mock-jira/tickets', { method: 'POST', body: { fingerprint: fp, title: 'x', rca_source: 'guess' } })).status === 400, 'bad rca_source is 400');
expect((await call('/api/mock-jira/tickets/GCC-99', { method: 'PATCH', body: { status: 'Resolved' } })).status === 404, 'unknown ticket is 404');
const cleared = await call('/api/mock-jira/tickets', { method: 'DELETE' });
expect(cleared.status === 200 && cleared.data.cleared === 2, 'DELETE clears tickets', cleared);
expect((await call('/api/mock-jira/tickets')).data.length === 0, 'list empty after clear');

if (LOG_DIR) {
  step(`structured logs in ${LOG_DIR}`);
  await new Promise((r) => setTimeout(r, 300)); // let stdout flush
  const PII = ['user_id', 'account_number', 'mobile_number', 'transaction_id'];
  for (const service of ['bills-pay', 'wallet-transfer', 'partner-gateway', 'mock-jira']) {
    const lines = readFileSync(join(LOG_DIR, `${service}.log`), 'utf8').split('\n').filter(Boolean);
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { fail(`${service} log line is not JSON`, l); } });
    expect(parsed.length > 0, `${service} wrote logs`);
    const done = parsed.filter((e) => e.msg === 'request_completed');
    expect(done.length > 0, `${service} wrote completion logs`);
    for (const e of done) {
      for (const k of ['status_code', 'method', 'path', 'dependency', 'request_id']) {
        if (e[k] === undefined) fail(`${service} completion log missing ${k}`, e);
      }
      if (e.status_code >= 400 && !e.error_code) fail(`${service} error log missing error_code`, e);
    }
    checks++;
    if (service !== 'mock-jira') {
      expect(done.every((e) => e.dd && e.dd.trace_id && e.dd.span_id && e.dd.service === service && e.dd.env === 'gcc-poc'),
        `${service} completion logs carry dd.trace_id/span_id/service/env`, done.find((e) => !(e.dd && e.dd.trace_id)));
    }
    const leaked = lines.filter((l) => PII.some((k) => l.includes(`"${k}"`)));
    expect(leaked.length === 0, `${service} logs contain no PII field names`, leaked.slice(0, 3));
  }
  const gw = readFileSync(join(LOG_DIR, 'partner-gateway.log'), 'utf8');
  expect(gw.includes('"request_id":"smoke-req-0001"'), 'X-Request-ID reached partner-gateway logs');
  const bp = readFileSync(join(LOG_DIR, 'bills-pay.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  expect(bp.some((e) => e.status_code === 400 && e.level === 'warn' && e.error_code === 'INVALID_BILLER_ACCOUNT'), '4xx logged at warn with error_code');
  expect(bp.some((e) => e.status_code === 502 && e.level === 'error' && e.error_code === '503_POOL_EXHAUSTED' && e.dependency === 'partner-gateway'), '5xx logged at error with root-cause error_code');
}

console.log(`\nPASS ${checks} checks against ${BASE}`);
