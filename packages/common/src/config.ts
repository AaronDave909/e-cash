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
