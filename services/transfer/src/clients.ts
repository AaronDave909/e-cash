import {
  AppError,
  callJson,
  isErrorCode,
  type ErrorCode,
  type JournalRequest,
  type KycTier,
} from "@ecash/common";

export interface UserView {
  id: string;
  mobile: string;
  display_name: string;
  kyc_tier: KycTier;
  locked: boolean;
}

export type LedgerOutcome = { ok: true } | { ok: false; error: ErrorCode; message: string };

export interface Clients {
  userById(id: string): Promise<UserView>;
  userByMobile(mobile: string): Promise<UserView | null>;
  postJournal(req: JournalRequest): Promise<LedgerOutcome>;
  balance(code: string): Promise<number>;
  monthTotal(code: string, direction: "DEBIT" | "CREDIT", kinds: string[]): Promise<number>;
  railSend(body: RailSendBody): Promise<{ ok: true; status: string } | { ok: false; rejected: boolean }>;
  railLookup(reference: string): Promise<"FOUND" | "MISSING">;
}

export interface RailSendBody {
  reference: string;
  direction: "cash_in" | "cash_out";
  bank: string;
  amount_centavos: number;
  callback_url: string;
}

export function createClients(urls: { auth: string; ledger: string; bankRail: string }): Clients {
  return {
    async userById(id) {
      const r = await callJson<UserView>(`${urls.auth}/users/${encodeURIComponent(id)}`);
      if (r.status === 404) throw new AppError("USER_NOT_FOUND", "no such user");
      if (r.status !== 200) throw new AppError("UPSTREAM_UNAVAILABLE", `auth returned ${r.status}`);
      return r.body;
    },
    async userByMobile(mobile) {
      const r = await callJson<UserView>(`${urls.auth}/users/by-mobile/${encodeURIComponent(mobile)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw new AppError("UPSTREAM_UNAVAILABLE", `auth returned ${r.status}`);
      return r.body;
    },
    async postJournal(req) {
      const r = await callJson<{ error?: string; message?: string }>(`${urls.ledger}/journals`, { body: req, timeoutMs: 8000 });
      if (r.status === 200 || r.status === 201) return { ok: true };
      if (r.status === 422 && r.body.error && isErrorCode(r.body.error)) {
        return { ok: false, error: r.body.error, message: r.body.message ?? r.body.error };
      }
      throw new AppError("UPSTREAM_UNAVAILABLE", `ledger returned ${r.status}: ${r.body?.error ?? "unknown"}`);
    },
    async balance(code) {
      const r = await callJson<{ balance_centavos: number }>(`${urls.ledger}/accounts/${encodeURIComponent(code)}/balance`);
      if (r.status !== 200) throw new AppError("UPSTREAM_UNAVAILABLE", `ledger returned ${r.status}`);
      return r.body.balance_centavos;
    },
    async monthTotal(code, direction, kinds) {
      const q = new URLSearchParams({ direction, kinds: kinds.join(",") });
      const r = await callJson<{ total_centavos: number }>(`${urls.ledger}/accounts/${encodeURIComponent(code)}/month-total?${q}`);
      if (r.status !== 200) throw new AppError("UPSTREAM_UNAVAILABLE", `ledger returned ${r.status}`);
      return r.body.total_centavos;
    },
    async railSend(body) {
      try {
        const r = await callJson<{ status: string }>(`${urls.bankRail}/rail/transfers`, { body, timeoutMs: 2000 });
        if (r.status === 202 || r.status === 200) return { ok: true, status: r.body.status };
        return { ok: false, rejected: r.status >= 400 && r.status < 500 };
      } catch {
        return { ok: false, rejected: false };
      }
    },
    async railLookup(reference) {
      const r = await callJson(`${urls.bankRail}/rail/transfers/${encodeURIComponent(reference)}`, { timeoutMs: 2000 });
      if (r.status === 404) return "MISSING";
      if (r.status === 200) return "FOUND";
      throw new AppError("UPSTREAM_UNAVAILABLE", `bank rail returned ${r.status}`);
    },
  };
}
