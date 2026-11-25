import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, signWebhook } from "@ecash/common";
import { api, balanceOf, fund, getTransfer, newUser, pesos, readLog, reconcile, reverseTransfer, send, sleep, stack, waitFor, waitForStatus, wallet } from "./helpers";

afterEach(async () => {
  await api("PUT", "/api/sim/chaos", { body: { latency_ms: 0, failure_rate: 0 } });
});

const settled = (u: Parameters<typeof getTransfer>[0], id: string, timeoutMs = 20_000) =>
  waitFor(async () => {
    const t = await getTransfer(u, id);
    return t.status !== "PENDING" ? t : undefined;
  }, `transfer ${id} to leave PENDING`, timeoutMs);

describe("a hold whose tier no longer matches still converges", () => {
  it("fails a Fully Verified user's bill to ...0000 and returns the funds", async () => {
    const user = await newUser({ tier: "FULLY_VERIFIED" });
    await fund(user, pesos(1000));
    const bill = await api("POST", "/api/bills", { token: user.token, key: randomUUID(), body: { biller: "GLOBE", account_number: "5550000", amount_centavos: pesos(300) } });
    expect(bill.status).toBe(201);
    expect((await settled(user, bill.body.id)).status).toBe("FAILED");
    expect(await balanceOf(user)).toBe(pesos(1000));
  });

  it("fails a Fully Verified user's cash-out the rail declines and returns the funds", async () => {
    const user = await newUser({ tier: "FULLY_VERIFIED" });
    await fund(user, pesos(1000));
    await api("PUT", "/api/sim/chaos", { body: { failure_rate: 1 } });
    const out = await api("POST", "/api/cash-out", { token: user.token, key: randomUUID(), body: { bank: "BPI", amount_centavos: pesos(700) } });
    expect(out.status).toBe(201);
    expect((await settled(user, out.body.id)).status).toBe("FAILED");
    expect(await balanceOf(user)).toBe(pesos(1000));
  });

  it("completes a Basic user's cash-out after a KYC upgrade while it is PENDING", async () => {
    const user = await newUser();
    await fund(user, pesos(1000));
    // Rail latency keeps the cash-out PENDING (hold posted at Basic) while the tier changes.
    await api("PUT", "/api/sim/chaos", { body: { latency_ms: 1500 } });
    const pending = api("POST", "/api/cash-out", { token: user.token, key: randomUUID(), body: { bank: "BPI", amount_centavos: pesos(400) } });
    await sleep(300);
    expect((await api("POST", `/api/sim/users/${user.id}/kyc`, { body: { tier: "FULLY_VERIFIED" } })).status).toBe(200);
    const out = await pending;
    expect(out.status).toBe(201);
    expect((await settled(user, out.body.id)).status).toBe("COMPLETED");
    expect(await balanceOf(user)).toBe(pesos(600));
  });
});

describe("the monthly outgoing limit nets out money that came back", () => {
  it("does not count a failed bill's released hold", async () => {
    const [user, peer] = await Promise.all([newUser(), newUser()]);
    await fund(user, pesos(100_000));
    const bill = await api("POST", "/api/bills", { token: user.token, key: randomUUID(), body: { biller: "GLOBE", account_number: "5550000", amount_centavos: pesos(99_000) } });
    expect(bill.status).toBe(201);
    await waitForStatus(user, bill.body.id, "FAILED");
    expect((await wallet(user)).month_out_centavos).toBe(0);

    const s = await send(user, peer, pesos(50_000));
    expect([s.status, s.body.error]).toEqual([201, undefined]);
    expect((await wallet(user)).month_out_centavos).toBe(pesos(50_000));
    const sim = (await api("GET", "/api/sim/users")).body.users.find((u: { id: string }) => u.id === user.id);
    expect(sim.month_out_centavos).toBe(pesos(50_000));
  });

  it("does not count a reversed transfer", async () => {
    const [user, peer] = await Promise.all([newUser(), newUser()]);
    await fund(user, pesos(1000));
    const s = await send(user, peer, pesos(300));
    expect(s.status).toBe(201);
    expect((await wallet(user)).month_out_centavos).toBe(pesos(300));
    expect((await reverseTransfer(s.body.id)).status).toBe(200);
    expect((await wallet(user)).month_out_centavos).toBe(0);
    expect((await reconcile()).status).toBe("BALANCED");
  });
});

describe("rail transfers past the deadline", () => {
  it("end in agreement with the rail when the rail answers slower than the send timeout", async () => {
    const user = await newUser();
    await fund(user, pesos(1000));
    // 12 s of rail latency: every send times out (2 s) and the 8 s test deadline passes before the rail records it.
    await api("PUT", "/api/sim/chaos", { body: { latency_ms: 12_000 } });
    const out = await api("POST", "/api/cash-out", { token: user.token, key: randomUUID(), body: { bank: "BPI", amount_centavos: pesos(700) } });
    expect(out.status).toBe(201);
    const t = await settled(user, out.body.id, 30_000);
    const rail = await waitFor(async () => {
      const r = await fetch(`${stack.bankRail}/rail/transfers/${out.body.id}`);
      const body = r.ok ? ((await r.json()) as { status: string }) : undefined;
      return body && body.status !== "PENDING" ? body : undefined;
    }, "rail to settle", 30_000);
    expect({ transfer: t.status, rail: rail.status }).toEqual({ transfer: "COMPLETED", rail: "COMPLETED" });
    expect(await balanceOf(user)).toBe(pesos(300));
  });

  it("logs a settlement webhook that contradicts a terminal transfer at error level", async () => {
    const user = await newUser();
    await fund(user, pesos(1000));
    await api("PUT", "/api/sim/chaos", { body: { failure_rate: 1 } });
    const out = await api("POST", "/api/cash-out", { token: user.token, key: randomUUID(), body: { bank: "BPI", amount_centavos: pesos(100) } });
    expect((await settled(user, out.body.id)).status).toBe("FAILED");

    const raw = JSON.stringify({ reference: out.body.id, direction: "cash_out", bank: "BPI", amount_centavos: pesos(100), status: "COMPLETED", settled_at: new Date().toISOString() });
    const res = await fetch(`${stack.transfer}/webhooks/bank-rail`, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signWebhook(stack.serviceEnv["RAIL_WEBHOOK_SECRET"]!, raw) },
      body: raw,
    });
    expect(res.status).toBe(200);
    expect((await getTransfer(user, out.body.id)).status).toBe("FAILED");
    const line = await waitFor(
      async () => readLog("transfer").find((l) => l.transfer_id === out.body.id && l.rail_status === "COMPLETED" && l.level >= 50),
      "a settlement conflict log line",
    );
    expect(line.transfer_status).toBe("FAILED");
  });
});
