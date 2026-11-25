import { withTx, type Pool } from "@ecash/common";

export interface ReconcileReport {
  status: "BALANCED" | "IMBALANCE_DETECTED";
  total_debits: number;
  total_credits: number;
  unbalanced_journals: { journal_id: string; difference_centavos: number }[];
  negative_wallets: { account_code: string; balance_centavos: number }[];
  checked_at: string;
}

/** Reads everything from one snapshot so a journal committing mid-check cannot look like an imbalance. */
export async function reconcile(pool: Pool): Promise<ReconcileReport> {
  return withTx(pool, async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const totals = await c.query<{ d: number; c: number }>(
      `SELECT COALESCE(SUM(amount_centavos) FILTER (WHERE direction = 'DEBIT'), 0) AS d,
              COALESCE(SUM(amount_centavos) FILTER (WHERE direction = 'CREDIT'), 0) AS c
         FROM ledger_postings`,
    );
    const unbalanced = await c.query<{ journal_id: string; diff: number }>(
      `SELECT journal_id, SUM(CASE WHEN direction = 'DEBIT' THEN amount_centavos ELSE -amount_centavos END) AS diff
         FROM ledger_postings GROUP BY journal_id
       HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount_centavos ELSE -amount_centavos END) <> 0`,
    );
    const negative = await c.query<{ code: string; balance: number }>(
      `SELECT a.code, SUM(CASE WHEN p.direction = 'CREDIT' THEN p.amount_centavos ELSE -p.amount_centavos END) AS balance
         FROM accounts a JOIN ledger_postings p ON p.account_id = a.id
        WHERE a.kind = 'USER_WALLET' GROUP BY a.code
       HAVING SUM(CASE WHEN p.direction = 'CREDIT' THEN p.amount_centavos ELSE -p.amount_centavos END) < 0`,
    );
    const total_debits = totals.rows[0]?.d ?? 0;
    const total_credits = totals.rows[0]?.c ?? 0;
    const ok = total_debits === total_credits && unbalanced.rows.length === 0 && negative.rows.length === 0;
    return {
      status: ok ? "BALANCED" : "IMBALANCE_DETECTED",
      total_debits,
      total_credits,
      unbalanced_journals: unbalanced.rows.map((r) => ({ journal_id: r.journal_id, difference_centavos: r.diff })),
      negative_wallets: negative.rows.map((r) => ({ account_code: r.code, balance_centavos: r.balance })),
      checked_at: new Date().toISOString(),
    };
  });
}
