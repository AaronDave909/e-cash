import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, balanceOf, fund, newUser, pesos, send, wallet } from "./helpers";

describe("MPIN lockout", () => {
  it("locks after 3 wrong attempts, stays locked for the right MPIN, and recovers on unlock", async () => {
    const user = await newUser();
    const wrong = () => api("POST", "/api/auth/login", { body: { mobile: user.mobile, mpin: "9999" } });

    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(401);
    const third = await wrong();
    expect(third.status).toBe(423);
    expect(third.body.error).toBe("ACCOUNT_LOCKED");

    const right = await api("POST", "/api/auth/login", { body: { mobile: user.mobile, mpin: user.mpin } });
    expect(right.status).toBe(423);
    expect(right.body.error).toBe("ACCOUNT_LOCKED");

    const unlock = await api("POST", `/api/sim/users/${user.id}/unlock`);
    expect(unlock.status).toBe(200);
    const after = await api("POST", "/api/auth/login", { body: { mobile: user.mobile, mpin: user.mpin } });
    expect(after.status).toBe(200);
    expect(typeof after.body.token).toBe("string");
  });

  it("resets the failure counter after a successful login", async () => {
    const user = await newUser();
    const login = (mpin: string) => api("POST", "/api/auth/login", { body: { mobile: user.mobile, mpin } });
    expect((await login("0000")).status).toBe(401);
    expect((await login("0000")).status).toBe(401);
    expect((await login(user.mpin)).status).toBe(200);
    expect((await login("0000")).status).toBe(401);
    expect((await login("0000")).status).toBe(401);
    expect((await login(user.mpin)).status).toBe(200);
  });
});

describe("KYC monthly limits", () => {
  const FIFTY_K = pesos(50_000);
  const SIXTY_K = pesos(60_000);

  async function fundTo150k(tier: "BASIC" | "FULLY_VERIFIED") {
    const user = await newUser({ tier });
    if (tier === "BASIC") {
      // Basic cash-in is capped at 100,000 a month, so the rest arrives as a peer transfer.
      const rich = await newUser({ tier: "FULLY_VERIFIED" });
      await fund(user, pesos(100_000));
      await fund(rich, pesos(60_000));
      expect((await send(rich, user, FIFTY_K)).status).toBe(201);
    } else {
      await fund(user, pesos(150_000));
    }
    expect(await balanceOf(user)).toBe(pesos(150_000));
    return user;
  }

  it("rejects a Basic user's send that would cross 100,000 in the month", async () => {
    const user = await fundTo150k("BASIC");
    const peer = await newUser();

    expect((await send(user, peer, SIXTY_K)).status).toBe(201);
    const over = await send(user, peer, FIFTY_K);

    expect(over.status).toBe(422);
    expect(over.body.error).toBe("LIMIT_EXCEEDED");
    expect(await balanceOf(user)).toBe(pesos(90_000));
    const w = await wallet(user);
    expect(w.tier).toBe("BASIC");
    expect(w.month_out_centavos).toBe(SIXTY_K);
    expect(w.month_limit_centavos).toBe(pesos(100_000));
    // Money still inside the cap can be sent.
    expect((await send(user, peer, pesos(40_000))).status).toBe(201);
  });

  it("lets a Fully Verified user make the same send", async () => {
    const user = await fundTo150k("FULLY_VERIFIED");
    const peer = await newUser();

    expect((await send(user, peer, SIXTY_K)).status).toBe(201);
    expect((await send(user, peer, FIFTY_K)).status).toBe(201);
    expect(await balanceOf(user)).toBe(pesos(40_000));
    const w = await wallet(user);
    expect(w.tier).toBe("FULLY_VERIFIED");
    expect(w.month_limit_centavos).toBe(pesos(500_000));
  });

  it("fails a Basic cash-in that would take the month's cash-in past 100,000", async () => {
    const user = await newUser();
    await fund(user, pesos(100_000));
    const r = await api("POST", "/api/cash-in", { token: user.token, key: randomUUID(), body: { bank: "BPI", amount_centavos: pesos(1) } });
    expect(r.status).toBe(201);
    const settled = await (async () => {
      for (let i = 0; i < 100; i++) {
        const t = await api("GET", `/api/transfers/${r.body.id}`, { token: user.token });
        if (t.body.status !== "PENDING") return t.body;
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error("cash-in never settled");
    })();
    expect(settled.status).toBe("FAILED");
    expect(settled.failure_reason).toBe("LIMIT_EXCEEDED");
    expect(await balanceOf(user)).toBe(pesos(100_000));
  });
});
