import {
  AppError,
  amountCentavosSchema,
  bankSchema,
  createPool,
  createRedis,
  createService,
  databaseUrl,
  envInt,
  envStr,
  migrate,
  parse,
  redisUrl,
} from "@ecash/common";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { chaosSchema, readChaos, writeChaos } from "./chaos";
import { MIGRATIONS, SCHEMA } from "./migrations";
import { startSettlementLoop } from "./settlement";

const railBody = z.object({
  reference: z.string().min(1).max(100),
  direction: z.enum(["cash_in", "cash_out"]),
  bank: bankSchema,
  amount_centavos: amountCentavosSchema,
  callback_url: z.string().url(),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function buildApp(): Promise<FastifyInstance> {
  const pool = createPool(databaseUrl(), SCHEMA);
  await migrate(pool, SCHEMA, MIGRATIONS);
  const redis = createRedis(redisUrl(), "ecash-bank-rail");
  const app = createService({ name: "ecash-bank-rail", ready: async () => void (await pool.query("SELECT 1")) });
  const minMs = envInt("RAIL_SETTLE_MIN_MS", 1500);
  const maxMs = Math.max(minMs, envInt("RAIL_SETTLE_MAX_MS", 4000));

  app.post("/rail/transfers", async (req, reply) => {
    const body = parse(railBody, req.body);
    const chaos = await readChaos(redis);
    if (chaos.latency_ms > 0) await sleep(chaos.latency_ms);
    const delay = minMs + Math.random() * (maxMs - minMs);
    // Idempotent on reference: a resend returns the existing record untouched.
    await pool.query(
      `INSERT INTO rail_transfers (reference, direction, bank, amount_centavos, callback_url, settle_after)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) ON CONFLICT (reference) DO NOTHING`,
      [body.reference, body.direction, body.bank, body.amount_centavos, body.callback_url, delay / 1000],
    );
    const row = (await pool.query<{ reference: string; status: string }>("SELECT reference, status FROM rail_transfers WHERE reference = $1", [body.reference])).rows[0]!;
    req.log.info({ reference: row.reference, status: row.status, direction: body.direction }, "rail transfer accepted");
    return reply.code(202).send({ reference: row.reference, status: row.status });
  });

  app.get<{ Params: { reference: string } }>("/rail/transfers/:reference", async (req) => {
    const { rows } = await pool.query(
      `SELECT reference, direction, bank, amount_centavos, status, failure_reason, created_at, settled_at, delivered_at, delivery_attempts
         FROM rail_transfers WHERE reference = $1`,
      [req.params.reference],
    );
    if (!rows[0]) throw new AppError("NOT_FOUND", "no such rail transfer");
    return rows[0];
  });

  app.get("/rail/chaos", async () => readChaos(redis));
  app.put("/rail/chaos", async (req) => {
    const chaos = { ...(await readChaos(redis)), ...parse(chaosSchema.partial(), req.body) };
    await writeChaos(redis, chaos);
    req.log.warn({ chaos }, "bank rail chaos updated");
    return chaos;
  });

  const loop = startSettlementLoop({ pool, redis, log: app.log, webhookSecret: envStr("RAIL_WEBHOOK_SECRET") });
  app.addHook("onClose", async () => {
    await loop.stop();
    redis.disconnect();
    await pool.end();
  });
  return app;
}
