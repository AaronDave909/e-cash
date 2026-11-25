import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { requestContext } from "./context";
import { AppError } from "./errors";

export interface ServiceOptions {
  name: string;
  /** Extra readiness check run by GET /health. */
  ready?: () => Promise<void>;
}

/** Parses untrusted input at the HTTP boundary. Everything after this point trusts the types. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw zodToAppError(r.error);
  return r.data;
}

function zodToAppError(err: ZodError): AppError {
  const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  const first = issues[0];
  const msg = first ? (first.path ? `${first.path}: ${first.message}` : first.message) : "invalid request";
  return new AppError("VALIDATION_ERROR", msg, { issues });
}

export function createService(opts: ServiceOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
      base: { service: opts.name },
    },
    requestIdHeader: "x-correlation-id",
    requestIdLogLabel: "correlation_id",
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  // JSON bodies may be empty on POSTs that carry no fields (unlock, reverse).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new AppError("VALIDATION_ERROR", "request body is not valid JSON"), undefined);
    }
  });

  app.addHook("onRequest", (req, reply, done) => {
    reply.header("x-correlation-id", req.id);
    requestContext.run({ correlationId: req.id }, done);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      void reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
      return;
    }
    if (err instanceof ZodError) {
      const e = zodToAppError(err);
      void reply.code(e.status).send({ error: e.code, message: e.message, ...e.extra });
      return;
    }
    const fe = err as { statusCode?: number; message?: string; code?: string };
    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      void reply.code(fe.statusCode).send({ error: fe.statusCode === 400 ? "VALIDATION_ERROR" : "BAD_REQUEST", message: fe.message });
      return;
    }
    req.log.error({ err }, "unhandled error");
    void reply.code(500).send({ error: "INTERNAL", message: "internal error" });
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: "NOT_FOUND", message: "route not found" });
  });

  app.get("/health", async (_req, reply) => {
    try {
      await opts.ready?.();
      return { status: "ok", service: opts.name };
    } catch (err) {
      void reply.code(503);
      return { status: "unavailable", service: opts.name, message: (err as Error).message };
    }
  });

  return app;
}

/** Starts listening and closes the app (and its onClose hooks) on SIGTERM/SIGINT. */
export async function listen(app: FastifyInstance, port: number): Promise<void> {
  await app.listen({ port, host: "0.0.0.0" });
  const shutdown = (): void => {
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
