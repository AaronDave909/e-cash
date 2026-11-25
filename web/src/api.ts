// The only module that talks to the gateway. Every assumption about a response
// field the contract leaves open lives in a `normalize*` function below.

export type Tier = "BASIC" | "FULLY_VERIFIED";
export type TransferType = "p2p" | "qr" | "bills" | "cash_in" | "cash_out";
export type TransferStatus = "PENDING" | "COMPLETED" | "FAILED" | "REVERSED";
export type Bank = "INSTAPAY" | "PESONET" | "BPI" | "UNIONBANK" | "OTC_7ELEVEN";
export type Biller = "MERALCO" | "MAYNILAD" | "GLOBE";

export const BANKS: readonly Bank[] = ["INSTAPAY", "PESONET", "BPI", "UNIONBANK", "OTC_7ELEVEN"];
export const BILLERS: readonly Biller[] = ["MERALCO", "MAYNILAD", "GLOBE"];

export interface Persona {
  userId: string;
  mobile: string;
  displayName: string;
  tier: Tier;
  token: string;
  mpin: string;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------- loose-JSON readers (the boundary) ----------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
const num = (v: unknown, d = 0): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : d;
};
const obj = (v: unknown): Json => (isObj(v) ? v : {});
/** Accepts `[...]` or `{ <key>: [...] }`. */
const list = (v: unknown, key: string): Json[] => {
  const arr = Array.isArray(v) ? v : isObj(v) && Array.isArray(v[key]) ? (v[key] as unknown[]) : [];
  return arr.filter(isObj);
};
const tierOf = (v: unknown): Tier => (v === "FULLY_VERIFIED" ? "FULLY_VERIFIED" : "BASIC");
const statusOf = (v: unknown): TransferStatus => {
  const s = str(v).toUpperCase();
  return s === "COMPLETED" || s === "FAILED" || s === "REVERSED" ? s : "PENDING";
};

// ---------- transport ----------

interface ReqOpts {
  token?: string;
  body?: unknown;
  idempotencyKey?: string;
}

async function request(method: string, path: string, opts: ReqOpts = {}): Promise<{ data: unknown; res: Response }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    throw new ApiError("NETWORK_ERROR", 0, e instanceof Error ? e.message : "Network error");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = obj(data);
    throw new ApiError(str(e.error, `HTTP_${res.status}`), res.status, str(e.message, res.statusText || "Request failed"));
  }
  return { data, res };
}

const get = async (path: string, token?: string) => (await request("GET", path, { token })).data;
const post = async (path: string, body: unknown, token?: string) => (await request("POST", path, { token, body })).data;

// ---------- auth ----------

export interface AuthResult {
  token: string;
  userId: string;
  displayName: string;
  tier: Tier;
}

/** ASSUMPTION: the user id is in `user.id`, else the JWT `sub` claim. */
function jwtSub(token: string): string {
  try {
    const part = token.split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return str(obj(JSON.parse(json)).sub);
  } catch {
    return "";
  }
}

function normalizeAuth(data: unknown): AuthResult {
  const d = obj(data);
  const user = obj(d.user);
  const token = str(d.token) || str(d.access_token);
  return {
    token,
    userId: str(user.id) || str(user.user_id) || jwtSub(token),
    displayName: str(user.display_name),
    tier: tierOf(user.kyc_tier ?? user.tier),
  };
}

/** ASSUMPTION: register returns `dev_otp` at the top level. */
export async function register(mobile: string, displayName: string): Promise<{ devOtp: string }> {
  const d = obj(await post("/auth/register", { mobile, display_name: displayName }));
  return { devOtp: str(d.dev_otp) };
}

export async function verifyOtp(mobile: string, otp: string, mpin: string): Promise<AuthResult> {
  return normalizeAuth(await post("/auth/verify-otp", { mobile, otp, mpin }));
}

export async function login(mobile: string, mpin: string): Promise<AuthResult> {
  return normalizeAuth(await post("/auth/login", { mobile, mpin }));
}

// ---------- simulator ----------

export interface SimUser {
  id: string;
  mobile: string;
  displayName: string;
  tier: Tier;
  balanceCentavos: number;
  monthOutCentavos: number;
  monthLimitCentavos: number;
  locked: boolean;
  failedAttempts: number;
}

const TIER_LIMIT: Record<Tier, number> = { BASIC: 100_000_00, FULLY_VERIFIED: 500_000_00 };

/**
 * ASSUMPTION: GET /sim/users returns an array or `{users}`. Each row has id, mobile,
 * display_name, kyc_tier, balance_centavos, optional month_out_centavos / month_limit_centavos
 * (limit falls back to the tier table), and lock state as `locked` (bool) or `locked_at` (non-null).
 */
function normalizeSimUser(r: Json): SimUser {
  const tier = tierOf(r.kyc_tier ?? r.tier);
  return {
    id: str(r.id) || str(r.user_id),
    mobile: str(r.mobile),
    displayName: str(r.display_name),
    tier,
    balanceCentavos: num(r.balance_centavos ?? r.balance),
    monthOutCentavos: num(r.month_out_centavos),
    monthLimitCentavos: num(r.month_limit_centavos, TIER_LIMIT[tier]),
    locked: r.locked === true || r.is_locked === true || (r.locked_at !== null && r.locked_at !== undefined && r.locked_at !== false),
    failedAttempts: num(r.failed_mpin_attempts),
  };
}

export async function getSimUsers(): Promise<SimUser[]> {
  return list(await get("/sim/users"), "users").map(normalizeSimUser);
}
export async function unlockUser(id: string): Promise<void> {
  await post(`/sim/users/${encodeURIComponent(id)}/unlock`, {});
}
export async function setKyc(id: string, tier: Tier): Promise<void> {
  await post(`/sim/users/${encodeURIComponent(id)}/kyc`, { tier });
}

export interface Chaos {
  latencyMs: number;
  /** ASSUMPTION: fraction 0..1, as in the bank-rail contract. */
  failureRate: number;
}
const normalizeChaos = (d: unknown): Chaos => {
  const o = obj(d);
  return { latencyMs: num(o.latency_ms), failureRate: num(o.failure_rate) };
};
export async function getChaos(): Promise<Chaos> {
  return normalizeChaos(await get("/sim/chaos"));
}
export async function putChaos(c: Chaos): Promise<Chaos> {
  const { data } = await request("PUT", "/sim/chaos", { body: { latency_ms: c.latencyMs, failure_rate: c.failureRate } });
  const out = normalizeChaos(data);
  return data === null ? c : out;
}

export interface StatusStep {
  from: string | null;
  to: TransferStatus;
  reason: string;
  at: string;
}
export interface Transfer {
  id: string;
  type: string;
  status: TransferStatus;
  amountCentavos: number;
  userId: string;
  counterparty: string;
  failureReason: string;
  createdAt: string;
  history: StatusStep[];
  /** True when the gateway answered with `Idempotent-Replay: true`. */
  replayed: boolean;
}

/**
 * ASSUMPTION: transfer rows use the transfer table's column names. The counterparty jsonb is
 * shown via `name`, `display_name` or `mobile` when present. `status_history` rows are
 * `{from_status, to_status, reason, at}`; when absent the history is empty.
 */
function normalizeTransfer(r: Json, replayed = false): Transfer {
  const cp = r.counterparty;
  const cpo = obj(cp);
  return {
    id: str(r.id) || str(r.transfer_id),
    type: str(r.type),
    status: statusOf(r.status),
    amountCentavos: num(r.amount_centavos),
    userId: str(r.user_id),
    counterparty: isObj(cp) ? str(cpo.display_name) || str(cpo.name) || str(cpo.mobile) || str(cpo.bank) || str(cpo.biller) : str(cp),
    failureReason: str(r.failure_reason),
    createdAt: str(r.created_at),
    history: list(r.status_history ?? r.history, "history").map((h) => ({
      from: h.from_status === null || h.from_status === undefined ? null : str(h.from_status),
      to: statusOf(h.to_status ?? h.status),
      reason: str(h.reason),
      at: str(h.at ?? h.created_at),
    })),
    replayed,
  };
}

export async function getActivity(): Promise<Transfer[]> {
  return list(await get("/sim/activity"), "transfers").map((r) => normalizeTransfer(r));
}

export interface Receipt {
  id: string;
  channel: string;
  body: string;
  createdAt: string;
}
export async function getReceipts(userId: string): Promise<Receipt[]> {
  const d = await get(`/sim/receipts?user_id=${encodeURIComponent(userId)}`);
  return list(d, "receipts").map((r) => ({
    id: str(r.id),
    channel: str(r.channel),
    body: str(r.body),
    createdAt: str(r.created_at),
  }));
}

// ---------- system ----------

export interface Posting {
  account: string;
  direction: "DEBIT" | "CREDIT";
  amountCentavos: number;
}
export interface Journal {
  id: string;
  kind: string;
  createdAt: string;
  postings: Posting[];
}

/** ASSUMPTION: GET /system/journals is an array or `{journals}` of the ledger's `journal with postings` shape. */
export async function getJournals(): Promise<Journal[]> {
  return list(await get("/system/journals"), "journals").map((j) => ({
    id: str(j.journal_id) || str(j.id),
    kind: str(j.kind),
    createdAt: str(j.created_at),
    postings: list(j.postings, "postings").map((p) => ({
      account: str(p.account_code) || str(p.account),
      direction: str(p.direction).toUpperCase() === "DEBIT" ? "DEBIT" : "CREDIT",
      amountCentavos: num(p.amount_centavos),
    })),
  }));
}

export interface ServiceHealth {
  name: string;
  up: boolean;
  latencyMs: number | null;
}
/**
 * ASSUMPTION: GET /system/health returns one of: an array of entries, `{services: [...]}`, or
 * `{services: {name: entry}}` (or the bare name->entry map). An entry has `status`
 * ("up"|"ok"|"healthy" are up, anything else down) or boolean `ok`/`up`, and `latency_ms`.
 */
export async function getHealth(): Promise<ServiceHealth[]> {
  const d = await get("/system/health");
  const toEntry = (name: string, e: unknown): ServiceHealth => {
    const o = obj(e);
    const s = str(o.status).toLowerCase();
    const up = o.up === true || o.ok === true || s === "up" || s === "ok" || s === "healthy" || (typeof e === "string" && ["up", "ok", "healthy"].includes(e.toLowerCase()));
    const lat = o.latency_ms ?? o.latency;
    return { name, up, latencyMs: typeof lat === "number" ? lat : null };
  };
  const root = obj(d);
  const inner = root.services ?? root.checks ?? d;
  if (Array.isArray(inner)) return inner.filter(isObj).map((e) => toEntry(str(e.name) || str(e.service), e));
  return Object.entries(obj(inner)).map(([k, v]) => toEntry(k, v));
}

export interface Reconcile {
  balanced: boolean;
  totalDebits: number;
  totalCredits: number;
  unbalancedJournals: number;
  negativeWallets: number;
}
/** ASSUMPTION: the gateway passes the ledger's /reconcile body through unchanged. */
export async function getReconcile(): Promise<Reconcile> {
  const d = obj(await get("/system/reconcile"));
  const count = (v: unknown) => (Array.isArray(v) ? v.length : num(v));
  return {
    balanced: str(d.status) === "BALANCED",
    totalDebits: num(d.total_debits),
    totalCredits: num(d.total_credits),
    unbalancedJournals: count(d.unbalanced_journals),
    negativeWallets: count(d.negative_wallets),
  };
}

// ---------- money movement (JWT + Idempotency-Key) ----------

async function moneyPost(path: string, token: string, key: string, body: unknown): Promise<Transfer> {
  const { data, res } = await request("POST", path, { token, body, idempotencyKey: key });
  return normalizeTransfer(obj(data), res.headers.get("Idempotent-Replay") === "true");
}

export const sendP2p = (token: string, key: string, toMobile: string, amountCentavos: number, note?: string) =>
  moneyPost("/transfers/p2p", token, key, { to_mobile: toMobile, amount_centavos: amountCentavos, ...(note ? { note } : {}) });
export const cashIn = (token: string, key: string, bank: Bank, amountCentavos: number) =>
  moneyPost("/cash-in", token, key, { bank, amount_centavos: amountCentavos });
export const cashOut = (token: string, key: string, bank: Bank, amountCentavos: number) =>
  moneyPost("/cash-out", token, key, { bank, amount_centavos: amountCentavos });
export const payBill = (token: string, key: string, biller: Biller, accountNumber: string, amountCentavos: number) =>
  moneyPost("/bills", token, key, { biller, account_number: accountNumber, amount_centavos: amountCentavos });
export const payQr = (token: string, key: string, payload: string, amountCentavos?: number) =>
  moneyPost("/qr/pay", token, key, { payload, ...(amountCentavos ? { amount_centavos: amountCentavos } : {}) });

export interface QrCode {
  qrId: string;
  payload: string;
  amountCentavos: number | null;
}
export async function createQr(token: string, amountCentavos?: number): Promise<QrCode> {
  const d = obj(await post("/qr", amountCentavos ? { amount_centavos: amountCentavos } : {}, token));
  return { qrId: str(d.qr_id) || str(d.id), payload: str(d.payload), amountCentavos: amountCentavos ?? null };
}

export async function getTransfer(token: string, id: string): Promise<Transfer> {
  return normalizeTransfer(obj(await get(`/transfers/${encodeURIComponent(id)}`, token)));
}
