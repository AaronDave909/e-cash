import {
  EVENT_STREAM,
  METRIC,
  callJson,
  eventEnvelopeSchema,
  withExtractedSpan,
  withTx,
  type EventEnvelope,
  type Metrics,
  type Pool,
  type Redis,
} from "@ecash/common";
import type { FastifyBaseLogger } from "fastify";
import { draftReceipts } from "./receipts";

const GROUP = "worker";
const CHANNELS = ["SMS", "IN_APP"] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type StreamEntry = [id: string, fields: string[]];

export interface Consumer {
  stop(): Promise<void>;
}

export function startConsumer(opts: {
  pool: Pool;
  redis: Redis;
  /** Dedicated connection: XREADGROUP BLOCK would stall commands sharing it. */
  blockingRedis: Redis;
  metrics: Metrics;
  log: FastifyBaseLogger;
  transferUrl: string;
  claimIdleMs: number;
}): Consumer {
  const { pool, redis, blockingRedis, metrics, log } = opts;
  const consumerName = `worker-${process.pid}`;
  let stopped = false;
  const inflight = new Set<Promise<void>>();

  async function simulateBiller(ev: EventEnvelope): Promise<void> {
    const account = String(ev.payload.counterparty?.["account_number"] ?? "");
    await sleep(300 + Math.random() * 1200);
    const success = !account.endsWith("0000");
    const res = await callJson(`${opts.transferUrl}/internal/bills/${ev.payload.transfer_id}/result`, {
      body: success ? { success } : { success, reason: "BILLER_REJECTED_ACCOUNT" },
      timeoutMs: 10_000,
    });
    if (res.status >= 300) throw new Error(`transfer service answered ${res.status} to bill result`);
    log.info({ transfer_id: ev.payload.transfer_id, success }, "biller result reported");
  }

  async function record(ev: EventEnvelope): Promise<void> {
    await withTx(pool, async (c) => {
      const first = await c.query("INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING", [ev.event_id]);
      if (first.rowCount === 0) return;
      await c.query("INSERT INTO audit_log (event_id, type, payload) VALUES ($1, $2, $3)", [ev.event_id, ev.type, JSON.stringify(ev)]);
      for (const r of draftReceipts(ev)) {
        for (const channel of CHANNELS) {
          await c.query(
            "INSERT INTO receipts (event_id, transfer_id, user_id, channel, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
            [ev.event_id, ev.payload.transfer_id, r.user_id, channel, r.body],
          );
        }
      }
    });
  }

  async function handle(id: string, fields: string[]): Promise<void> {
    const raw = fields[fields.indexOf("event") + 1];
    const parsed = raw ? eventEnvelopeSchema.safeParse(JSON.parse(raw)) : null;
    if (!parsed?.success) {
      log.error({ stream_id: id }, "dropping malformed event");
      await redis.xack(EVENT_STREAM, GROUP, id);
      return;
    }
    const ev = parsed.data;
    await withExtractedSpan("worker.process_event", ev.trace_carrier, { "event.type": ev.type, "event.id": ev.event_id }, async () => {
      const seen = await pool.query("SELECT 1 FROM processed_events WHERE event_id = $1", [ev.event_id]);
      if (seen.rowCount === 0) {
        // Report the biller result before recording the event, so a crash in between re-runs it (the result call is idempotent).
        if (ev.type === "transfer.created" && ev.payload.type === "bills") await simulateBiller(ev);
        await record(ev);
        metrics.increment(METRIC.WORKER_EVENTS, { type: ev.type });
        log.info({ event_id: ev.event_id, event_type: ev.type, transfer_id: ev.payload.transfer_id, trace_id: ev.trace_id }, "event processed");
      } else {
        log.info({ event_id: ev.event_id, event_type: ev.type }, "duplicate event skipped");
      }
    });
    await redis.xack(EVENT_STREAM, GROUP, id);
  }

  const track = (id: string, fields: string[]): void => {
    const p = handle(id, fields)
      .catch((err) => log.error({ err, stream_id: id }, "event handling failed; it stays pending for redelivery"))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };

  async function readLoop(): Promise<void> {
    try {
      await blockingRedis.xgroup("CREATE", EVENT_STREAM, GROUP, "0", "MKSTREAM");
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
    while (!stopped) {
      try {
        if (inflight.size >= 100) {
          await sleep(50);
          continue;
        }
        const res = (await blockingRedis.xreadgroup("GROUP", GROUP, consumerName, "COUNT", 20, "BLOCK", 1000, "STREAMS", EVENT_STREAM, ">")) as
          | [string, StreamEntry[]][]
          | null;
        for (const [, entries] of res ?? []) for (const [id, fields] of entries) track(id, fields);
      } catch (err) {
        if (stopped) return;
        log.error({ err }, "stream read failed; retrying");
        await sleep(1000);
      }
    }
  }

  async function claimLoop(): Promise<void> {
    while (!stopped) {
      await sleep(Math.min(opts.claimIdleMs, 5000));
      try {
        const res = (await redis.xautoclaim(EVENT_STREAM, GROUP, consumerName, opts.claimIdleMs, "0-0", "COUNT", 20)) as [string, StreamEntry[], ...unknown[]];
        for (const [id, fields] of res[1] ?? []) if (fields) track(id, fields);
      } catch (err) {
        if (!String(err).includes("NOGROUP")) log.error({ err }, "autoclaim failed");
      }
    }
  }

  const loops = [readLoop(), claimLoop()];
  return {
    stop: async () => {
      stopped = true;
      blockingRedis.disconnect();
      await Promise.allSettled([...loops, ...inflight]);
    },
  };
}
