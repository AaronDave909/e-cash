'use strict';

const path = require('node:path');
const express = require('express');

const PORT = Number(process.env.PORT || 8080);
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 10000);

// /api/<name>/* is forwarded to the service's internal URL, so the browser only ever talks to :8080.
// That keeps one forwarded port in Codespaces and no CORS anywhere.
const UPSTREAMS = {
  'bills-pay': process.env.BILLS_PAY_URL || 'http://bills-pay:8001',
  'wallet-transfer': process.env.WALLET_TRANSFER_URL || 'http://wallet-transfer:8002',
  'partner-gateway': process.env.PARTNER_GATEWAY_URL || 'http://partner-gateway:8003',
  'mock-jira': process.env.MOCK_JIRA_URL || 'http://mock-jira:8004',
};

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/:upstream', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
  const base = UPSTREAMS[req.params.upstream];
  if (!base) return res.status(404).json({ error_code: 'UNKNOWN_UPSTREAM', upstream: req.params.upstream });

  const headers = {};
  for (const name of ['content-type', 'x-request-id']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const hasBody = !['GET', 'HEAD'].includes(req.method) && req.body && req.body.length > 0;

  try {
    const upstream = await fetch(base + req.url, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    res.status(upstream.status);
    for (const name of ['content-type', 'x-request-id']) {
      const value = upstream.headers.get(name);
      if (value) res.set(name, value);
    }
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).json({ error_code: 'PROXY_UPSTREAM_UNREACHABLE', upstream: req.params.upstream });
  }
});

app.listen(PORT, () => {
  process.stdout.write(JSON.stringify({ level: 'info', service: 'fault-ui', msg: 'listening', port: PORT, upstreams: UPSTREAMS }) + '\n');
});
