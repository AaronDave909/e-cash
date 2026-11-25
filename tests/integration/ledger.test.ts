import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, inject, it } from "vitest";

const { ledger, databaseUrl } = inject("stack");

interface Posting {
  account_code: string;
  direction: "DEBIT" | "CREDIT";
  amount_centavos: number;
}

async function post(body: object): Promise<{ status: number; body: any }> {
  const r = await fetch(`${ledger}/journals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

const move = (from: string, to: string, amount: number, key = randomUUID()) => ({
  idempotency_key: key,
  kind: "p2p.post",
  postings: [
    { account_code: from, direction: "DEBIT", amount_centavos: amount },
    { account_code: to, direction: "CREDIT", amount_centavos: amount },
  ] satisfies Posting[],
});

const fund = (wallet: string, amount: number) => post(move("system:bank_clearing:BPI", wallet, amount));
const balance = async (code: string): Promise<number> =>
  ((await (await fetch(`${ledger}/accounts/${encodeURIComponent(code)}/balance`)).json()) as any).balance_centavos;

describe("ledger contract", () => {
  it("replays the same key with 200 and rejects a changed request with 409", async () => {
    const w = `wallet:${randomUUID()}`;
    const req = move("system:bank_clearing:BPI", w, 5_000);
    const first = await post(req);
    const second = await post(req);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.journal_id).toBe(first.body.journal_id);
    expect(await balance(w)).toBe(5_000);
    const changed = await post({ ...req, postings: move("system:bank_clearing:BPI", w, 1).postings });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects unbalanced journals and overdrafts", async () => {
    const w = `wallet:${randomUUID()}`;
    await fund(w, 1_000);
    const unbalanced = await post({ ...move(w, `wallet:${randomUUID()}`, 10), postings: [
      { account_code: w, direction: "DEBIT", amount_centavos: 10 },
      { account_code: `wallet:${randomUUID()}`, direction: "CREDIT", amount_centavos: 11 },
    ] });
    expect(unbalanced.status).toBe(422);
    expect(unbalanced.body.error).toBe("UNBALANCED");
    const over = await post(move(w, `wallet:${randomUUID()}`, 1_001));
    expect(over.status).toBe(422);
    expect(over.body.error).toBe("INSUFFICIENT_FUNDS");
    expect(await balance(w)).toBe(1_000);
  });

  it("lets exactly balance/amount concurrent debits through", async () => {
    const w = `wallet:${randomUUID()}`;
    await fund(w, 100_000);
    const results = await Promise.all(Array.from({ length: 20 }, () => post(move(w, `wallet:${randomUUID()}`, 10_000))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422 && r.body.error === "INSUFFICIENT_FUNDS")).toHaveLength(10);
    expect(await balance(w)).toBe(0);
  });

  it("returns one journal for concurrent requests sharing a key", async () => {
    const w = `wallet:${randomUUID()}`;
    await fund(w, 10_000);
    const req = move(w, `wallet:${randomUUID()}`, 1_000);
    const results = await Promise.all(Array.from({ length: 8 }, () => post(req)));
    expect(new Set(results.map((r) => r.body.journal_id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await balance(w)).toBe(9_000);
  });

  it("enforces month limits under the same lock and honors the kinds filter", async () => {
    const w = `wallet:${randomUUID()}`;
    await fund(w, 10_000);
    const limited = (amount: number) => ({
      ...move(w, `wallet:${randomUUID()}`, amount),
      limits: [{ account_code: w, direction: "DEBIT", max_month_centavos: 3_000, kinds: ["p2p.post"] }],
    });
    const results = await Promise.all(Array.from({ length: 6 }, () => post(limited(1_000))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.body.error === "LIMIT_EXCEEDED")).toHaveLength(3);
  });

  it("stays balanced under opposing concurrent transfers and refuses to mutate history", async () => {
    const a = `wallet:${randomUUID()}`;
    const b = `wallet:${randomUUID()}`;
    await fund(a, 50_000);
    await fund(b, 50_000);
    const jobs = Array.from({ length: 40 }, (_, i) => post(i % 2 === 0 ? move(a, b, 7_000) : move(b, a, 6_000)));
    await Promise.all(jobs);
    expect((await balance(a)) + (await balance(b))).toBe(100_000);
    const report: any = await (await fetch(`${ledger}/reconcile`)).json();
    expect(report.status).toBe("BALANCED");

    const c = new pg.Client({ connectionString: databaseUrl });
    await c.connect();
    try {
      await expect(c.query("UPDATE ledger.ledger_postings SET amount_centavos = 1")).rejects.toThrow(/append-only/);
      await expect(c.query("DELETE FROM ledger.journal_entries")).rejects.toThrow(/append-only/);
    } finally {
      await c.end();
    }
  });
});
