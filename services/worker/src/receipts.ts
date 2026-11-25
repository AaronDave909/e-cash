import { formatPhp, type EventEnvelope, type TransferType } from "@ecash/common";

export interface ReceiptDraft {
  user_id: string;
  body: string;
}

const shortRef = (id: string): string => id.slice(0, 8).toUpperCase();

const LABEL: Record<TransferType, string> = {
  p2p: "money transfer",
  qr: "QR payment",
  bills: "bill payment",
  cash_in: "cash in",
  cash_out: "cash out",
};

/** Receipt text for the sender (and recipient, for peer payments) of a terminal transfer event. */
export function draftReceipts(ev: EventEnvelope): ReceiptDraft[] {
  const p = ev.payload;
  const amount = formatPhp(p.amount_centavos);
  const ref = shortRef(p.transfer_id);
  const cp = p.counterparty ?? {};
  const who = String(cp["display_name"] ?? cp["mobile"] ?? "an E-Cash user");
  const out: ReceiptDraft[] = [];

  if (ev.type === "transfer.completed") {
    switch (p.type) {
      case "p2p":
        out.push({ user_id: p.user_id, body: `E-Cash: You sent ${amount} to ${who}. Ref ${ref}.` });
        if (p.recipient_user_id) out.push({ user_id: p.recipient_user_id, body: `E-Cash: You received ${amount}. Ref ${ref}.` });
        break;
      case "qr":
        out.push({ user_id: p.user_id, body: `E-Cash: You paid ${amount} to ${who} via QR. Ref ${ref}.` });
        if (p.recipient_user_id) out.push({ user_id: p.recipient_user_id, body: `E-Cash: You received ${amount} via QR. Ref ${ref}.` });
        break;
      case "bills":
        out.push({ user_id: p.user_id, body: `E-Cash: Your ${amount} payment to ${String(cp["biller"])} account ${String(cp["account_number"])} was successful. Ref ${ref}.` });
        break;
      case "cash_in":
        out.push({ user_id: p.user_id, body: `E-Cash: ${amount} was added to your wallet from ${String(cp["bank"])}. Ref ${ref}.` });
        break;
      case "cash_out":
        out.push({ user_id: p.user_id, body: `E-Cash: ${amount} was sent to your ${String(cp["bank"])} account. Ref ${ref}.` });
        break;
    }
  } else if (ev.type === "transfer.failed") {
    const returned = p.type === "bills" || p.type === "cash_out" ? " Any held funds were returned to your wallet." : "";
    out.push({ user_id: p.user_id, body: `E-Cash: Your ${LABEL[p.type]} of ${amount} failed (${p.failure_reason ?? "unknown reason"}).${returned} Ref ${ref}.` });
  } else if (ev.type === "transfer.reversed") {
    out.push({ user_id: p.user_id, body: `E-Cash: Your ${LABEL[p.type]} of ${amount} was reversed. Ref ${ref}.` });
    if (p.recipient_user_id) out.push({ user_id: p.recipient_user_id, body: `E-Cash: ${amount} was reversed out of your wallet. Ref ${ref}.` });
  }
  return out;
}
