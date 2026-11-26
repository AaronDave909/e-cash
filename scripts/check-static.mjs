#!/usr/bin/env node
// Static checks for what cannot run without Docker or a Datadog org: compose topology, Dockerfile
// COPY sources against their build context, devcontainer, runner allowlist, and the Datadog artifacts.
//   npm run check
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let checks = 0;
const failures = [];
function expect(cond, message) {
  checks++;
  if (!cond) failures.push(message);
}

// ---- docker-compose.yml
const compose = YAML.parse(read('docker-compose.yml'), { merge: true });
const svc = compose.services;
const APPS = { 'bills-pay': 8001, 'wallet-transfer': 8002, 'partner-gateway': 8003, 'mock-jira': 8004 };
const TRACED = ['bills-pay', 'wallet-transfer', 'partner-gateway'];

expect(JSON.stringify(Object.keys(svc).sort()) === JSON.stringify(
  ['bills-pay', 'datadog-agent', 'dd-private-action-runner', 'fault-ui', 'mock-jira', 'partner-gateway', 'wallet-transfer']),
  `compose services are exactly the 7 in the spec, got ${Object.keys(svc)}`);

for (const [name, port] of Object.entries(APPS)) {
  const s = svc[name];
  expect(s.build.context === './services', `${name} build.context is ./services`);
  expect(s.build.dockerfile === `${name}/Dockerfile`, `${name} build.dockerfile is ${name}/Dockerfile`);
  expect(String(s.environment.PORT) === String(port), `${name} PORT=${port}`);
  expect(!s.ports, `${name} publishes no host port (only fault-ui does)`);
  expect(!s.depends_on || !JSON.stringify(s.depends_on).includes('datadog-agent'), `${name} does not depend on datadog-agent`);
}
for (const name of TRACED) {
  const e = svc[name].environment;
  expect(e.NODE_OPTIONS === '--require dd-trace/init', `${name} NODE_OPTIONS loads dd-trace/init`);
  expect(e.DD_SERVICE === name, `${name} DD_SERVICE=${name}`);
  expect(e.DD_ENV === 'gcc-poc', `${name} DD_ENV=gcc-poc`);
  expect(String(e.DD_VERSION) === '1.0.0', `${name} DD_VERSION=1.0.0`);
  expect(e.DD_LOGS_INJECTION === 'true', `${name} DD_LOGS_INJECTION=true`);
  expect(e.DD_TRACE_AGENT_URL === 'http://datadog-agent:8126', `${name} DD_TRACE_AGENT_URL`);
  const pkg = JSON.parse(read(`services/${name}/package.json`));
  expect(pkg.dependencies['dd-trace'] && pkg.dependencies.pino, `${name} package.json has dd-trace and pino`);
}
for (const name of ['bills-pay', 'wallet-transfer']) {
  expect(svc[name].environment.PARTNER_GATEWAY_URL === 'http://partner-gateway:8003', `${name} PARTNER_GATEWAY_URL`);
}
const ui = svc['fault-ui'];
expect(JSON.stringify(ui.ports) === JSON.stringify(['8080:8080']), 'fault-ui publishes 8080');
for (const [k, v] of Object.entries({ BILLS_PAY_URL: 'http://bills-pay:8001', WALLET_TRANSFER_URL: 'http://wallet-transfer:8002',
  PARTNER_GATEWAY_URL: 'http://partner-gateway:8003', MOCK_JIRA_URL: 'http://mock-jira:8004' })) {
  expect(ui.environment[k] === v, `fault-ui ${k}=${v}`);
}

const agent = svc['datadog-agent'];
expect(agent.image === 'gcr.io/datadoghq/agent:7', 'agent image gcr.io/datadoghq/agent:7');
for (const k of ['DD_APM_ENABLED', 'DD_APM_NON_LOCAL_TRAFFIC', 'DD_LOGS_ENABLED', 'DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL', 'DD_PROCESS_AGENT_ENABLED']) {
  expect(agent.environment[k] === 'true', `agent ${k}=true`);
}
expect(String(agent.environment.DD_API_KEY).includes('${DD_API_KEY'), 'agent reads DD_API_KEY from .env');
expect(String(agent.environment.DD_SITE).includes('${DD_SITE'), 'agent reads DD_SITE from .env');
expect(agent.volumes.some((v) => v.startsWith('/var/run/docker.sock:')), 'agent mounts docker.sock for container logs');

const runner = svc['dd-private-action-runner'];
expect(runner.image === 'gcr.io/datadoghq/private-action-runner:latest', 'runner image');
expect(JSON.stringify(runner.profiles) === '["runner"]', 'runner gated behind profile runner');
expect(runner.volumes.includes('./runner-config:/etc/dd-action-runner/config'), 'runner mounts ./runner-config');

// ---- Dockerfiles: every COPY source exists inside its build context
for (const [name, s] of Object.entries(svc).filter(([, s]) => s.build)) {
  const context = join(ROOT, s.build.context);
  const dockerfile = join(context, s.build.dockerfile);
  expect(existsSync(dockerfile), `${name} Dockerfile exists at ${s.build.dockerfile}`);
  if (!existsSync(dockerfile)) continue;
  const copies = readFileSync(dockerfile, 'utf8').split('\n').filter((l) => /^COPY\s/.test(l));
  expect(copies.length > 0, `${name} Dockerfile has COPY lines`);
  for (const line of copies) {
    const parts = line.trim().split(/\s+/).slice(1).filter((p) => !p.startsWith('--'));
    for (const src of parts.slice(0, -1)) {
      expect(!src.startsWith('..'), `${name}: COPY ${src} has no parent path`);
      expect(existsSync(join(context, src)), `${name}: COPY source ${src} exists in context ${s.build.context}`);
    }
  }
}

// ---- devcontainer, env, runner config
const dev = JSON.parse(read('.devcontainer/devcontainer.json'));
expect(dev.forwardPorts && dev.forwardPorts.includes(8080), 'devcontainer forwards 8080');
expect(Object.keys(dev.features || {}).some((f) => f.includes('docker-in-docker')), 'devcontainer enables docker-in-docker');
const envExample = read('.env.example');
expect(/^DD_API_KEY=/m.test(envExample) && /^DD_SITE=/m.test(envExample), '.env.example has DD_API_KEY and DD_SITE');
const runnerConfig = YAML.parse(read('runner-config/config.yaml.example'));
expect(JSON.stringify(runnerConfig.actionsAllowlist) === '["com.datadoghq.http.request"]', 'runner actionsAllowlist is only com.datadoghq.http.request');

// ---- Phase 2 artifacts (checked once they exist)
if (existsSync(join(ROOT, 'datadog/monitors.json'))) {
  const monitors = JSON.parse(read('datadog/monitors.json'));
  const list = Array.isArray(monitors) ? monitors : monitors.monitors;
  expect(list.length === 3, 'monitors.json has 3 monitors');
  const byKey = Object.fromEntries(list.map((m) => [m.tags.find((t) => t.startsWith('service:')), m]));
  for (const [service, status] of [['bills-pay', '>=500'], ['wallet-transfer', '>=500'], ['partner-gateway', '503']]) {
    const m = byKey[`service:${service}`];
    expect(m, `monitor for ${service}`);
    if (!m) continue;
    expect(m.type === 'log alert', `${service} monitor type is log alert`);
    expect(m.query.includes(`service:${service}`) && m.query.includes(`@status_code:${status}`), `${service} monitor query filters @status_code:${status}`);
    expect(m.query.includes('env:gcc-poc'), `${service} monitor query scoped to env:gcc-poc`);
    for (const t of ['env:gcc-poc', 'domain:payments', 'dependency:partner-gateway', `service:${service}`, 'error_code:503_POOL_EXHAUSTED']) {
      expect(m.tags.includes(t), `${service} monitor tag ${t}`);
    }
    expect(m.options && m.options.thresholds && m.options.thresholds.critical === 5, `${service} monitor critical threshold 5`);
  }
}
if (existsSync(join(ROOT, 'datadog/workflow_blueprint.json'))) {
  const bp = read('datadog/workflow_blueprint.json');
  const steps = JSON.parse(bp).spec.steps;
  expect(bp.includes('REPLACE_WITH_CONNECTION_ID') && bp.includes('REPLACE_WITH_DATASTORE_ID'), 'workflow blueprint carries REPLACE_WITH_* placeholders');
  const names = new Set(steps.map((s) => s.name));
  for (const s of steps) {
    for (const e of s.outboundEdges || []) expect(names.has(e.nextStepName), `blueprint edge ${s.name} -> ${e.nextStepName} exists`);
    for (const h of s.errorHandlers || []) expect(names.has(h.fallbackStepName), `blueprint fallback ${s.name} -> ${h.fallbackStepName} exists`);
  }
  for (const [, ref] of bp.matchAll(/Steps\.(\w+)\./g)) expect(names.has(ref), `blueprint expression references existing step ${ref}`);
  const hitBranch = ['Create_cached_ticket', 'Reset_gateway_cached', 'Verify_health_cached', 'Next_cache_values', 'Update_known_error', 'Resolve_cached_ticket'];
  expect(hitBranch.every((n) => !steps.find((s) => s.name === n).actionId.includes('BITS')), 'cache-hit branch has no Bits step');
}
if (existsSync(join(ROOT, 'playbooks/rb-partner-gateway-reset.yaml'))) {
  const rb = YAML.parse(read('playbooks/rb-partner-gateway-reset.yaml'));
  expect(Array.isArray(rb.stages) && rb.stages.length === 4, 'playbook has 4 stages');
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`\n${failures.length} of ${checks} static checks failed`);
  process.exit(1);
}
console.log(`PASS ${checks} static checks`);
