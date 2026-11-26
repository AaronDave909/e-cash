'use strict';

const tracer = require('dd-trace');
const express = require('express');
const pino = require('pino');
const { createLogger } = require('../shared/logger');
const { requestIdMiddleware } = require('../shared/requestIdMiddleware');

const SERVICE = 'partner-gateway';
const PORT = Number(process.env.PORT || 8003);
const FAULT = { error_code: '503_POOL_EXHAUSTED', dependency: 'partner-gateway' };

const logger = createLogger(pino, SERVICE);
const app = express();
app.use(express.json());
app.use(requestIdMiddleware({ tracer, logger, dependency: 'partner-gateway' }));

// The whole fault model: one flag. /admin/fault sets it, /admin/reset clears it.
// Both are idempotent: calling either twice ends in the same state with the same answer.
let faultActive = false;

function unavailable(res, message) {
  res.locals.error_code = FAULT.error_code;
  res.status(503).json({ status: 'unavailable', ...FAULT, message });
}

app.post('/settle', (req, res) => {
  if (faultActive) return unavailable(res, 'Partner connection pool exhausted.');
  res.json({ status: 'settled', settlement_ref: `stl-${req.id}` });
});

app.get('/health', (req, res) => {
  if (faultActive) return unavailable(res, 'Fault mode active.');
  res.json({ status: 'ok', service: SERVICE, healthy: true });
});

app.post('/admin/fault', (req, res) => {
  faultActive = true;
  req.log.warn({ msg: 'fault_enabled', error_code: FAULT.error_code });
  res.json({ status: 'fault_enabled', healthy: false, error_code: FAULT.error_code });
});

app.post('/admin/reset', (req, res) => {
  const wasFaulted = faultActive;
  faultActive = false;
  req.log.info({ msg: 'reset_complete', was_faulted: wasFaulted });
  res.json({ status: 'reset_complete', healthy: true });
});

app.listen(PORT, () => logger.info({ msg: 'listening', port: PORT }));
