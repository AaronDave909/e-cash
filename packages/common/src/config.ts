export function envStr(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required env var ${name}`);
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env var ${name} must be a number, got ${v}`);
  return n;
}

export function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1";
}

/** Values shipped in scripts, tests and old Compose files. Anyone can read them, so they sign nothing real. */
const DEV_SECRETS: ReadonlySet<string> = new Set([
  "change-me-jwt",
  "change-me-qr",
  "change-me-rail",
  "dev-jwt-secret-change-me",
  "dev-qr-secret-change-me",
  "dev-rail-webhook-secret",
  "test-jwt-secret",
  "test-qr-secret",
  "test-rail-secret",
]);
export const MIN_SECRET_LENGTH = 32;

/**
 * A signing secret. Throws (so the service refuses to start) when it is shorter than 32 characters
 * or a known dev default, unless ECASH_ALLOW_DEV_SECRETS=true (dev scripts and tests only).
 */
export function envSecret(name: string): string {
  const v = envStr(name);
  if ((v.length < MIN_SECRET_LENGTH || DEV_SECRETS.has(v)) && !envBool("ECASH_ALLOW_DEV_SECRETS")) {
    throw new Error(
      `${name} is a dev default or shorter than ${MIN_SECRET_LENGTH} characters; set a real one (openssl rand -hex 32) or ECASH_ALLOW_DEV_SECRETS=true for local use`,
    );
  }
  return v;
}

/** Base URLs of sibling services, overridable per environment. */
export function serviceUrls() {
  return {
    auth: envStr("AUTH_URL", "http://127.0.0.1:8081"),
    ledger: envStr("LEDGER_URL", "http://127.0.0.1:8082"),
    transfer: envStr("TRANSFER_URL", "http://127.0.0.1:8083"),
    bankRail: envStr("BANK_RAIL_URL", "http://127.0.0.1:8084"),
    worker: envStr("WORKER_URL", "http://127.0.0.1:8085"),
  };
}

export const databaseUrl = (): string => envStr("DATABASE_URL", "postgres://ecash:ecash@127.0.0.1:54329/ecash");
export const redisUrl = (): string => envStr("REDIS_URL", "redis://127.0.0.1:63799/0");
