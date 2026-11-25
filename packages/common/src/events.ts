import { z } from "zod";
import { TRANSFER_STATUSES, TRANSFER_TYPES } from "./transfer-domain";

export const EVENT_STREAM = "ecash:events";
export const CHAOS_KEY = "ecash:chaos:bank_rail";

export const EVENT_TYPES = ["transfer.created", "transfer.completed", "transfer.failed", "transfer.reversed"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const transferEventPayloadSchema = z.object({
  transfer_id: z.string().uuid(),
  type: z.enum(TRANSFER_TYPES),
  status: z.enum(TRANSFER_STATUSES),
  user_id: z.string().uuid(),
  amount_centavos: z.number().int(),
  counterparty: z.record(z.unknown()).nullable(),
  recipient_user_id: z.string().uuid().nullable(),
  failure_reason: z.string().nullable(),
});
export type TransferEventPayload = z.infer<typeof transferEventPayloadSchema>;

/** What is written to the stream under the `event` field. */
export const eventEnvelopeSchema = z.object({
  event_id: z.string().uuid(),
  type: z.enum(EVENT_TYPES),
  occurred_at: z.string(),
  trace_id: z.string().nullable(),
  trace_carrier: z.record(z.string()),
  payload: transferEventPayloadSchema,
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const METRIC = {
  TRANSFER_COUNT: "ecash.transfer.count",
  TRANSFER_AMOUNT_PHP: "ecash.transfer.amount_php",
  BANK_RAIL_SETTLEMENT_MS: "ecash.bank_rail.settlement_ms",
  MPIN_FAILED: "ecash.auth.mpin_failed",
  LEDGER_INVARIANT_ERRORS: "ecash.ledger.invariant_errors",
  LEDGER_JOURNALS: "ecash.ledger.journals",
  OUTBOX_PUBLISHED: "ecash.outbox.published",
  WORKER_EVENTS: "ecash.worker.events",
} as const;

export interface RailWebhookBody {
  reference: string;
  direction: "cash_in" | "cash_out";
  bank: string;
  amount_centavos: number;
  status: "COMPLETED" | "FAILED";
  failure_reason?: string;
  settled_at: string;
}
