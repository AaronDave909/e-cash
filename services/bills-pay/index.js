'use strict';

const tracer = require('dd-trace');
const express = require('express');
const pino = require('pino');
const { createLogger } = require('../shared/logger');
const { requestIdMiddleware } = require('../shared/requestIdMiddleware');
const { settle } = require('../shared/upstream');

const SERVICE = 'bills-pay';
const PORT = Number(process.env.PORT || 8001);
const PARTNER_GATEWAY_URL = process.env.PARTNER_GATEWAY_URL || 'http://partner-gateway:8003';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 2000);

const logger = createLogger(pino, SERVICE);
const app = express();
app.use(express.json());
app.use(requestIdMiddleware({ tracer, logger, dependency: 'partner-gateway' }));

app.post('/pay-bill', async (req, res) => {
  const { biller_code = 'MERALCO', channel = 'app' } = req.body || {};
  const result = await settle({
    gatewayUrl: PARTNER_GATEWAY_URL,
    requestId: req.id,
    body: { biller_code, channel, source: SERVICE },
    timeoutMs: UPSTREAM_TIMEOUT_MS,
  });
  if (result.status !== 200) res.locals.error_code = result.body.error_code;
  res.status(result.status).json(
    result.status === 200
      ? { status: 'paid', biller_code, channel, request_id: req.id }
      : { status: 'failed', ...result.body, request_id: req.id },
  );
});

// A normal user mistake: logged and traced, but a 4xx, so the 5xx monitors never see it.
app.post('/pay-bill/invalid', (req, res) => {
  res.locals.error_code = 'INVALID_BILLER_ACCOUNT';
  res.locals.dependency = 'none';
  res.status(400).json({
    status: 'rejected',
    error_code: 'INVALID_BILLER_ACCOUNT',
    message: 'Biller account reference is not valid for this biller.',
    request_id: req.id,
  });
});

app.get('/health', async (req, res) => {
  if (req.query.deep !== 'true') return res.json({ status: 'ok', service: SERVICE });
  const upstream = await fetch(`${PARTNER_GATEWAY_URL}/health`, {
    headers: { 'X-Request-ID': req.id },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }).catch(() => null);
  if (upstream && upstream.ok) return res.json({ status: 'ok', service: SERVICE, downstream: 'ok' });
  res.locals.error_code = 'DOWNSTREAM_UNHEALTHY';
  res.status(503).json({ status: 'degraded', service: SERVICE, downstream: 'partner-gateway' });
});

app.listen(PORT, () => logger.info({ msg: 'listening', port: PORT }));
