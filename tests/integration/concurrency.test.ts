import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, balanceOf, fund, newUser, pesos, reconcile, send, type TestUser } from "./helpers";

async function totalOfAllWallets(): Promise<number> {
  const r = await api("GET", "/api/sim/users");
  return (r.body.users as Array<{ balance_centavos: number }>).reduce((s, u) => s + u.balance_centavos, 0);
}

describe("double-spend safety", () => {
  it("lets exactly 10 of 20 concurrent 100-peso sends from a 1,000-peso wallet succeed", async () => {
    const [sender, receiver] = await Promise.all([newUser(), newUser()]);
    await fund(sender, pesos(1000));

    const results = await Promise.all(Array.from({ length: 20 }, () => send(sender, receiver, pesos(100), randomUUID())));

    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    const rejected = results.filter((r) => r.status !== 201);
    expect(rejected).toHaveLength(10);
    for (const r of rejected) {
      expect(r.status).toBe(422);
      expect(r.body.error).toBe("INSUFFICIENT_FUNDS");
    }
    expect(await balanceOf(sender)).toBe(0);
    expect(await balanceOf(receiver)).toBe(pesos(1000));
    expect((await reconcile()).status).toBe("BALANCED");
  });

  it("lets exactly one of two simultaneous sends of 60% of the balance succeed", async () => {
    const [sender, a, b] = await Promise.all([newUser(), newUser(), newUser()]);
    await fund(sender, pesos(1000));

    const [r1, r2] = await Promise.all([send(sender, a, pesos(600)), send(sender, b, pesos(600))]);

    expect([r1.status, r2.status].sort()).toEqual([201, 422]);
    expect(await balanceOf(sender)).toBe(pesos(400));
    expect((await balanceOf(a)) + (await balanceOf(b))).toBe(pesos(600));
    expect((await reconcile()).status).toBe("BALANCED");
  });

  it("keeps total money constant across a 30-send burst between 5 users", async () => {
    const users: TestUser[] = await Promise.all(Array.from({ length: 5 }, () => newUser()));
    for (const u of users) await fund(u, pesos(1000));
    const totalBefore = await totalOfAllWallets();

    const plan = Array.from({ length: 30 }, (_, i) => {
      const from = i % 5;
      const to = (from + 1 + (i % 4)) % 5;
      return { from, to, amount: pesos(50 + ((i * 97) % 700)) };
    });
    const results = await Promise.all(plan.map((p) => send(users[p.from]!, users[p.to]!, p.amount, randomUUID())));

    const expected = users.map(() => pesos(1000));
    results.forEach((r, i) => {
      expect([201, 422]).toContain(r.status);
      if (r.status === 201) {
        expected[plan[i]!.from]! -= plan[i]!.amount;
        expected[plan[i]!.to]! += plan[i]!.amount;
      }
    });
    const balances = await Promise.all(users.map(balanceOf));

    expect(balances).toEqual(expected);
    expect(balances.every((b) => b >= 0)).toBe(true);
    expect(await totalOfAllWallets()).toBe(totalBefore);
    expect(balances.reduce((s, b) => s + b, 0)).toBe(pesos(5000));
    expect((await reconcile()).status).toBe("BALANCED");
  });
});
