import { callJson, envInt, signWebhook, SIGNATURE_HEADER, withTx, type Pool, type RailWebhookBody, type Redis } from "@ecash/common";
import type { FastifyBaseLogger } from "fastify";
import { readChaos } from "./chaos";

interface RailRow {
  reference: string;
  direction: "cash_in" | "cash_out";
  bank: string;
  amount_centavos: number;
  callback_url: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  failure_reason: string | null;
  settled_at: Date | null;
  delivery_attempts: number;
}

const backoffMs = (attempts: number): number => Math.min(30_000, 200 * 2 ** attempts);

/**
 * Two steps on a short tick: settle rows whose random delay has elapsed, then deliver signed webhooks
 * for settled rows until the receiver answers 2xx. Delivery state lives in the row, so a restart resumes it.
 */
export function startSettlementLoop(opts: { pool: Pool; redis: Redis; log: FastifyBaseLogger; webhookSecret: string }): { stop(): Promise<void> } {
  const { pool, redis, log } = opts;
  let running = false;
  let stopped = false;

  async function settleDue(): Promise<void> {
    await withTx(pool, async (c) => {
      const { rows } = await c.query<RailRow>(
        "SELECT * FROM rail_transfers WHERE status = 'PENDING' AND settle_after <= now() ORDER BY settle_after LIMIT 100 FOR UPDATE SKIP LOCKED",
      );
      if (rows.length === 0) return;
      const chaos = await readChaos(redis);
      for (const r of rows) {
        const failed = Math.random() < chaos.failure_rate;
        await c.query(
          "UPDATE rail_transfers SET status = $2, failure_reason = $3, settled_at = now(), next_delivery_at = now() WHERE reference = $1",
          [r.reference, failed ? "FAILED" : "COMPLETED", failed ? "BANK_DECLINED" : null],
        );
        log.info({ reference: r.reference, outcome: failed ? "FAILED" : "COMPLETED" }, "rail settled");
      }
    });
  }

  async function deliverDue(): Promise<void> {
    // Lease the rows by pushing next_delivery_at out, then deliver without holding a transaction open.
    const due = await withTx(pool, async (c) => {
      const { rows } = await c.query<RailRow>(
        `SELECT * FROM rail_transfers WHERE status <> 'PENDING' AND delivered_at IS NULL AND next_delivery_at <= now()
          ORDER BY next_delivery_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
      );
      if (rows.length > 0) {
        await c.query("UPDATE rail_transfers SET next_delivery_at = now() + interval '10 seconds' WHERE reference = ANY($1)", [rows.map((r) => r.reference)]);
      }
      return rows;
    });
    await Promise.all(
      due.map(async (r) => {
        const body: RailWebhookBody = {
          reference: r.reference,
          direction: r.direction,
          bank: r.bank,
          amount_centavos: r.amount_centavos,
          status: r.status as "COMPLETED" | "FAILED",
          ...(r.failure_reason ? { failure_reason: r.failure_reason } : {}),
          settled_at: (r.settled_at ?? new Date()).toISOString(),
        };
        const raw = JSON.stringify(body);
        let code: number | null = null;
        try {
          const res = await callJson(r.callback_url, {
            method: "POST",
            rawBody: raw,
            headers: { [SIGNATURE_HEADER]: signWebhook(opts.webhookSecret, raw) },
            timeoutMs: 3000,
          });
          code = res.status;
        } catch (err) {
          log.warn({ reference: r.reference, err: (err as Error).message }, "webhook delivery failed");
        }
        const ok = code !== null && code >= 200 && code < 300;
        const attempt = r.delivery_attempts + 1;
        await pool.query("INSERT INTO webhook_deliveries (reference, attempt, status_code) VALUES ($1, $2, $3)", [r.reference, attempt, code]);
        await pool.query(
          `UPDATE rail_transfers SET delivery_attempts = $2, delivered_at = CASE WHEN $3 THEN now() END,
                  next_delivery_at = CASE WHEN $3 THEN NULL ELSE now() + make_interval(secs => $4) END WHERE reference = $1`,
          [r.reference, attempt, ok, backoffMs(attempt) / 1000],
        );
        log.info({ reference: r.reference, attempt, status_code: code }, ok ? "webhook delivered" : "webhook will be retried");
      }),
    );
  }

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await settleDue();
      await deliverDue();
    } catch (err) {
      log.error({ err }, "settlement loop failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), envInt("RAIL_TICK_MS", 100));
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 20));
    },
  };
}
