import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { inject } from "vitest";

export const stack = inject("stack");

export interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = any>(
  method: string,
  route: string,
  opts: { token?: string; key?: string | null; body?: unknown; headers?: Record<string, string>; base?: string } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.key !== null && opts.key !== undefined) headers["idempotency-key"] = opts.key;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${opts.base ?? stack.gateway}${route}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export interface TestUser {
  id: string;
  mobile: string;
  token: string;
  mpin: string;
  name: string;
}

let mobileCounter = Math.floor(Math.random() * 1_000_000);
export function newMobile(): string {
  mobileCounter = (mobileCounter + 1) % 100_000_000;
  const body = String(Date.now() % 10).concat(String(mobileCounter).padStart(8, "0"));
  return `+639${body}`;
}

export async function newUser(opts: { tier?: "BASIC" | "FULLY_VERIFIED"; name?: string } = {}): Promise<TestUser> {
  const mobile = newMobile();
  const name = opts.name ?? `Tester ${mobile.slice(-4)}`;
  const reg = await api("POST", "/api/auth/register", { body: { mobile, display_name: name } });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const mpin = "1234";
  const ver = await api("POST", "/api/auth/verify-otp", { body: { mobile, otp: reg.body.dev_otp, mpin } });
  if (ver.status !== 200) throw new Error(`verify failed: ${JSON.stringify(ver.body)}`);
  let user: TestUser = { id: ver.body.user.id, mobile, token: ver.body.token, mpin, name };
  if (opts.tier === "FULLY_VERIFIED") {
    const k = await api("POST", `/api/sim/users/${user.id}/kyc`, { body: { tier: "FULLY_VERIFIED" } });
    if (k.status !== 200) throw new Error(`kyc failed: ${JSON.stringify(k.body)}`);
    user = { ...user, token: (await login(user)).token };
  }
  return user;
}

export async function login(u: { mobile: string; mpin: string }): Promise<{ token: string }> {
  const r = await api("POST", "/api/auth/login", { body: { mobile: u.mobile, mpin: u.mpin } });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

export const pesos = (n: number): number => n * 100;

export async function wallet(u: TestUser) {
  const r = await api("GET", "/api/wallet", { token: u.token });
  if (r.status !== 200) throw new Error(`wallet failed: ${JSON.stringify(r.body)}`);
  return r.body as { balance_centavos: number; tier: string; month_out_centavos: number; month_limit_centavos: number };
}

export const balanceOf = async (u: TestUser): Promise<number> => (await wallet(u)).balance_centavos;

export async function getTransfer(u: TestUser, id: string) {
  const r = await api("GET", `/api/transfers/${id}`, { token: u.token });
  if (r.status !== 200) throw new Error(`get transfer failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function waitForStatus(u: TestUser, id: string, status: string, timeoutMs = 20_000) {
  return waitFor(async () => {
    const t = await getTransfer(u, id);
    return t.status === status ? t : undefined;
  }, `transfer ${id} to reach ${status}`, timeoutMs);
}

/** Funds a wallet through the real cash-in path and waits for it to settle. */
export async function fund(u: TestUser, centavos: number, bank = "INSTAPAY"): Promise<void> {
  const r = await api("POST", "/api/cash-in", { token: u.token, key: randomUUID(), body: { bank, amount_centavos: centavos } });
  if (r.status !== 201) throw new Error(`cash-in failed: ${JSON.stringify(r.body)}`);
  await waitForStatus(u, r.body.id, "COMPLETED");
}

export const send = (from: TestUser, to: TestUser, centavos: number, key: string = randomUUID()) =>
  api("POST", "/api/transfers/p2p", { token: from.token, key, body: { to_mobile: to.mobile, amount_centavos: centavos } });

export async function reconcile() {
  return (await api("GET", "/api/system/reconcile")).body as { status: string; total_debits: number; total_credits: number };
}

/** Reads a service's JSON log file as parsed lines. */
export function readLog(service: string): Array<Record<string, any>> {
  const file = path.join(stack.logDir, `${service}.log`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, any>;
      } catch {
        return {};
      }
    });
}

/** Ops reversal. It is internal-only, so tests call the transfer service's own port. */
export const reverseTransfer = (id: string) => api("POST", `/internal/transfers/${id}/reverse`, { base: stack.transfer });

/** Sends the path exactly as written. fetch() normalizes "/.." segments; node:http does not. */
export function rawRequest(
  method: string,
  rawPath: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; base?: string } = {},
): Promise<{ status: number; body: any }> {
  const u = new URL(opts.base ?? stack.gateway);
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: rawPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: any = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

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

export interface ExtraService {
  url: string;
  /** Everything the process wrote to stdout and stderr so far. */
  output(): string;
  /** Resolves with the exit code when the process exits. */
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

/**
 * Starts one more copy of a service against the test stack's database and Redis, with env overrides
 * (an `undefined` value removes the variable). Waits for /health unless `waitHealthy` is false.
 */
export async function startExtraService(
  name: string,
  overrides: Record<string, string | undefined>,
  opts: { waitHealthy?: boolean } = {},
): Promise<ExtraService> {
  const port = await freePort();
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...stack.serviceEnv, PORT: String(port), DD_SERVICE: `ecash-${name}-extra` };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const root = path.resolve(__dirname, "../..");
  const child = spawn("node", ["-r", "dd-trace/init", `services/${name}/dist/index.js`], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (out += c.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const svc: ExtraService = {
    url: `http://127.0.0.1:${port}`,
    output: () => out,
    exited,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([exited, sleep(5000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
  if (opts.waitHealthy === false) return svc;
  let done = false;
  void exited.then(() => (done = true));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !done) {
    try {
      if ((await fetch(`${svc.url}/health`)).ok) return svc;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  await svc.stop();
  throw new Error(`${name} did not become healthy:\n${out}`);
}
