import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ERROR_STATUS } from "@ecash/common";
import { api, balanceOf, fund, getTransfer, newUser, pesos, rawRequest, send, stack, startExtraService, waitFor, wallet } from "./helpers";

const otherRedisDb = (db: number): string => stack.redisUrl.replace(/\/\d+$/, `/${db}`);

describe("gateway path normalization", () => {
  it("answers 404 to dot segments, encoded slashes and backslashes instead of reaching internal routes", async () => {
    const [victim, payer] = await Promise.all([newUser(), newUser()]);
    await fund(payer, pesos(500));
    const bill = await api("POST", "/api/bills", {
      token: payer.token,
      key: randomUUID(),
      body: { biller: "MERALCO", account_number: "123456789", amount_centavos: pesos(100) },
    });
    expect(bill.status).toBe(201);

    const probes: Array<[string, string, { token?: string; body?: unknown }]> = [
      ["GET", "/api/auth/../users", {}],
      ["GET", "/api/auth/./../users", {}],
      ["POST", `/api/auth/%2e%2e/auth/users/${victim.id}/kyc`, { body: { tier: "FULLY_VERIFIED" } }],
      ["POST", `/api/auth/%2E%2E/auth/users/${victim.id}/unlock`, { body: {} }],
      ["POST", `/api/auth/..%2fauth/users/${victim.id}/kyc`, { body: { tier: "FULLY_VERIFIED" } }],
      ["GET", "/api/auth/..\\users", {}],
      ["GET", "/api/auth/%5c..%5cusers", {}],
      ["GET", "/api/auth//users", {}],
      ["POST", `/api/bills/%2e%2e/internal/bills/${bill.body.id}/result`, { token: payer.token, body: { success: false, reason: "FORCED" } }],
      ["GET", "/api/transfers/../../internal/transfers/recent", { token: payer.token }],
    ];
    for (const [method, path, opts] of probes) {
      const r = await rawRequest(method, path, opts);
      expect({ path, status: r.status, error: r.body?.error }).toEqual({ path, status: 404, error: "NOT_FOUND" });
    }

    expect((await wallet(victim)).tier).toBe("BASIC");
    const settled = await waitFor(async () => {
      const t = await getTransfer(payer, bill.body.id);
      return t.status !== "PENDING" ? t : undefined;
    }, "bill to settle");
    expect([settled.status, settled.failure_reason]).toEqual(["COMPLETED", null]);

    // The decoded path is the one matched and forwarded, so a percent-encoded letter still reaches /wallet.
    const encoded = await rawRequest("GET", "/api/w%61llet", { token: payer.token });
    expect(encoded.status).toBe(200);
    expect(encoded.body.balance_centavos).toBe(pesos(400));
  });
});
