import { walletCode } from "@ecash/common";
import type { TransferRow } from "./engine";

export interface HistoryRow {
  from_status: string | null;
  to_status: string;
  reason: string | null;
  at: Date;
}

export function toDto(t: TransferRow, history?: HistoryRow[], viewerId?: string) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    user_id: t.user_id,
    amount_centavos: t.amount_centavos,
    counterparty: t.counterparty,
    failure_reason: t.failure_reason,
    rail_reference: t.rail_reference,
    created_at: t.created_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
    ...(viewerId ? { direction: t.dest_account === walletCode(viewerId) ? "IN" : "OUT" } : {}),
    ...(history
      ? { status_history: history.map((h) => ({ from_status: h.from_status, to_status: h.to_status, reason: h.reason, at: h.at.toISOString() })) }
      : {}),
  };
}
