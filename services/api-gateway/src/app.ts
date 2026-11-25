import {
  AppError,
  callJson,
  createPool,
  createRedis,
  createService,
  databaseUrl,
  envInt,
  envStr,
  parse,
  redisUrl,
  serviceUrls,
  verifyToken,
  type JsonResponse,
  type TokenClaims,
} from "@ecash/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { hit } from "./rate-limit";
import { isInternalOnly, matchRoute, requiresIdempotencyKey } from "./routes-table";

const FORWARDED_RESPONSE_HEADERS = ["idempotent-replay", "retry-after"] as const;

export async function buildApp(): Promise<FastifyInstance> {
  const urls = serviceUrls();
  const jwtSecret = envStr("JWT_SECRET");
  const rateMax = envInt("RATE_LIMIT_MAX", 120);
  const rateWindowS = envInt("RATE_LIMIT_WINDOW_S", 10);
  const redis = createRedis(redisUrl(), "ecash-gateway");
  const pg = createPool(databaseUrl(), "public");
  pg.options.connectionTimeoutMillis = 1000;
  pg.options.max = 2;
  const app = createService({ name: "ecash-api-gateway", ready: async () => void (await redis.ping()) });

  // Browsers on another origin (the Vite dev server) need CORS; Compose and the dev proxy are same-origin.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin) return;
    void reply
      .header("access-control-allow-origin", origin)
      .header("access-control-allow-headers", "authorization, content-type, idempotency-key, x-correlation-id")
      .header("access-control-allow-methods", "GET, POST, PUT, OPTIONS")
      .header("access-control-expose-headers", "idempotent-replay, x-correlation-id, retry-after")
      .header("vary", "origin");
    if (req.method === "OPTIONS") return reply.code(204).send();
  });

  const send = (reply: FastifyReply, res: JsonResponse): FastifyReply => {
    for (const h of FORWARDED_RESPONSE_HEADERS) {
      const v = res.headers[h];
      if (typeof v === "string") void reply.header(h, v);
    }
    return reply.code(res.status).send(res.body ?? {});
  };

  const limit = async (scope: string, id: string, reply: FastifyReply): Promise<void> => {
    const r = await hit(redis, scope, id, rateMax, rateWindowS);
    if (!r.allowed) {
      void reply.header("retry-after", String(r.retryAfterS));
      throw new AppError("RATE_LIMITED", "too many requests; slow down");
    }
  };

  const bearer = (req: FastifyRequest): TokenClaims => {
    const h = req.headers.authorization;
    if (!h?.startsWith("Bearer ")) throw new AppError("UNAUTHORIZED", "missing bearer token");
    return verifyToken(jwtSecret, h.slice(7));
  };

  // ---- proxied public API -------------------------------------------------

  app.all("/api/*", async (req, reply) => {
    const [path = "", query = ""] = req.url.split("?", 2) as [string, string?];
    const route = matchRoute(path);
    if (!route || isInternalOnly(path)) throw new AppError("NOT_FOUND", "route not found");

    const headers: Record<string, string> = {};
    if (route.jwt) {
      const claims = bearer(req);
      await limit("user", claims.sub, reply);
      headers["x-user-id"] = claims.sub;
      headers["x-user-mobile"] = claims.mobile;
      headers["x-user-tier"] = claims.tier;
    } else {
      await limit("ip", req.ip, reply);
    }

    if (requiresIdempotencyKey(req.method, path) && !req.headers["idempotency-key"]) {
      throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required for this request");
    }
    const key = req.headers["idempotency-key"];
    if (typeof key === "string") headers["idempotency-key"] = key;

    const target = `${urls[route.upstream === "auth" ? "auth" : "transfer"]}${route.rewrite}${path.slice(route.prefix.length)}${query ? `?${query}` : ""}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const res = await callJson(target, { method: req.method, headers, body: hasBody ? (req.body ?? {}) : undefined });
    return send(reply, res);
  });

  // ---- simulator routes (no JWT; the Users tab) ---------------------------

  const idParam = z.object({ id: z.string().uuid() });
  const upstream = async (reply: FastifyReply, url: string, method = "GET", body?: unknown) =>
    send(reply, await callJson(url, { method, body }));

  app.get("/api/sim/users", async (req, reply) => {
    await limit("ip", req.ip, reply);
    const [users, balances] = await Promise.all([
      callJson<{ users: Array<{ id: string }> }>(`${urls.auth}/users`),
      callJson<{ balances: Record<string, number> }>(`${urls.ledger}/balances?prefix=wallet:`),
    ]);
    if (users.status !== 200 || balances.status !== 200) throw new AppError("UPSTREAM_UNAVAILABLE", "auth or ledger unavailable");
    return {
      users: users.body.users.map((u) => ({ ...u, balance_centavos: balances.body.balances[`wallet:${u.id}`] ?? 0 })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/sim/users/:id/unlock", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return upstream(reply, `${urls.auth}/auth/users/${id}/unlock`, "POST", {});
  });

  app.post<{ Params: { id: string } }>("/api/sim/users/:id/kyc", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return upstream(reply, `${urls.auth}/auth/users/${id}/kyc`, "POST", req.body ?? {});
  });

  app.get("/api/sim/chaos", async (_req, reply) => upstream(reply, `${urls.bankRail}/rail/chaos`));
  app.put("/api/sim/chaos", async (req, reply) => upstream(reply, `${urls.bankRail}/rail/chaos`, "PUT", req.body ?? {}));

  app.get("/api/sim/activity", async (req) => {
    const limitQ = z.coerce.number().int().min(1).max(200).catch(50).parse((req.query as { limit?: string }).limit);
    const [recent, users] = await Promise.all([
      callJson<{ transfers: Array<{ user_id: string }> }>(`${urls.transfer}/internal/transfers/recent?limit=${limitQ}`),
      callJson<{ users: Array<{ id: string; mobile: string; display_name: string }> }>(`${urls.auth}/users`),
    ]);
    if (recent.status !== 200 || users.status !== 200) throw new AppError("UPSTREAM_UNAVAILABLE", "transfer or auth unavailable");
    const byId = new Map(users.body.users.map((u) => [u.id, u]));
    return {
      transfers: recent.body.transfers.map((t) => {
        const u = byId.get(t.user_id);
        return { ...t, user: u ? { mobile: u.mobile, display_name: u.display_name } : null };
      }),
    };
  });

  app.get("/api/sim/receipts", async (req, reply) => {
    const q = parse(z.object({ user_id: z.string().uuid() }), req.query);
    return upstream(reply, `${urls.worker}/receipts?user_id=${q.user_id}`);
  });

  app.post<{ Params: { id: string } }>("/api/sim/transfers/:id/reverse", async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return upstream(reply, `${urls.transfer}/internal/transfers/${id}/reverse`, "POST", {});
  });

  // ---- system routes ------------------------------------------------------

  app.get("/api/system/health", async () => {
    const probe = async (url: string) => {
      const started = Date.now();
      try {
        const r = await callJson(`${url}/health`, { timeoutMs: 1000 });
        return { status: r.status === 200 ? "ok" : "down", latency_ms: Date.now() - started };
      } catch {
        return { status: "down", latency_ms: Date.now() - started };
      }
    };
    const timed = async (fn: () => Promise<unknown>) => {
      const started = Date.now();
      try {
        await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1000))]);
        return { status: "ok", latency_ms: Date.now() - started };
      } catch {
        return { status: "down", latency_ms: Date.now() - started };
      }
    };
    const [auth, ledger, transfer, bankRail, worker, postgres, redisStatus] = await Promise.all([
      probe(urls.auth),
      probe(urls.ledger),
      probe(urls.transfer),
      probe(urls.bankRail),
      probe(urls.worker),
      timed(() => pg.query("SELECT 1")),
      timed(() => redis.ping()),
    ]);
    const services = {
      "api-gateway": { status: "ok", latency_ms: 0 },
      "auth-kyc": auth,
      ledger,
      transfer,
      "bank-rail": bankRail,
      worker,
    };
    const all = [...Object.values(services), postgres, redisStatus];
    return { status: all.every((s) => s.status === "ok") ? "ok" : "degraded", services, postgres, redis: redisStatus };
  });

  app.get("/api/system/journals", async (req, reply) => {
    const limitQ = z.coerce.number().int().min(1).max(500).catch(50).parse((req.query as { limit?: string }).limit);
    return upstream(reply, `${urls.ledger}/journals/recent?limit=${limitQ}`);
  });
  app.get("/api/system/reconcile", async (_req, reply) => upstream(reply, `${urls.ledger}/reconcile`));

  app.addHook("onClose", async () => {
    redis.disconnect();
    await pg.end();
  });
  return app;
}
