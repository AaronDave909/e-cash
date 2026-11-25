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

describe("simulator routes", () => {
  it("exist only when ECASH_SIMULATOR_ENABLED=true", async () => {
    const user = await newUser();
    const gw = await startExtraService("api-gateway", { ECASH_SIMULATOR_ENABLED: undefined });
    try {
      const probes: Array<[string, string, unknown]> = [
        ["GET", "/api/sim/users", undefined],
        ["POST", `/api/sim/users/${user.id}/unlock`, {}],
        ["POST", `/api/sim/users/${user.id}/kyc`, { tier: "FULLY_VERIFIED" }],
        ["GET", "/api/sim/chaos", undefined],
        ["PUT", "/api/sim/chaos", { failure_rate: 1 }],
        ["GET", "/api/sim/activity", undefined],
        ["GET", `/api/sim/receipts?user_id=${user.id}`, undefined],
      ];
      for (const [method, path, body] of probes) {
        const r = await api(method, path, { base: gw.url, body });
        expect({ path, status: r.status }).toEqual({ path, status: 404 });
      }
      expect((await wallet(user)).tier).toBe("BASIC");
      expect((await api("GET", "/api/wallet", { base: gw.url, token: user.token })).status).toBe(200);
    } finally {
      await gw.stop();
    }
  });

  it("offer no reversal: the gateway route is gone and the transfer stays COMPLETED", async () => {
    const [alice, bob] = await Promise.all([newUser(), newUser()]);
    await fund(alice, pesos(500));
    const sent = await send(alice, bob, pesos(200));
    expect(sent.status).toBe(201);
    const r = await api("POST", `/api/sim/transfers/${sent.body.id}/reverse`, { body: {} });
    expect(r.status).toBe(404);
    expect((await getTransfer(alice, sent.body.id)).status).toBe("COMPLETED");
    expect(await balanceOf(bob)).toBe(pesos(200));
  });

  it("rate-limit unlock per target user to 3 per 10 minutes", async () => {
    const [target, other] = await Promise.all([newUser(), newUser()]);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await api("POST", `/api/sim/users/${target.id}/unlock`, { body: {} })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect((await api("POST", `/api/sim/users/${other.id}/unlock`, { body: {} })).status).toBe(200);
  });
});

describe("per-IP rate limit", () => {
  it("ignores X-Forwarded-For unless the peer is in TRUSTED_PROXIES", async () => {
    const hits = async (base: string, xff: (i: number) => string) => {
      const out: number[] = [];
      for (let i = 0; i < 10; i++) out.push((await api("GET", "/api/auth/no-such-route", { base, headers: { "x-forwarded-for": xff(i) } })).status);
      return out;
    };

    const direct = await startExtraService("api-gateway", { RATE_LIMIT_MAX: "5", REDIS_URL: otherRedisDb(6), TRUSTED_PROXIES: undefined });
    try {
      const statuses = await hits(direct.url, (i) => `198.51.100.${i + 1}`);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
    } finally {
      await direct.stop();
    }

    // Behind a trusted proxy the forwarded address is the client, so ten clients get ten budgets.
    const proxied = await startExtraService("api-gateway", { RATE_LIMIT_MAX: "5", REDIS_URL: otherRedisDb(7), TRUSTED_PROXIES: "127.0.0.1" });
    try {
      const statuses = await hits(proxied.url, (i) => `203.0.113.${i + 1}`);
      expect(statuses.filter((s) => s === 429)).toEqual([]);
    } finally {
      await proxied.stop();
    }
  });
});

describe("framework errors", () => {
  it("map to documented error codes", async () => {
    const user = await newUser();
    const big = await api("POST", "/api/transfers/p2p", {
      token: user.token,
      key: randomUUID(),
      body: { to_mobile: "+639171234567", amount_centavos: 100, note: "a".repeat(300_000) },
    });
    expect([big.status, big.body.error]).toEqual([413, "PAYLOAD_TOO_LARGE"]);

    const res = await fetch(`${stack.gateway}/api/transfers/p2p`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.token}`, "idempotency-key": randomUUID(), "content-type": "text/plain" },
      body: "hello",
    });
    const text = { status: res.status, body: (await res.json()) as { error: string } };
    expect([text.status, text.body.error]).toEqual([415, "UNSUPPORTED_MEDIA_TYPE"]);

    for (const r of [big, text]) expect(ERROR_STATUS[r.body.error as keyof typeof ERROR_STATUS]).toBe(r.status);
  });
});
