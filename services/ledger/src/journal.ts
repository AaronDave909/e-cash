import { randomUUID } from "node:crypto";
import {
  AppError,
  canonicalJson,
  isDeadlock,
  isUniqueViolation,
  journalRequestSchema,
  sha256Hex,
  withTx,
  type Client,
  type Pool,
} from "@ecash/common";
import type { z } from "zod";

type JournalInput = z.output<typeof journalRequestSchema>;

export interface PostingView {
  account_code: string;
  direction: "DEBIT" | "CREDIT";
  amount_centavos: number;
}

export interface JournalView {
  journal_id: string;
  kind?: string;
  postings: PostingView[];
  balances: Record<string, number>;
}

export interface PostResult {
  created: boolean;
  journal: JournalView;
}

const MONTH_START_SQL = `(date_trunc('month', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila')`;

export function accountKind(code: string): "USER_WALLET" | "SYSTEM" {
  if (code.startsWith("wallet:")) return "USER_WALLET";
  if (code.startsWith("system:")) return "SYSTEM";
  throw new AppError("VALIDATION_ERROR", `account code must start with wallet: or system: (${code})`);
}

const sign = (d: "DEBIT" | "CREDIT", n: number): number => (d === "CREDIT" ? n : -n);

export async function postJournal(pool: Pool, input: JournalInput): Promise<PostResult> {
  const debits = input.postings.filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amount_centavos, 0);
  const credits = input.postings.filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amount_centavos, 0);
  if (debits !== credits) throw new AppError("UNBALANCED", `debits ${debits} do not equal credits ${credits}`);
  for (const p of input.postings) accountKind(p.account_code);

  // A journal is its effect: kind, metadata and postings. `limits` is a precondition checked on the first
  // post only, so a replay under another tier (a KYC change, or a release after the hold) returns the journal.
  const effect = journalEffect(input.kind, input.metadata, input.postings);
  const requestHash = sha256Hex(effect);

  for (let attempt = 0; ; attempt++) {
    try {
      return await withTx(pool, (c) => postInTx(c, input, effect, requestHash));
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Another request with the same key committed first: return its journal.
        const existing = await withTx(pool, (c) => readByKey(c, input.idempotency_key, effect));
        if (existing) return existing;
      }
      if (isDeadlock(err) && attempt < 3) continue;
      throw err;
    }
  }
}

const journalEffect = (kind: string, metadata: unknown, postings: readonly PostingView[]): string =>
  canonicalJson({
    kind,
    metadata,
    postings: postings.map((p) => ({ account_code: p.account_code, direction: p.direction, amount_centavos: p.amount_centavos })),
  });

/** The stored journal for `key`, compared by effect rather than stored hash, so rows posted under an older hash still replay. */
async function readByKey(c: Client, key: string, effect: string): Promise<PostResult | null> {
  const { rows } = await c.query<{ id: string; balances: Record<string, number>; kind: string; metadata: unknown }>(
    "SELECT id, balances, kind, metadata FROM journal_entries WHERE idempotency_key = $1",
    [key],
  );
  const row = rows[0];
  if (!row) return null;
  const postings = await c.query<PostingView>(
    `SELECT a.code AS account_code, p.direction, p.amount_centavos
       FROM ledger_postings p JOIN accounts a ON a.id = p.account_id WHERE p.journal_id = $1 ORDER BY p.id`,
    [row.id],
  );
  if (journalEffect(row.kind, row.metadata, postings.rows) !== effect) {
    throw new AppError("IDEMPOTENCY_CONFLICT", "idempotency key was already used with a different request");
  }
  return {
    created: false,
    journal: { journal_id: row.id, kind: row.kind, postings: postings.rows, balances: row.balances },
  };
}

async function postInTx(c: Client, input: JournalInput, effect: string, requestHash: string): Promise<PostResult> {
  const replay = await readByKey(c, input.idempotency_key, effect);
  if (replay) return replay;

  const codes = [...new Set([...input.postings.map((p) => p.account_code), ...(input.limits ?? []).map((l) => l.account_code)])].sort();

  // Create missing accounts in sorted order so concurrent creators cannot deadlock each other.
  const known = await c.query<{ code: string }>("SELECT code FROM accounts WHERE code = ANY($1)", [codes]);
  const knownSet = new Set(known.rows.map((r) => r.code));
  const missing = codes.filter((code) => !knownSet.has(code));
  if (missing.length > 0) {
    await c.query("INSERT INTO accounts (code, kind) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (code) DO NOTHING", [
      missing,
      missing.map(accountKind),
    ]);
  }

  // Fixed lock order (by id) prevents deadlocks; holding the locks makes balance-check-then-insert atomic.
  const locked = await c.query<{ id: number; code: string; kind: "USER_WALLET" | "SYSTEM" }>(
    "SELECT id, code, kind FROM accounts WHERE code = ANY($1) ORDER BY id FOR UPDATE",
    [codes],
  );
  const accounts = new Map(locked.rows.map((r) => [r.code, r]));

  // A twin request may have committed while we waited for the locks.
  const twin = await readByKey(c, input.idempotency_key, effect);
  if (twin) return twin;

  const ids = locked.rows.map((r) => r.id);
  const balRows = await c.query<{ account_id: number; balance: number }>(
    `SELECT account_id, COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_centavos ELSE -amount_centavos END), 0) AS balance
       FROM ledger_postings WHERE account_id = ANY($1) GROUP BY account_id`,
    [ids],
  );
  const before = new Map(balRows.rows.map((r) => [r.account_id, r.balance]));

  const net = new Map<string, number>();
  for (const p of input.postings) net.set(p.account_code, (net.get(p.account_code) ?? 0) + sign(p.direction, p.amount_centavos));

  const balances: Record<string, number> = {};
  for (const code of codes) {
    const acct = accounts.get(code)!;
    const after = (before.get(acct.id) ?? 0) + (net.get(code) ?? 0);
    balances[code] = after;
    if (acct.kind === "USER_WALLET" && (net.get(code) ?? 0) < 0 && after < 0) {
      throw new AppError("INSUFFICIENT_FUNDS", "wallet balance is too low for this debit", {
        account_code: code,
        balance_centavos: after - (net.get(code) ?? 0),
      });
    }
  }

  for (const limit of input.limits ?? []) {
    const acct = accounts.get(limit.account_code)!;
    const adding = input.postings
      .filter((p) => p.account_code === limit.account_code && p.direction === limit.direction)
      .reduce((s, p) => s + p.amount_centavos, 0);
    const used = await monthTotal(c, acct.id, limit.direction, limit.kinds);
    if (used + adding > limit.max_month_centavos) {
      throw new AppError("LIMIT_EXCEEDED", "monthly limit would be exceeded", {
        account_code: limit.account_code,
        month_total_centavos: used,
        max_month_centavos: limit.max_month_centavos,
      });
    }
  }

  const journalId = randomUUID();
  await c.query(
    "INSERT INTO journal_entries (id, idempotency_key, request_hash, kind, metadata, balances) VALUES ($1, $2, $3, $4, $5, $6)",
    [journalId, input.idempotency_key, requestHash, input.kind, JSON.stringify(input.metadata), JSON.stringify(balances)],
  );
  await c.query(
    `INSERT INTO ledger_postings (journal_id, account_id, direction, amount_centavos)
     SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::bigint[])`,
    [
      journalId,
      input.postings.map((p) => accounts.get(p.account_code)!.id),
      input.postings.map((p) => p.direction),
      input.postings.map((p) => p.amount_centavos),
    ],
  );

  return {
    created: true,
    journal: { journal_id: journalId, kind: input.kind, postings: input.postings.map((p) => ({ ...p })), balances },
  };
}

export async function monthTotal(
  db: Pick<Client, "query">,
  accountId: number,
  direction: "DEBIT" | "CREDIT",
  kinds?: string[],
): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    `SELECT COALESCE(SUM(p.amount_centavos), 0) AS total
       FROM ledger_postings p JOIN journal_entries j ON j.id = p.journal_id
      WHERE p.account_id = $1 AND p.direction = $2 AND p.created_at >= ${MONTH_START_SQL}
        AND ($3::text[] IS NULL OR j.kind = ANY($3))`,
    [accountId, direction, kinds ?? null],
  );
  return rows[0]?.total ?? 0;
}
