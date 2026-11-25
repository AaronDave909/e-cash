import { describe, expect, it } from "vitest";
import { api, newUser, fund, pesos, send } from "./helpers";

describe("system and simulator routes", () => {
  it("reports health for every service plus Postgres and Redis", async () => {
    const r = await api("GET", "/api/system/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(Object.keys(r.body.services).sort()).toEqual(["api-gateway", "auth-kyc", "bank-rail", "ledger", "postgres", "redis", "transfer", "worker"]);
    expect(r.body.services.postgres.status).toBe("ok");
    expect(r.body.services.redis.status).toBe("ok");
  });

  it("lists users with balances and activity with status history", async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    await fund(a, pesos(100));
    await send(a, b, pesos(40));
    const users = await api("GET", "/api/sim/users");
    const mine = users.body.users.find((u: any) => u.id === a.id);
    expect(mine.balance_centavos).toBe(pesos(60));
    expect(mine.locked).toBe(false);
    const activity = await api("GET", "/api/sim/activity?limit=10");
    const p2p = activity.body.transfers.find((t: any) => t.type === "p2p" && t.user_id === a.id);
    expect(p2p.status_history.map((h: any) => h.to_status)).toEqual(["PENDING", "COMPLETED"]);
    expect(p2p.user.mobile).toBe(a.mobile);
    const journals = await api("GET", "/api/system/journals?limit=5");
    expect(journals.body.journals.length).toBeGreaterThan(0);
    expect(journals.body.journals[0].postings.length).toBeGreaterThanOrEqual(2);
  });

  it("answers CORS preflight and echoes correlation ids", async () => {
    const res = await fetch(`${(await import("./helpers")).stack.gateway}/api/wallet`, { method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("returns 401 for protected routes without a token", async () => {
    expect((await api("GET", "/api/wallet")).status).toBe(401);
    expect((await api("GET", "/api/wallet", { token: "garbage" })).status).toBe(401);
  });
});
