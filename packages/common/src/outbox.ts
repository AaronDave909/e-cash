import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Pool, Queryable } from "./db";
import { withTx } from "./db";
import { EVENT_STREAM, METRIC, type EventEnvelope, type EventType, type TransferEventPayload } from "./events";
import type { Metrics } from "./metrics";
import type { Redis } from "./redis";
import { injectCarrier, traceIdFromCarrier } from "./tracing";

export const OUTBOX_MIGRATION = `
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  event_id uuid UNIQUE NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  trace_carrier jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
`;

/** Call inside the same transaction as the state change. Captures the active trace for the consumer. */
export async function enqueueEvent(db: Queryable, type: EventType, payload: TransferEventPayload): Promise<void> {
  await db.query("INSERT INTO outbox (event_id, type, payload, trace_carrier) VALUES ($1, $2, $3, $4)", [
    randomUUID(),
    type,
    JSON.stringify(payload),
    JSON.stringify(injectCarrier()),
  ]);
}

interface OutboxRow {
  id: number;
  event_id: string;
  type: EventType;
  payload: TransferEventPayload;
  trace_carrier: Record<string, string>;
  created_at: Date;
}

export interface OutboxRelay {
  /** Publish now instead of waiting for the next tick. */
  poke(): void;
  stop(): Promise<void>;
}

/**
 * Publishes unpublished rows in id order with XADD, then marks them published.
 * A crash between the two steps republishes the row; consumers dedupe on event_id.
 */
export function startOutboxRelay(opts: {
  pool: Pool;
  redis: Redis;
  metrics: Metrics;
  log: FastifyBaseLogger;
  intervalMs?: number;
}): OutboxRelay {
  const { pool, redis, metrics, log } = opts;
  let stopped = false;
  let running = false;
  let again = false;

  const drain = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        let published = 0;
        do {
          published = await withTx(pool, async (c) => {
            const { rows } = await c.query<OutboxRow>(
              "SELECT id, event_id, type, payload, trace_carrier, created_at FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED",
            );
            for (const row of rows) {
              const envelope: EventEnvelope = {
                event_id: row.event_id,
                type: row.type,
                occurred_at: row.created_at.toISOString(),
                trace_id: traceIdFromCarrier(row.trace_carrier),
                trace_carrier: row.trace_carrier,
                payload: row.payload,
              };
              await redis.xadd(EVENT_STREAM, "*", "event", JSON.stringify(envelope));
              await c.query("UPDATE outbox SET published_at = now() WHERE id = $1", [row.id]);
              metrics.increment(METRIC.OUTBOX_PUBLISHED, { type: row.type });
            }
            return rows.length;
          });
        } while (published > 0 && !stopped);
      } while (again && !stopped);
    } catch (err) {
      log.error({ err }, "outbox relay failed; will retry");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void drain(), opts.intervalMs ?? 250);
  return {
    poke: () => void drain(),
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 20));
    },
  };
}

