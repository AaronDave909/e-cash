import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { api, balanceOf, fund, newUser, pesos, reconcile, stack, waitForStatus, getTransfer } from "./helpers";
import { createHmac } from "node:crypto";

const signed = (secret: string, body: string, t: number) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

async function postWebhook(body: object, signature?: string) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${stack.transfer}/webhooks/bank-rail`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "x-ecash-signature": signature } : {}) },
    body: raw,
  });
  return { status: res.status, body: (await res.json()) as any };
}

afterEach(async () => {
  await api("PUT", "/api/sim/chaos", { body: { latency_ms: 0, failure_rate: 0 } });
});

describe("cash-in via bank rail", () => {
  it("settles through a signed webhook to COMPLETED and records PENDING then COMPLETED", async () => {
    const user = await newUser();
    const created = await api("POST", "/api/cash-in", { token: user.token, key: randomUUID(), body: { bank: "BPI", amount_centavos: pesos(500) } });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("PENDING");

    const done = await waitForStatus(user, created.body.id, "COMPLETED");
    expect(done.status_history.map((h: any) => h.to_status)).toEqual(["PENDING", "COMPLETED"]);
    expect(await balanceOf(user)).toBe(pesos(500));
    expect((await reconcile()).status).toBe("BALANCED");
  });

  it("rejects forged, unsigned and stale webhooks with 401 and changes nothing", async () => {
    const user = await newUser();
    const created = await api("POST", "/api/cash-in", { token: user.token, key: randomUUID(), body: { bank: "BPI", amount_centavos: pesos(300) } });
    const payload = { reference: created.body.id, status: "FAILED", failure_reason: "FORGED", direction: "cash_in", bank: "BPI", amount_centavos: pesos(300), settled_at: new Date().toISOString() };
    const now = Math.floor(Date.now() / 1000);

    const forged = await postWebhook(payload, signed("wrong-secret", JSON.stringify(payload), now));
    const unsigned = await postWebhook(payload);
    const stale = await postWebhook(payload, signed("test-rail-secret", JSON.stringify(payload), now - 3600));
    const tampered = await postWebhook(payload, signed("test-rail-secret", JSON.stringify({ ...payload, status: "COMPLETED" }), now));

    for (const r of [forged, unsigned, stale, tampered]) {
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("INVALID_SIGNATURE");
    }
    // The genuine rail outcome still wins: completed once, never failed by the forgeries.
    const done = await waitForStatus(user, created.body.id, "COMPLETED");
    expect(done.status_history.map((h: any) => h.to_status)).toEqual(["PENDING", "COMPLETED"]);
    expect(await balanceOf(user)).toBe(pesos(300));
  });

  it("applies a correctly signed webhook only once", async () => {
    const user = await newUser();
    const created = await api("POST", "/api/cash-in", { token: user.token, key: randomUUID(), body: { bank: "UNIONBANK", amount_centavos: pesos(200) } });
    await waitForStatus(user, created.body.id, "COMPLETED");
    const payload = { reference: created.body.id, status: "COMPLETED", direction: "cash_in", bank: "UNIONBANK", amount_centavos: pesos(200), settled_at: new Date().toISOString() };
    const raw = JSON.stringify(payload);
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${stack.transfer}/webhooks/bank-rail`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ecash-signature": signed("test-rail-secret", raw, Math.floor(Date.now() / 1000)) },
        body: raw,
      });
      expect(res.status).toBe(200);
    }
    expect(await balanceOf(user)).toBe(pesos(200));
    expect((await getTransfer(user, created.body.id)).status_history).toHaveLength(2);
  });
});

describe("cash-out via bank rail", () => {
  it("holds funds, then completes", async () => {
    const user = await newUser();
    await fund(user, pesos(1000));
    const out = await api("POST", "/api/cash-out", { token: user.token, key: randomUUID(), body: { bank: "PESONET", amount_centavos: pesos(400) } });
    expect(out.status).toBe(201);
    expect(await balanceOf(user)).toBe(pesos(600));
    await waitForStatus(user, out.body.id, "COMPLETED");
    expect(await balanceOf(user)).toBe(pesos(600));
    expect((await reconcile()).status).toBe("BALANCED");
  });

  it("ends FAILED with the held funds returned when the rail always fails", async () => {
    const user = await newUser();
    await fund(user, pesos(1000));
    const chaos = await api("PUT", "/api/sim/chaos", { body: { failure_rate: 1 } });
    expect(chaos.status).toBe(200);
    expect((await api("GET", "/api/sim/chaos")).body.failure_rate).toBe(1);

    const out = await api("POST", "/api/cash-out", { token: user.token, key: randomUUID(), body: { bank: "BPI", amount_centavos: pesos(700) } });
    expect(out.status).toBe(201);
    const failed = await waitForStatus(user, out.body.id, "FAILED");

    expect(failed.status_history.map((h: any) => h.to_status)).toEqual(["PENDING", "FAILED"]);
    expect(await balanceOf(user)).toBe(pesos(1000));
    expect((await reconcile()).status).toBe("BALANCED");
  });

  it("rejects a cash-out larger than the balance without a rail call", async () => {
    const user = await newUser();
    await fund(user, pesos(100));
    const out = await api("POST", "/api/cash-out", { token: user.token, key: randomUUID(), body: { bank: "BPI", amount_centavos: pesos(101) } });
    expect(out.status).toBe(422);
    expect(out.body.error).toBe("INSUFFICIENT_FUNDS");
    expect(await balanceOf(user)).toBe(pesos(100));
  });
});
