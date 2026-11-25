import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, balanceOf, fund, newUser, pesos, reconcile, send, waitFor } from "./helpers";

const payQr = (payer: { token: string }, payload: string, amount?: number, key = randomUUID()) =>
  api("POST", "/api/qr/pay", { token: payer.token, key, body: { payload, ...(amount ? { amount_centavos: amount } : {}) } });

describe("QR payments", () => {
  it("pays a dynamic QR once and rejects a second payment with a new key", async () => {
    const [merchant, payer1, payer2] = await Promise.all([newUser(), newUser(), newUser()]);
    await Promise.all([fund(payer1, pesos(1000)), fund(payer2, pesos(1000))]);
    const qr = await api("POST", "/api/qr", { token: merchant.token, body: { amount_centavos: pesos(200) } });
    expect(qr.status).toBe(201);
    expect(qr.body.payload.startsWith("ECASH1.")).toBe(true);

    const key = randomUUID();
    const paid = await payQr(payer1, qr.body.payload, undefined, key);
    expect(paid.status).toBe(201);
    expect(paid.body.type).toBe("qr");
    expect(paid.body.status).toBe("COMPLETED");
    expect(await balanceOf(merchant)).toBe(pesos(200));

    const second = await payQr(payer2, qr.body.payload);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("QR_ALREADY_PAID");
    const sameUserNewKey = await payQr(payer1, qr.body.payload);
    expect(sameUserNewKey.status).toBe(409);

    // The same key replays the original payment instead of being a second attempt.
    const replay = await payQr(payer1, qr.body.payload, undefined, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replay")).toBe("true");

    expect(await balanceOf(merchant)).toBe(pesos(200));
    expect(await balanceOf(payer1)).toBe(pesos(800));
    expect(await balanceOf(payer2)).toBe(pesos(1000));
    expect((await reconcile()).status).toBe("BALANCED");
  });

  it("lets only one of many simultaneous payers pay a dynamic QR", async () => {
    const [merchant, ...payers] = await Promise.all(Array.from({ length: 6 }, () => newUser()));
    await Promise.all(payers.map((p) => fund(p, pesos(500))));
    const qr = await api("POST", "/api/qr", { token: merchant!.token, body: { amount_centavos: pesos(100) } });
    const results = await Promise.all(payers.map((p) => payQr(p, qr.body.payload)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(payers.length - 1);
    expect(await balanceOf(merchant!)).toBe(pesos(100));
  });

  it("accepts repeated payments to a static QR with the payer's amount", async () => {
    const [merchant, payer] = await Promise.all([newUser(), newUser()]);
    await fund(payer, pesos(1000));
    const qr = await api("POST", "/api/qr", { token: merchant.token, body: {} });
    expect(qr.status).toBe(201);
    expect(qr.body.single_use).toBe(false);
    expect((await payQr(payer, qr.body.payload, pesos(100))).status).toBe(201);
    expect((await payQr(payer, qr.body.payload, pesos(150))).status).toBe(201);
    expect((await payQr(payer, qr.body.payload)).status).toBe(400); // static QR needs an amount
    expect(await balanceOf(merchant)).toBe(pesos(250));
  });

  it("rejects a tampered payload and a mismatched amount, and refuses self-payment", async () => {
    const [merchant, payer] = await Promise.all([newUser(), newUser()]);
    await fund(payer, pesos(1000));
    const qr = await api("POST", "/api/qr", { token: merchant.token, body: { amount_centavos: pesos(50) } });
    const [prefix, body, sig] = qr.body.payload.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), amt: 1 })).toString("base64url");

    const tampered = await payQr(payer, `${prefix}.${forgedBody}.${sig}`);
    expect(tampered.status).toBe(400);
    expect(tampered.body.error).toBe("QR_INVALID");
    const mismatch = await payQr(payer, qr.body.payload, pesos(999));
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error).toBe("AMOUNT_MISMATCH");
    const self = await payQr(merchant, qr.body.payload);
    expect(self.status).toBe(422);
    expect(self.body.error).toBe("SELF_TRANSFER");
    // Nothing above consumed the QR.
    expect((await payQr(payer, qr.body.payload)).status).toBe(201);
  });

  it("releases a dynamic QR when its payment is rejected for insufficient funds", async () => {
    const [merchant, poor, rich] = await Promise.all([newUser(), newUser(), newUser()]);
    await fund(rich, pesos(500));
    const qr = await api("POST", "/api/qr", { token: merchant.token, body: { amount_centavos: pesos(100) } });
    const failed = await payQr(poor, qr.body.payload);
    expect(failed.status).toBe(422);
    expect(failed.body.error).toBe("INSUFFICIENT_FUNDS");
    expect((await payQr(rich, qr.body.payload)).status).toBe(201);
  });
});

describe("reversal", () => {
  it("moves COMPLETED to REVERSED, restores balances, and keeps the ledger balanced", async () => {
    const [alice, bob] = await Promise.all([newUser(), newUser()]);
    await fund(alice, pesos(1000));
    const sent = await send(alice, bob, pesos(300));
    expect(sent.status).toBe(201);
    expect(await balanceOf(alice)).toBe(pesos(700));
    expect(await balanceOf(bob)).toBe(pesos(300));

    const rev = await api("POST", `/api/sim/transfers/${sent.body.id}/reverse`);
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe("REVERSED");

    expect(await balanceOf(alice)).toBe(pesos(1000));
    expect(await balanceOf(bob)).toBe(0);
    const t = await api("GET", `/api/transfers/${sent.body.id}`, { token: alice.token });
    expect(t.body.status_history.map((h: any) => h.to_status)).toEqual(["PENDING", "COMPLETED", "REVERSED"]);
    expect((await reconcile()).status).toBe("BALANCED");

    const again = await api("POST", `/api/sim/transfers/${sent.body.id}/reverse`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("ILLEGAL_TRANSITION");
    expect(await balanceOf(alice)).toBe(pesos(1000));
  });

  it("refuses to reverse when the recipient has already spent the money", async () => {
    const [alice, bob, carol] = await Promise.all([newUser(), newUser(), newUser()]);
    await fund(alice, pesos(500));
    const sent = await send(alice, bob, pesos(500));
    expect((await send(bob, carol, pesos(400))).status).toBe(201);

    const rev = await api("POST", `/api/sim/transfers/${sent.body.id}/reverse`);
    expect(rev.status).toBe(422);
    expect(rev.body.error).toBe("NOT_REVERSIBLE");
    expect(await balanceOf(bob)).toBe(pesos(100));
    const t = await waitFor(async () => (await api("GET", `/api/transfers/${sent.body.id}`, { token: alice.token })).body, "transfer");
    expect(t.status).toBe("COMPLETED");
  });

  it("reverses a cash-in", async () => {
    const user = await newUser();
    await fund(user, pesos(250));
    const hist = await api("GET", "/api/transfers?limit=5", { token: user.token });
    const cashIn = hist.body.transfers.find((t: any) => t.type === "cash_in");
    const rev = await api("POST", `/api/sim/transfers/${cashIn.id}/reverse`);
    expect(rev.status).toBe(200);
    expect(await balanceOf(user)).toBe(0);
    expect((await reconcile()).status).toBe("BALANCED");
  });
});
