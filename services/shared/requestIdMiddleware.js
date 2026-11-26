'use strict';

const { randomUUID } = require('node:crypto');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

// Correlation and zero-PII contract for every service:
// - reads X-Request-ID (or mints a UUIDv4) and echoes it on the response
// - tags the active dd-trace span with request.id and dependency
// - binds request_id to a per-request pino child logger (req.log)
// - emits exactly one structured completion log per response
// Handlers report outcome through res.locals.error_code and res.locals.dependency.
// The tracer is the service's own dd-trace instance, the one NODE_OPTIONS initialised.
function requestIdMiddleware({ tracer, logger, dependency }) {
  return function requestId(req, res, next) {
    const incoming = req.get('X-Request-ID');
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    const startedAt = process.hrtime.bigint();

    req.id = requestId;
    req.log = logger.child({ request_id: requestId });
    res.locals.dependency = dependency;
    res.set('X-Request-ID', requestId);

    const span = tracer && tracer.scope().active();
    if (span) {
      span.setTag('request.id', requestId);
      span.setTag('dependency', dependency);
    }

    res.on('finish', () => {
      const status = res.statusCode;
      const errorCode = res.locals.error_code;
      if (span) {
        span.setTag('dependency', res.locals.dependency);
        if (errorCode) span.setTag('error_code', errorCode);
      }
      const entry = {
        msg: 'request_completed',
        method: req.method,
        path: req.baseUrl + req.path,
        status_code: status,
        dependency: res.locals.dependency,
        duration_ms: Number((process.hrtime.bigint() - startedAt) / 1000n) / 1000,
      };
      if (errorCode) entry.error_code = errorCode;
      if (status >= 500) req.log.error(entry);
      else if (status >= 400) req.log.warn(entry);
      else req.log.info(entry);
    });

    next();
  };
}

module.exports = { requestIdMiddleware };
