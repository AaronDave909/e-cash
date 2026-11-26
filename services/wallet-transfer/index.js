'use strict';

const tracer = require('dd-trace');
const express = require('express');
const pino = require('pino');
const { createLogger } = require('../shared/logger');
const { requestIdMiddleware } = require('../shared/requestIdMiddleware');
const { settle } = require('../shared/upstream');

const SERVICE = 'wallet-transfer';
const PORT = Number(process.env.PORT || 8002);
const PARTNER_GATEWAY_URL = process.env.PARTNER_GATEWAY_URL || 'http://partner-gateway:8003';
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 2000);

const logger = createLogger(pino, SERVICE);
const app = express();
app.use(express.json());
app.use(requestIdMiddleware({ tracer, logger, dependency: 'partner-gateway' }));

app.post('/transfer', async (req, res) => {
  const { channel = 'app' } = req.body || {};
  const result = await settle({
    gatewayUrl: PARTNER_GATEWAY_URL,
    requestId: req.id,
    body: { channel, source: SERVICE },
    timeoutMs: UPSTREAM_TIMEOUT_MS,
  });
  if (result.status !== 200) res.locals.error_code = result.body.error_code;
  res.status(result.status).json(
    result.status === 200
      ? { status: 'settled', channel, request_id: req.id }
      : { status: 'failed', ...result.body, request_id: req.id },
  );
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: SERVICE }));

app.listen(PORT, () => logger.info({ msg: 'listening', port: PORT }));
