import {
  METRIC,
  createMetrics,
  createPool,
  createService,
  databaseUrl,
  envInt,
  journalRequestSchema,
  migrate,
  parse,
  type Pool,
} from "@ecash/common";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { monthTotal, postJournal, type JournalView } from "./journal";
import { MIGRATIONS, SCHEMA } from "./migrations";
import { reconcile } from "./reconcile";

const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });
const monthTotalQuery = z.object({
  direction: z.enum(["DEBIT", "CREDIT"]),
  kinds: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",") : undefined)),
});
const balancesQuery = z.object({ prefix: z.string().default("wallet:") });

export async function buildApp(): Promise<{ app: FastifyInstance; pool: Pool }> {
  const pool = createPool(databaseUrl(), SCHEMA);
  await migrate(pool, SCHEMA, MIGRATIONS);
  const metrics = createMetrics("ecash-ledger");
  const app = createService({ name: "ecash-ledger", ready: async () => void (await pool.query("SELECT 1")) });

  app.post("/journals", async (req, reply) => {
    const input = parse(journalRequestSchema, req.body);
    const { created, journal } = await postJournal(pool, input);
    if (created) {
      metrics.increment(METRIC.LEDGER_JOURNALS, { kind: input.kind });
      req.log.info({ journal_id: journal.journal_id, kind: input.kind, key: input.idempotency_key }, "journal posted");
    } else {
      req.log.info({ journal_id: journal.journal_id, key: input.idempotency_key }, "journal replayed");
    }
    return reply.code(created ? 201 : 200).send(journal);
  });

  app.get<{ Params: { code: string } }>("/accounts/:code/balance", async (req) => {
    const { rows } = await pool.query<{ balance: number }>(
      `SELECT COALESCE(SUM(CASE WHEN p.direction = 'CREDIT' THEN p.amount_centavos ELSE -p.amount_centavos END), 0) AS balance
         FROM accounts a JOIN ledger_postings p ON p.account_id = a.id WHERE a.code = $1`,
      [req.params.code],
    );
    return { account_code: req.params.code, balance_centavos: rows[0]?.balance ?? 0 };
  });

  app.get<{ Params: { code: string } }>("/accounts/:code/month-total", async (req) => {
    const q = parse(monthTotalQuery, req.query);
    const acct = await pool.query<{ id: number }>("SELECT id FROM accounts WHERE code = $1", [req.params.code]);
    const id = acct.rows[0]?.id;
    const total = id === undefined ? 0 : await monthTotal(pool, id, q.direction, q.kinds);
    return { account_code: req.params.code, direction: q.direction, total_centavos: total };
  });

  app.get<{ Params: { code: string } }>("/accounts/:code/postings", async (req) => {
    const { limit } = parse(limitQuery, req.query);
    const { rows } = await pool.query(
      `SELECT p.id, p.journal_id, j.kind, p.direction, p.amount_centavos, p.created_at
         FROM ledger_postings p JOIN accounts a ON a.id = p.account_id JOIN journal_entries j ON j.id = p.journal_id
        WHERE a.code = $1 ORDER BY p.id DESC LIMIT $2`,
      [req.params.code, limit],
    );
    return { account_code: req.params.code, postings: rows };
  });

  app.get("/balances", async (req) => {
    const { prefix } = parse(balancesQuery, req.query);
    const { rows } = await pool.query<{ code: string; balance: number }>(
      `SELECT a.code, COALESCE(SUM(CASE WHEN p.direction = 'CREDIT' THEN p.amount_centavos ELSE -p.amount_centavos END), 0) AS balance
         FROM accounts a LEFT JOIN ledger_postings p ON p.account_id = a.id WHERE a.code LIKE $1 GROUP BY a.code`,
      [`${prefix.replace(/[%_\\]/g, "\\$&")}%`],
    );
    return { balances: Object.fromEntries(rows.map((r) => [r.code, r.balance])) };
  });

  app.get("/journals/recent", async (req) => {
    const { limit } = parse(limitQuery, req.query);
    const { rows } = await pool.query<{ id: string; kind: string; idempotency_key: string; metadata: unknown; created_at: Date; postings: JournalView["postings"] }>(
      `SELECT j.id, j.kind, j.idempotency_key, j.metadata, j.created_at,
              (SELECT json_agg(json_build_object('account_code', a.code, 'direction', p.direction, 'amount_centavos', p.amount_centavos) ORDER BY p.id)
                 FROM ledger_postings p JOIN accounts a ON a.id = p.account_id WHERE p.journal_id = j.id) AS postings
         FROM journal_entries j ORDER BY j.created_at DESC, j.idempotency_key LIMIT $1`,
      [limit],
    );
    return {
      journals: rows.map((r) => ({
        journal_id: r.id,
        kind: r.kind,
        idempotency_key: r.idempotency_key,
        metadata: r.metadata,
        created_at: r.created_at.toISOString(),
        postings: r.postings,
      })),
    };
  });

  const runReconcile = async (log: FastifyInstance["log"]) => {
    const report = await reconcile(pool);
    if (report.status !== "BALANCED") {
      const errors = report.unbalanced_journals.length + report.negative_wallets.length + (report.total_debits === report.total_credits ? 0 : 1);
      for (let i = 0; i < Math.max(1, errors); i++) metrics.increment(METRIC.LEDGER_INVARIANT_ERRORS);
      log.error({ report }, "ledger invariant violated");
    }
    return report;
  };

  app.get("/reconcile", async (req) => runReconcile(req.log));

  const timer = setInterval(() => void runReconcile(app.log).catch((err) => app.log.error({ err }, "reconcile loop failed")), envInt("RECONCILE_INTERVAL_MS", 30_000));
  app.addHook("onClose", async () => {
    clearInterval(timer);
    metrics.close();
    await pool.end();
  });

  return { app, pool };
}
