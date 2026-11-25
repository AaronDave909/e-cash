import { randomUUID } from "node:crypto";
import {
  AppError,
  IllegalTransitionError,
  METRIC,
  MONEY_EFFECTS,
  SETTLER,
  buildJournal,
  canonicalJson,
  enqueueEvent,
  sha256Hex,
  transition,
  withTx,
  type Client,
  type EventType,
  type KycTier,
  type Metrics,
  type OutboxRelay,
  type PhaseEffect,
  type Pool,
  type TransferEventPayload,
  type TransferStatus,
  type TransferType,
} from "@ecash/common";
import type { FastifyBaseLogger } from "fastify";
import type { Clients } from "./clients";

export interface TransferRow {
  id: string;
  type: TransferType;
  status: TransferStatus;
  user_id: string;
  idempotency_key: string;
  request_hash: string;
  amount_centavos: number;
  source_account: string;
  dest_account: string;
  counterparty: Record<string, unknown> | null;
  failure_reason: string | null;
  rail_reference: string | null;
  created_at: Date;
  updated_at: Date;
}

export type Action = { kind: "hold" } | { kind: "complete" } | { kind: "fail"; reason: string } | { kind: "reverse" };

export interface NewTransfer {
  userId: string;
  type: TransferType;
  idempotencyKey: string;
  /** Route plus canonical body make the request hash, so a reused key with another request is caught. */
  route: string;
  body: unknown;
  amountCentavos: number;
  sourceAccount: string;
  destAccount: string;
  counterparty: Record<string, unknown> | null;
  /** Runs in the creation transaction; throwing aborts the creation (used to claim a single-use QR). */
  claim?: (c: Client, transferId: string) => Promise<void>;
}

const EVENT_FOR_STATUS: Readonly<Record<TransferStatus, EventType>> = {
  PENDING: "transfer.created",
  COMPLETED: "transfer.completed",
  FAILED: "transfer.failed",
  REVERSED: "transfer.reversed",
};

const METRIC_STATUS: Partial<Record<TransferStatus, string>> = { PENDING: "pending", COMPLETED: "success", FAILED: "failed" };

export interface EngineDeps {
  pool: Pool;
  clients: Clients;
  metrics: Metrics;
  relay: OutboxRelay;
  log: FastifyBaseLogger;
  railCallbackUrl: string;
}

export interface Engine {
  create(input: NewTransfer): Promise<{ transfer: TransferRow; replay: boolean }>;
  drive(t: TransferRow): Promise<TransferRow>;
  apply(id: string, action: Action): Promise<TransferRow>;
  find(id: string): Promise<TransferRow | null>;
}

function eventPayload(t: TransferRow): TransferEventPayload {
  const recipient = t.type === "p2p" || t.type === "qr" ? (t.counterparty?.["user_id"] as string | undefined) : undefined;
  return {
    transfer_id: t.id,
    type: t.type,
    status: t.status,
    user_id: t.user_id,
    amount_centavos: t.amount_centavos,
    counterparty: t.counterparty,
    recipient_user_id: recipient ?? null,
    failure_reason: t.failure_reason,
  };
}

async function recordMove(c: Client, t: TransferRow, from: TransferStatus | null, reason: string | null): Promise<void> {
  await c.query("INSERT INTO status_history (transfer_id, from_status, to_status, reason) VALUES ($1, $2, $3, $4)", [t.id, from, t.status, reason]);
  await enqueueEvent(c, EVENT_FOR_STATUS[t.status], eventPayload(t));
}

export function createEngine(deps: EngineDeps): Engine {
  const { pool, clients, metrics, log } = deps;

  const find = async (id: string): Promise<TransferRow | null> =>
    (await pool.query<TransferRow>("SELECT * FROM transfers WHERE id = $1", [id])).rows[0] ?? null;

  function afterMove(t: TransferRow): void {
    const status = METRIC_STATUS[t.status];
    if (status) metrics.increment(METRIC.TRANSFER_COUNT, { type: t.type, status });
    if (t.status === "COMPLETED") metrics.distribution(METRIC.TRANSFER_AMOUNT_PHP, t.amount_centavos / 100, { type: t.type });
    deps.relay.poke();
  }

  async function create(input: NewTransfer): Promise<{ transfer: TransferRow; replay: boolean }> {
    const hash = sha256Hex(`${input.route}\n${canonicalJson(input.body)}`);
    const id = randomUUID();
    const outcome = await withTx(pool, async (c) => {
      const ins = await c.query<TransferRow>(
        `INSERT INTO transfers (id, type, status, user_id, idempotency_key, request_hash, amount_centavos, source_account, dest_account, counterparty)
         VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`,
        [id, input.type, input.userId, input.idempotencyKey, hash, input.amountCentavos, input.sourceAccount, input.destAccount, input.counterparty && JSON.stringify(input.counterparty)],
      );
      const created = ins.rows[0];
      if (created) {
        await input.claim?.(c, id);
        await recordMove(c, created, null, null);
        return { transfer: created, replay: false };
      }
      const existing = (
        await c.query<TransferRow>("SELECT * FROM transfers WHERE user_id = $1 AND idempotency_key = $2", [input.userId, input.idempotencyKey])
      ).rows[0]!;
      if (existing.request_hash !== hash) {
        throw new AppError("IDEMPOTENCY_KEY_REUSED", "this Idempotency-Key was already used with a different request");
      }
      return { transfer: existing, replay: true };
    });
    if (!outcome.replay) {
      afterMove(outcome.transfer);
      log.info({ transfer_id: outcome.transfer.id, type: input.type, amount_centavos: input.amountCentavos }, "transfer created");
    }
    return outcome;
  }

  async function apply(id: string, action: Action): Promise<TransferRow> {
    const before = await find(id);
    if (!before) throw new AppError("TRANSFER_NOT_FOUND", "no such transfer");
    // Tier decides the monthly cap of a journal's first post; a replay ignores limits, so a stale tier cannot strand a hold.
    const tier: KycTier = action.kind === "reverse" ? "BASIC" : (await clients.userById(before.user_id)).kyc_tier;

    const { row, moved } = await withTx(pool, async (c) => {
      // The row lock serializes competing outcomes for one transfer (webhook vs deadline vs reconciler).
      const t = (await c.query<TransferRow>("SELECT * FROM transfers WHERE id = $1 FOR UPDATE", [id])).rows[0]!;
      const fx = MONEY_EFFECTS[t.type];
      const post = (effect: PhaseEffect) => clients.postJournal(buildJournal(effect, t, tier));

      const move = async (to: TransferStatus, reason: string | null) => {
        const from = t.status;
        const next = transition(from, to);
        const res = await c.query<TransferRow>(
          "UPDATE transfers SET status = $2, failure_reason = $3, updated_at = now() WHERE id = $1 AND status = $4 RETURNING *",
          [t.id, next, reason, from],
        );
        const updated = res.rows[0];
        if (!updated) throw new IllegalTransitionError(from, next);
        await recordMove(c, updated, from, reason);
        if (next === "FAILED" && t.type === "qr") await c.query("UPDATE qr_codes SET paid_transfer_id = NULL WHERE paid_transfer_id = $1", [t.id]);
        return { row: updated, moved: true };
      };

      const fail = async (reason: string, effect: PhaseEffect | null) => {
        if (effect) {
          const r = await post(effect);
          if (!r.ok) throw new AppError("INTERNAL", `ledger rejected ${effect.phase} for transfer ${t.id}: ${r.error}`);
        }
        return move("FAILED", reason);
      };

      if (action.kind === "reverse") {
        transition(t.status, "REVERSED"); // throws ILLEGAL_TRANSITION unless COMPLETED
        const r = await post(fx.onReverse);
        if (!r.ok) throw new AppError("NOT_REVERSIBLE", `the ledger rejected the reversal: ${r.error}`);
        return move("REVERSED", "ops reversal");
      }

      if (t.status !== "PENDING") return { row: t, moved: false };

      if (fx.onCreate) {
        const r = await post(fx.onCreate);
        if (!r.ok) return fail(r.error, null); // the hold never posted, so there is nothing to release
      }
      if (action.kind === "hold") return { row: t, moved: false };
      if (action.kind === "fail") return fail(action.reason, fx.onFail);
      if (fx.onComplete) {
        const r = await post(fx.onComplete);
        if (!r.ok) return fail(r.error, fx.onFail);
      }
      return move("COMPLETED", null);
    });

    if (moved) {
      afterMove(row);
      log.info({ transfer_id: row.id, type: row.type, status: row.status, reason: row.failure_reason }, "transfer moved");
    }
    return row;
  }

  async function sendToRail(t: TransferRow): Promise<TransferRow> {
    const bank = String(t.counterparty?.["bank"] ?? "");
    const r = await clients.railSend({
      reference: t.id,
      direction: t.type === "cash_in" ? "cash_in" : "cash_out",
      bank,
      amount_centavos: t.amount_centavos,
      callback_url: deps.railCallbackUrl,
    });
    if (r.ok) {
      await pool.query("UPDATE transfers SET rail_reference = $2 WHERE id = $1 AND rail_reference IS NULL", [t.id, t.id]);
      return t;
    }
    if (r.rejected) return apply(t.id, { kind: "fail", reason: "RAIL_REJECTED" });
    log.warn({ transfer_id: t.id }, "bank rail unreachable; reconciler will resend");
    return t;
  }

  /** One idempotent step toward settlement. Safe to call again after any crash. */
  async function drive(t: TransferRow): Promise<TransferRow> {
    switch (SETTLER[t.type]) {
      case "ledger":
        return apply(t.id, { kind: "complete" });
      case "biller":
        return apply(t.id, { kind: "hold" });
      case "rail": {
        const held = await apply(t.id, { kind: "hold" });
        return held.status === "PENDING" ? sendToRail(held) : held;
      }
    }
  }

  return { create, drive, apply, find };
}
