import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, balanceOf, fund, newUser, pesos, reconcile, waitFor, waitForStatus } from "./helpers";

const receipts = async (userId: string) => (await api("GET", `/api/sim/receipts?user_id=${userId}`)).body.receipts as Array<{ channel: string; body: string; transfer_id: string }>;

describe("bills via the worker", () => {
  it("completes a payment and sends an SMS receipt", async () => {
    const user = await newUser();
    await fund(user, pesos(1000));
    const bill = await api("POST", "/api/bills", { token: user.token, key: randomUUID(), body: { biller: "MERALCO", account_number: "123456789", amount_centavos: pesos(250) } });
    expect(bill.status).toBe(201);
    expect(bill.body.status).toBe("PENDING");
    expect(await balanceOf(user)).toBe(pesos(750));

    await waitForStatus(user, bill.body.id, "COMPLETED");

    const sms = await waitFor(async () => (await receipts(user.id)).find((r) => r.transfer_id === bill.body.id && r.channel === "SMS"), "SMS receipt");
    expect(sms.body).toContain("MERALCO");
    expect(sms.body).toContain("₱250.00");
    expect(await balanceOf(user)).toBe(pesos(750));
    expect((await reconcile()).status).toBe("BALANCED");
  });

  it("fails an account ending 0000 and returns the funds", async () => {
    const user = await newUser();
    await fund(user, pesos(1000));
    const bill = await api("POST", "/api/bills", { token: user.token, key: randomUUID(), body: { biller: "GLOBE", account_number: "5550000", amount_centavos: pesos(300) } });
    expect(bill.status).toBe(201);

    const failed = await waitForStatus(user, bill.body.id, "FAILED");

    expect(failed.failure_reason).toBeTruthy();
    expect(await balanceOf(user)).toBe(pesos(1000));
    const sms = await waitFor(async () => (await receipts(user.id)).find((r) => r.transfer_id === bill.body.id && r.channel === "SMS"), "SMS receipt");
    expect(sms.body).toContain("failed");
    expect((await reconcile()).status).toBe("BALANCED");
  });

  it("rejects a bill larger than the balance", async () => {
    const user = await newUser();
    const bill = await api("POST", "/api/bills", { token: user.token, key: randomUUID(), body: { biller: "MAYNILAD", account_number: "1112223", amount_centavos: pesos(1) } });
    expect(bill.status).toBe(422);
    expect(bill.body.error).toBe("INSUFFICIENT_FUNDS");
  });
});
