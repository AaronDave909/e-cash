import { SETTLER, envInt } from "@ecash/common";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "@ecash/common";
import type { Clients } from "./clients";
import type { Engine, TransferRow } from "./engine";

/**
 * Converges PENDING transfers after crashes and timeouts. Every step it takes is idempotent
 * (same journal keys, same rail reference), so running it twice or alongside a webhook is safe.
 */
export function startReconciler(opts: { pool: Pool; engine: Engine; clients: Clients; log: FastifyBaseLogger }): { stop(): Promise<void> } {
  const intervalMs = envInt("RECONCILER_INTERVAL_MS", 5000);
  const minAgeMs = envInt("RECONCILER_MIN_AGE_MS", 5000);
  const deadlineMs = envInt("PENDING_DEADLINE_MS", 120_000);
  let running = false;
  let stopped = false;

  const pastDeadline = (t: TransferRow): boolean => Date.now() - t.created_at.getTime() > deadlineMs;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const { rows } = await opts.pool.query<TransferRow>(
        "SELECT * FROM transfers WHERE status = 'PENDING' AND created_at < now() - make_interval(secs => $1) ORDER BY created_at LIMIT 50",
        [minAgeMs / 1000],
      );
      for (const t of rows) {
        try {
          const settler = SETTLER[t.type];
          if (settler === "rail" && pastDeadline(t) && (await opts.clients.railLookup(t.id)) === "MISSING") {
            await opts.engine.apply(t.id, { kind: "fail", reason: "PENDING_DEADLINE" });
          } else if (settler === "biller" && pastDeadline(t)) {
            await opts.engine.apply(t.id, { kind: "fail", reason: "PENDING_DEADLINE" });
          } else {
            await opts.engine.drive(t);
          }
        } catch (err) {
          opts.log.warn({ err, transfer_id: t.id }, "reconciler step failed; will retry");
        }
      }
    } catch (err) {
      opts.log.error({ err }, "reconciler tick failed");
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((r) => setTimeout(r, 20));
    },
  };
}
