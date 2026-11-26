'use strict';

// Calls partner-gateway /settle and maps the outcome to what bills-pay and wallet-transfer answer.
// Upstream 5xx -> 502, timeout -> 504, network failure -> 502. The upstream error_code is kept so
// the caller's completion log and span carry the root cause (e.g. 503_POOL_EXHAUSTED).
async function settle({ gatewayUrl, requestId, body, timeoutMs }) {
  let response;
  try {
    response = await fetch(`${gatewayUrl}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { status: 504, body: { error_code: 'UPSTREAM_TIMEOUT', dependency: 'partner-gateway' } };
    }
    return { status: 502, body: { error_code: 'UPSTREAM_UNREACHABLE', dependency: 'partner-gateway' } };
  }

  const payload = await response.json().catch(() => ({}));
  if (response.ok) return { status: 200, body: payload };
  return {
    status: response.status >= 500 ? 502 : response.status,
    body: {
      error_code: payload.error_code || `UPSTREAM_${response.status}`,
      dependency: payload.dependency || 'partner-gateway',
    },
  };
}

module.exports = { settle };
