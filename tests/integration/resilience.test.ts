import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { api, fund, newUser, pesos, sleep, stack, waitFor, waitForStatus } from "./helpers";

const ROOT = path.resolve(__dirname, "../..");

async function redisUp(url: string): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  r.on("error", () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}

describe("worker after Redis loses the stream", () => {
  it("settles a bill after Redis restarts empty, without restarting the worker", async () => {
    const user = await newUser();
    await fund(user, pesos(1000));

    const killer = new Redis(stack.redisUrl);
    killer.on("error", () => undefined);
    await killer.call("SHUTDOWN", "NOSAVE").catch(() => undefined);
    killer.disconnect();
    await waitFor(async () => !(await redisUp(stack.redisUrl)), "redis to stop");
    await sleep(1500);

    execFileSync("bash", [path.join(ROOT, "scripts/dev-infra.sh"), "start"], {
      env: { ...process.env, ECASH_PG_PORT: new URL(stack.databaseUrl).port, ECASH_REDIS_PORT: new URL(stack.redisUrl).port },
      stdio: "ignore",
    });
    await waitFor(() => redisUp(stack.redisUrl), "redis to start");

    const bill = await api("POST", "/api/bills", { token: user.token, key: randomUUID(), body: { biller: "MERALCO", account_number: "123456789", amount_centavos: pesos(250) } });
    expect(bill.status).toBe(201);
    await waitForStatus(user, bill.body.id, "COMPLETED", 20_000);
  });
});
