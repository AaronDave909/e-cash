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
