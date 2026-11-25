import {
  createMetrics,
  createPool,
  createRedis,
  createService,
  databaseUrl,
  envInt,
  migrate,
  parse,
  redisUrl,
  serviceUrls,
} from "@ecash/common";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { startConsumer } from "./consumer";
import { MIGRATIONS, SCHEMA } from "./migrations";

const receiptsQuery = z.object({ user_id: z.string().uuid(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

export async function buildApp(): Promise<FastifyInstance> {
  const pool = createPool(databaseUrl(), SCHEMA);
  await migrate(pool, SCHEMA, MIGRATIONS);
  const redis = createRedis(redisUrl(), "ecash-worker");
  const blockingRedis = createRedis(redisUrl(), "ecash-worker-blocking");
  const metrics = createMetrics("ecash-worker");
  const app = createService({ name: "ecash-worker", ready: async () => void (await pool.query("SELECT 1")) });

  const consumer = startConsumer({
    pool,
    redis,
    blockingRedis,
    metrics,
    log: app.log,
    transferUrl: serviceUrls().transfer,
    claimIdleMs: envInt("WORKER_CLAIM_IDLE_MS", 30_000),
  });

  app.get("/receipts", async (req) => {
    const q = parse(receiptsQuery, req.query);
    const { rows } = await pool.query(
      "SELECT id, transfer_id, user_id, channel, body, created_at FROM receipts WHERE user_id = $1 ORDER BY id DESC LIMIT $2",
      [q.user_id, q.limit],
    );
    return { receipts: rows };
  });

  app.get("/audit", async (req) => {
    const q = parse(auditQuery, req.query);
    const { rows } = await pool.query("SELECT id, event_id, type, payload, created_at FROM audit_log ORDER BY id DESC LIMIT $1", [q.limit]);
    return { events: rows };
  });

  app.addHook("onClose", async () => {
    await consumer.stop();
    metrics.close();
    redis.disconnect();
    await pool.end();
  });
  return app;
}
