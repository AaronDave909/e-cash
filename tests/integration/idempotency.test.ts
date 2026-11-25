import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, balanceOf, fund, newUser, pesos, reconcile, send } from "./helpers";

describe("idempotency", () => {
  it("replays the same key and body as one transfer and one debit", async () => {
    const [alice, bob] = await Promise.all([newUser(), newUser()]);
    await fund(alice, pesos(1000));
    const key = randomUUID();

    const first = await send(alice, bob, pesos(100), key);
    const second = await send(alice, bob, pesos(100), key);

    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replay")).toBeNull();
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.status).toBe("COMPLETED");

    expect(await balanceOf(alice)).toBe(pesos(900));
    expect(await balanceOf(bob)).toBe(pesos(100));
    const history = await api("GET", "/api/transfers?limit=50", { token: alice.token });
    expect(history.body.transfers.filter((t: any) => t.type === "p2p")).toHaveLength(1);
    expect((await reconcile()).status).toBe("BALANCED");
  });

  it("rejects the same key with a different body with 422 and moves no money", async () => {
    const [alice, bob] = await Promise.all([newUser(), newUser()]);
    await fund(alice, pesos(500));
    const key = randomUUID();
    expect((await send(alice, bob, pesos(100), key)).status).toBe(201);

    const reused = await send(alice, bob, pesos(200), key);
    expect(reused.status).toBe(422);
    expect(reused.body.error).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await balanceOf(alice)).toBe(pesos(400));
    expect(await balanceOf(bob)).toBe(pesos(100));
  });

  it("treats a rejected transfer as final for its key", async () => {
    const [alice, bob] = await Promise.all([newUser(), newUser()]);
    const key = randomUUID();
    const first = await send(alice, bob, pesos(100), key);
    expect(first.status).toBe(422);
    expect(first.body.error).toBe("INSUFFICIENT_FUNDS");
    await fund(alice, pesos(500));
    const again = await send(alice, bob, pesos(100), key);
    expect(again.status).toBe(422);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect(await balanceOf(alice)).toBe(pesos(500));
  });

  it("requires an Idempotency-Key on every money-moving POST", async () => {
    const [alice, bob] = await Promise.all([newUser(), newUser()]);
    await fund(alice, pesos(500));
    const bodies: Array<[string, object]> = [
      ["/api/transfers/p2p", { to_mobile: bob.mobile, amount_centavos: 100 }],
      ["/api/cash-in", { bank: "BPI", amount_centavos: 100 }],
      ["/api/cash-out", { bank: "BPI", amount_centavos: 100 }],
      ["/api/bills", { biller: "MERALCO", account_number: "1234567", amount_centavos: 100 }],
      ["/api/qr/pay", { payload: "ECASH1.x.y", amount_centavos: 100 }],
    ];
    for (const [route, body] of bodies) {
      const r = await api("POST", route, { token: alice.token, body });
      expect(r.status, route).toBe(400);
      expect(r.body.error, route).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
    expect(await balanceOf(alice)).toBe(pesos(500));
  });

  it("answers 401 without a token and 400 for a malformed body", async () => {
    const [alice] = await Promise.all([newUser()]);
    expect((await api("POST", "/api/transfers/p2p", { key: randomUUID(), body: {} })).status).toBe(401);
    const bad = await api("POST", "/api/transfers/p2p", { token: alice.token, key: randomUUID(), body: { to_mobile: "nope", amount_centavos: -5 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("VALIDATION_ERROR");
  });
});
