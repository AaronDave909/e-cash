import { z } from "zod";
import { AppError } from "./errors";
import { KYC_MONTHLY_LIMIT_CENTAVOS, type KycTier } from "./kyc";

export const TRANSFER_TYPES = ["p2p", "qr", "bills", "cash_in", "cash_out"] as const;
export type TransferType = (typeof TRANSFER_TYPES)[number];

export const TRANSFER_STATUSES = ["PENDING", "COMPLETED", "FAILED", "REVERSED"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const BANKS = ["INSTAPAY", "PESONET", "BPI", "UNIONBANK", "OTC_7ELEVEN"] as const;
export type Bank = (typeof BANKS)[number];
export const bankSchema = z.enum(BANKS);

export const BILLERS = ["MERALCO", "MAYNILAD", "GLOBE"] as const;
export type Biller = (typeof BILLERS)[number];
export const billerSchema = z.enum(BILLERS);

// ---------------------------------------------------------------------------
// State machine: the legal moves are data, `transition` is the only way to move.
// ---------------------------------------------------------------------------

export const TRANSITIONS: ReadonlyArray<{ from: TransferStatus; to: TransferStatus; when: string }> = [
  { from: "PENDING", to: "COMPLETED", when: "journal posted, bank webhook success, or biller success" },
  { from: "PENDING", to: "FAILED", when: "ledger rejected, bank webhook failure, biller failure, or deadline passed" },
  { from: "COMPLETED", to: "REVERSED", when: "ops reversal posts a compensating journal" },
];

export class IllegalTransitionError extends AppError {
  constructor(from: TransferStatus, to: TransferStatus) {
    super("ILLEGAL_TRANSITION", `transfer cannot move from ${from} to ${to}`, { from, to });
  }
}

export function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** Returns `to` when the move is legal and throws otherwise. Every status change goes through here. */
export function transition(from: TransferStatus, to: TransferStatus): TransferStatus {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

export const isTerminal = (s: TransferStatus): boolean => s === "COMPLETED" || s === "FAILED" || s === "REVERSED";

// ---------------------------------------------------------------------------
// Money effects: one table keyed by type. Each effect is a journal between two roles.
// ---------------------------------------------------------------------------

/** SOURCE and DEST are the transfer's own accounts; the clearing role is a fixed system account. */
export type AccountRole = "SOURCE" | "DEST" | "CASHOUT_CLEARING";
export type JournalPhase = "post" | "hold" | "settle" | "release" | "reverse";
export type Direction = "DEBIT" | "CREDIT";

export interface PhaseEffect {
  readonly phase: JournalPhase;
  readonly debit: AccountRole;
  readonly credit: AccountRole;
  /** Monthly cap that applies to this journal: the role's postings in `direction`. */
  readonly limit?: { readonly role: AccountRole; readonly direction: Direction };
}

export interface TypeEffects {
  readonly onCreate: PhaseEffect | null;
  readonly onComplete: PhaseEffect | null;
  readonly onFail: PhaseEffect | null;
  readonly onReverse: PhaseEffect;
}

const OUTGOING = { role: "SOURCE", direction: "DEBIT" } as const;

export const MONEY_EFFECTS: Readonly<Record<TransferType, TypeEffects>> = {
  p2p: {
    onCreate: null,
    onComplete: { phase: "post", debit: "SOURCE", credit: "DEST", limit: OUTGOING },
    onFail: null,
    onReverse: { phase: "reverse", debit: "DEST", credit: "SOURCE" },
  },
  qr: {
    onCreate: null,
    onComplete: { phase: "post", debit: "SOURCE", credit: "DEST", limit: OUTGOING },
    onFail: null,
    onReverse: { phase: "reverse", debit: "DEST", credit: "SOURCE" },
  },
  cash_in: {
    onCreate: null,
    onComplete: { phase: "settle", debit: "SOURCE", credit: "DEST", limit: { role: "DEST", direction: "CREDIT" } },
    onFail: null,
    onReverse: { phase: "reverse", debit: "DEST", credit: "SOURCE" },
  },
  cash_out: {
    onCreate: { phase: "hold", debit: "SOURCE", credit: "CASHOUT_CLEARING", limit: OUTGOING },
    onComplete: { phase: "settle", debit: "CASHOUT_CLEARING", credit: "DEST" },
    onFail: { phase: "release", debit: "CASHOUT_CLEARING", credit: "SOURCE" },
    onReverse: { phase: "reverse", debit: "DEST", credit: "SOURCE" },
  },
  bills: {
    onCreate: { phase: "hold", debit: "SOURCE", credit: "DEST", limit: OUTGOING },
    onComplete: null,
    onFail: { phase: "release", debit: "DEST", credit: "SOURCE" },
    onReverse: { phase: "reverse", debit: "DEST", credit: "SOURCE" },
  },
};

export const CASHOUT_CLEARING_ACCOUNT = "system:cashout_clearing";
export const walletCode = (userId: string): string => `wallet:${userId}`;
export const bankClearingCode = (bank: Bank): string => `system:bank_clearing:${bank}`;
export const billerCode = (biller: Biller): string => `system:biller:${biller}`;

/** Journal kinds (`<type>.<phase>`) whose postings count toward `role`/`direction` month totals. */
export function limitKinds(limit: NonNullable<PhaseEffect["limit"]>): string[] {
  const kinds: string[] = [];
  for (const type of TRANSFER_TYPES) {
    const fx = MONEY_EFFECTS[type];
    for (const e of [fx.onCreate, fx.onComplete]) {
      if (e?.limit && e.limit.role === limit.role && e.limit.direction === limit.direction) kinds.push(journalKind(type, e.phase));
    }
  }
  return kinds;
}

export const journalKind = (type: TransferType, phase: JournalPhase): string => `${type}.${phase}`;

// ---------------------------------------------------------------------------
// Ledger journal request, shared by the transfer service (builder) and ledger (parser).
// ---------------------------------------------------------------------------

export const journalRequestSchema = z.object({
  idempotency_key: z.string().min(1).max(200),
  kind: z.string().min(1).max(100),
  metadata: z.record(z.unknown()).optional().default({}),
  postings: z
    .array(
      z.object({
        account_code: z.string().min(1).max(200),
        direction: z.enum(["DEBIT", "CREDIT"]),
        amount_centavos: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .min(2)
    .max(20),
  limits: z
    .array(
      z.object({
        account_code: z.string().min(1).max(200),
        direction: z.enum(["DEBIT", "CREDIT"]),
        max_month_centavos: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        /** Optional extension: count only postings from journals of these kinds. */
        kinds: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
export type JournalRequest = z.input<typeof journalRequestSchema>;

export interface TransferAccounts {
  readonly id: string;
  readonly type: TransferType;
  readonly amount_centavos: number;
  readonly source_account: string;
  readonly dest_account: string;
}

const roleAccount = (role: AccountRole, t: TransferAccounts): string =>
  role === "SOURCE" ? t.source_account : role === "DEST" ? t.dest_account : CASHOUT_CLEARING_ACCOUNT;

/** Builds the ledger request for one phase of a transfer. The key `transfer:<id>:<phase>` makes retries safe. */
export function buildJournal(effect: PhaseEffect, t: TransferAccounts, tier: KycTier): JournalRequest {
  const request: JournalRequest = {
    idempotency_key: `transfer:${t.id}:${effect.phase}`,
    kind: journalKind(t.type, effect.phase),
    metadata: { transfer_id: t.id, type: t.type, phase: effect.phase },
    postings: [
      { account_code: roleAccount(effect.debit, t), direction: "DEBIT", amount_centavos: t.amount_centavos },
      { account_code: roleAccount(effect.credit, t), direction: "CREDIT", amount_centavos: t.amount_centavos },
    ],
  };
  if (effect.limit) {
    request.limits = [
      {
        account_code: roleAccount(effect.limit.role, t),
        direction: effect.limit.direction,
        max_month_centavos: KYC_MONTHLY_LIMIT_CENTAVOS[tier],
        kinds: limitKinds(effect.limit),
      },
    ];
  }
  return request;
}
