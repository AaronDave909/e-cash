import {
  createMetrics,
  createPool,
  createRedis,
  createService,
  databaseUrl,
  envInt,
  envStr,
  migrate,
  redisUrl,
  serviceUrls,
  startOutboxRelay,
} from "@ecash/common";
import type { FastifyInstance } from "fastify";
import { createClients } from "./clients";
import { createEngine } from "./engine";
import { MIGRATIONS, SCHEMA } from "./migrations";
import { startReconciler } from "./reconciler";
import { registerRoutes } from "./routes";

export async function buildApp(): Promise<FastifyInstance> {
  const pool = createPool(databaseUrl(), SCHEMA);
  await migrate(pool, SCHEMA, MIGRATIONS);
  const redis = createRedis(redisUrl(), "ecash-transfer");
  const metrics = createMetrics("ecash-transfer");
  const urls = serviceUrls();
  const app = createService({ name: "ecash-transfer", ready: async () => void (await pool.query("SELECT 1")) });

  const relay = startOutboxRelay({ pool, redis, metrics, log: app.log });
  const clients = createClients(urls);
  const port = envInt("PORT", 8083);
  const engine = createEngine({
    pool,
    clients,
    metrics,
    relay,
    log: app.log,
    railCallbackUrl: envStr("RAIL_CALLBACK_URL", `http://127.0.0.1:${port}/webhooks/bank-rail`),
  });
  const reconciler = startReconciler({ pool, engine, log: app.log });

  registerRoutes({
    app,
    pool,
    engine,
    clients,
    metrics,
    qrSecret: envStr("QR_SECRET"),
    railWebhookSecret: envStr("RAIL_WEBHOOK_SECRET"),
  });

  app.addHook("onClose", async () => {
    await reconciler.stop();
    await relay.stop();
    metrics.close();
    redis.disconnect();
    await pool.end();
  });
  return app;
}
