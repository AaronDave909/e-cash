import type { Centavos } from "./money";

export const KYC_TIERS = ["BASIC", "FULLY_VERIFIED"] as const;
export type KycTier = (typeof KYC_TIERS)[number];

/** Monthly cap on outgoing debits and on cash-in credits, per tier. */
export const KYC_MONTHLY_LIMIT_CENTAVOS: Readonly<Record<KycTier, Centavos>> = {
  BASIC: 100_000_00 as Centavos,
  FULLY_VERIFIED: 500_000_00 as Centavos,
};
