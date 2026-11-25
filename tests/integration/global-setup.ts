import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import pg from "pg";
import { Redis } from "ioredis";
import type { GlobalSetupContext } from "vitest/node";

export interface Stack {
  gateway: string;
  auth: string;
  ledger: string;
  transfer: string;
  bankRail: string;
  worker: string;
  databaseUrl: string;
  redisUrl: string;
  logDir: string;
  /** The env every service gets on top of process.env, for tests that start an extra copy of a service. */
  serviceEnv: Record<string, string>;
}

declare module "vitest" {
  export interface ProvidedContext {
    stack: Stack;
  }
}

const ROOT = path.resolve(__dirname, "../..");
const PG_ADMIN = process.env["ECASH_TEST_PG_ADMIN_URL"] ?? "postgres://ecash:ecash@127.0.0.1:54329/postgres";
const REDIS_BASE = process.env["ECASH_TEST_REDIS_URL"] ?? "redis://127.0.0.1:63799";
const REDIS_DB = 5;

const SERVICES = ["ledger", "auth-kyc", "bank-rail", "transfer", "worker", "api-gateway"] as const;
type ServiceName = (typeof SERVICES)[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function canConnect(url: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

async function waitHealthy(name: string, url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited early with code ${child.exitCode}`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`${name} did not become healthy at ${url}`);
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  let startedInfra = false;
  if (!(await canConnect(PG_ADMIN))) {
    execFileSync(path.join(ROOT, "scripts/dev-infra.sh"), ["start"], { stdio: "inherit" });
    startedInfra = true;
  }

  const dbName = `ecash_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: PG_ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const adminUrl = new URL(PG_ADMIN);
  adminUrl.pathname = `/${dbName}`;
  const databaseUrl = adminUrl.toString();

  const redisUrl = `${REDIS_BASE}/${REDIS_DB}`;
  const redis = new Redis(redisUrl);
  await redis.flushdb();
  await redis.quit();

  const wanted = (process.env["ECASH_TEST_SERVICES"]?.split(",") as ServiceName[] | undefined) ?? [...SERVICES];
  const ports = Object.fromEntries(await Promise.all(SERVICES.map(async (s) => [s, await freePort()]))) as Record<ServiceName, number>;
  const url = (s: ServiceName) => `http://127.0.0.1:${ports[s]}`;

  const logDir = path.join(ROOT, ".local", "test-logs", dbName);
  mkdirSync(logDir, { recursive: true });

  const serviceEnv: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    JWT_SECRET: "test-jwt-secret",
    QR_SECRET: "test-qr-secret",
    RAIL_WEBHOOK_SECRET: "test-rail-secret",
    ECASH_EXPOSE_OTP: "true",
    ECASH_ALLOW_DEV_SECRETS: "true",
    ECASH_SIMULATOR_ENABLED: "true",
    AUTH_URL: url("auth-kyc"),
    LEDGER_URL: url("ledger"),
    TRANSFER_URL: url("transfer"),
    BANK_RAIL_URL: url("bank-rail"),
    WORKER_URL: url("worker"),
    RAIL_CALLBACK_URL: `${url("transfer")}/webhooks/bank-rail`,
    RAIL_SETTLE_MIN_MS: "100",
    RAIL_SETTLE_MAX_MS: "300",
    RATE_LIMIT_MAX: "100000",
    RECONCILER_INTERVAL_MS: "1000",
    RECONCILER_MIN_AGE_MS: "2000",
    PENDING_DEADLINE_MS: "8000",
    DD_ENV: "test",
    DD_VERSION: "1.0.0",
    DD_LOGS_INJECTION: "true",
    DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED: "false",
    DD_TRACE_AGENT_URL: "http://127.0.0.1:18126",
    DD_TRACE_STARTUP_LOGS: "false",
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false",
    DD_REMOTE_CONFIGURATION_ENABLED: "false",
    DD_AGENT_HOST: "127.0.0.1",
    DB_POOL_MAX: "15",
  };
  const baseEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...serviceEnv };

  const children: ChildProcess[] = [];
  const stopAll = async (): Promise<void> => {
    for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
    const deadline = Date.now() + 8000;
    while (children.some((c) => c.exitCode === null) && Date.now() < deadline) await sleep(50);
    for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  };

  try {
    const healthChecks: Promise<void>[] = [];
    for (const name of SERVICES) {
      if (!wanted.includes(name)) continue;
      const fd = openSync(path.join(logDir, `${name}.log`), "a");
      const child = spawn("node", ["-r", "dd-trace/init", `services/${name}/dist/index.js`], {
        cwd: ROOT,
        env: { ...baseEnv, PORT: String(ports[name]), DD_SERVICE: `ecash-${name}` },
        stdio: ["ignore", fd, fd],
      });
      closeSync(fd);
      children.push(child);
      healthChecks.push(waitHealthy(name, url(name), child));
    }
    await Promise.all(healthChecks);
  } catch (err) {
    await stopAll();
    throw err;
  }

  provide("stack", {
    gateway: url("api-gateway"),
    auth: url("auth-kyc"),
    ledger: url("ledger"),
    transfer: url("transfer"),
    bankRail: url("bank-rail"),
    worker: url("worker"),
    databaseUrl,
    redisUrl,
    logDir,
    serviceEnv,
  });

  return async () => {
    await stopAll();
    const a = new pg.Client({ connectionString: PG_ADMIN });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
    if (startedInfra) execFileSync(path.join(ROOT, "scripts/dev-infra.sh"), ["stop"], { stdio: "inherit" });
  };
}
