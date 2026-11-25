import { describe, expect, it } from "vitest";
import {
  KYC_MONTHLY_LIMIT_CENTAVOS,
  MONEY_EFFECTS,
  TRANSFER_STATUSES,
  TRANSFER_TYPES,
  buildJournal,
  canTransition,
  formatPhp,
  parseMobile,
  transition,
} from "@ecash/common";

describe("domain tables", () => {
  it("allows only the contract's three moves", () => {
    const legal = TRANSFER_STATUSES.flatMap((f) => TRANSFER_STATUSES.filter((t) => canTransition(f, t)).map((t) => `${f}>${t}`));
    expect(legal.sort()).toEqual(["COMPLETED>REVERSED", "PENDING>COMPLETED", "PENDING>FAILED"]);
    expect(() => transition("FAILED", "COMPLETED")).toThrow(/cannot move/);
    expect(transition("PENDING", "COMPLETED")).toBe("COMPLETED");
  });

  it("holds the KYC limits from the requirements", () => {
    expect(KYC_MONTHLY_LIMIT_CENTAVOS.BASIC).toBe(10_000_000);
    expect(KYC_MONTHLY_LIMIT_CENTAVOS.FULLY_VERIFIED).toBe(50_000_000);
  });

  it("builds balanced two-posting journals with phase-scoped idempotency keys for every effect", () => {
    for (const type of TRANSFER_TYPES) {
      const fx = MONEY_EFFECTS[type];
      for (const effect of [fx.onCreate, fx.onComplete, fx.onFail, fx.onReverse]) {
        if (!effect) continue;
        const j = buildJournal(effect, { id: "t1", type, amount_centavos: 500, source_account: "wallet:a", dest_account: "wallet:b" }, "BASIC");
        expect(j.idempotency_key).toBe(`transfer:t1:${effect.phase}`);
        const d = j.postings.filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amount_centavos, 0);
        const c = j.postings.filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amount_centavos, 0);
        expect(d).toBe(c);
      }
    }
  });

  it("normalizes Philippine mobile numbers and formats pesos", () => {
    expect(parseMobile("09171234567")).toBe("+639171234567");
    expect(parseMobile("639171234567")).toBe("+639171234567");
    expect(parseMobile("+63 917 123 4567")).toBe("+639171234567");
    expect(parseMobile("0817123456")).toBeNull();
    expect(formatPhp(123450)).toBe("₱1,234.50");
  });
});
