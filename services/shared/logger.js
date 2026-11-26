'use strict';

// The service passes its own pino so shared/ needs no node_modules of its own.
// dd-trace (DD_LOGS_INJECTION=true) adds dd.trace_id, dd.span_id, dd.service and dd.env to every line.
function createLogger(pino, service) {
  return pino({
    base: { service },
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

module.exports = { createLogger };
