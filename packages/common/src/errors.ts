/** Every error code the API can return, with its HTTP status. The only place status codes are chosen. */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  INVALID_OTP: 400,
  QR_INVALID: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  INVALID_SIGNATURE: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  RECIPIENT_NOT_FOUND: 404,
  TRANSFER_NOT_FOUND: 404,
  QR_NOT_FOUND: 404,
  MOBILE_ALREADY_REGISTERED: 409,
  QR_ALREADY_PAID: 409,
  ILLEGAL_TRANSITION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  IDEMPOTENCY_KEY_REUSED: 422,
  INSUFFICIENT_FUNDS: 422,
  LIMIT_EXCEEDED: 422,
  UNBALANCED: 422,
  SELF_TRANSFER: 422,
  AMOUNT_MISMATCH: 422,
  QR_EXPIRED: 422,
  NOT_REVERSIBLE: 422,
  ACCOUNT_LOCKED: 423,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_UNAVAILABLE: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = ERROR_STATUS[code];
  }
}

export function isErrorCode(s: string): s is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_STATUS, s);
}
