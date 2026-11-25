import { randomUUID } from "node:crypto";
import {
  AppError,
  KYC_MONTHLY_LIMIT_CENTAVOS,
  METRIC,
  MONEY_EFFECTS,
  SIGNATURE_HEADER,
  amountCentavosSchema,
  bankSchema,
  bankClearingCode,
  billerCode,
  billerSchema,
  limitKinds,
  limitParam,
  mobileSchema,
  parse,
  verifyWebhook,
  walletCode,
  type Metrics,
  type Pool,
  type RailWebhookBody,
} from "@ecash/common";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Clients } from "./clients";
import { toDto, type HistoryRow } from "./dto";
import type { Engine, NewTransfer, TransferRow } from "./engine";
import { DYNAMIC_QR_TTL_MS, decodeQr, encodeQr } from "./qr";


export interface RouteDeps {
  app: FastifyInstance;
  pool: Pool;
  engine: Engine;
  clients: Clients;
  metrics: Metrics;
  qrSecret: string;
  railWebhookSecret: string;
}

const idempotencyKey = z.string().min(1).max(200);
const noteSchema = z.string().trim().max(140).optional();

const p2pBody = z.object({ to_mobile: mobileSchema, amount_centavos: amountCentavosSchema, note: noteSchema });
const cashBody = z.object({ bank: bankSchema, amount_centavos: amountCentavosSchema });
const billsBody = z.object({
  biller: billerSchema,
  account_number: z.string().regex(/^\d{4,20}$/, "account_number must be 4 to 20 digits"),
  amount_centavos: amountCentavosSchema,
});
const qrCreateBody = z.object({ amount_centavos: amountCentavosSchema.optional() });
const qrPayBody = z.object({ payload: z.string().min(10).max(2000), amount_centavos: amountCentavosSchema.optional() });
const limitQuery = z.object({ limit: limitParam(200, 50) });
const idParam = z.object({ id: z.string().uuid() });
const billResultBody = z.object({ success: z.boolean(), reason: z.string().max(200).optional() });
const railWebhookBody = z.object({
  reference: z.string().uuid(),
  status: z.enum(["COMPLETED", "FAILED"]),
  failure_reason: z.string().optional(),
});

function userIdOf(req: FastifyRequest): string {
  const id = req.headers["x-user-id"];
  const parsed = z.string().uuid().safeParse(Array.isArray(id) ? id[0] : id);
  if (!parsed.success) throw new AppError("UNAUTHORIZED", "missing user identity");
  return parsed.data;
}

function keyOf(req: FastifyRequest): string {
  const r = idempotencyKey.safeParse(req.headers["idempotency-key"]);
  if (!r.success) throw new AppError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  return r.data;
}

/** Failures the caller can act on synchronously come back as 422 with the transfer attached. */
const SYNC_REJECTIONS: ReadonlySet<string> = new Set(["INSUFFICIENT_FUNDS", "LIMIT_EXCEEDED"]);

export function registerRoutes(d: RouteDeps): void {
  const { app, pool, engine, clients } = d;

  const respond = (reply: import("fastify").FastifyReply, t: TransferRow, replay: boolean) => {
    if (replay) void reply.header("Idempotent-Replay", "true");
    if (t.status === "FAILED" && t.failure_reason && SYNC_REJECTIONS.has(t.failure_reason)) {
      return reply.code(422).send({ error: t.failure_reason, message: "the transfer was rejected", transfer: toDto(t) });
    }
    return reply.code(replay ? 200 : 201).send(toDto(t));
  };

  /** Creates (or replays) a transfer, then drives it one step toward settlement. */
  const submit = async (req: FastifyRequest, reply: import("fastify").FastifyReply, input: NewTransfer) => {
    const { transfer, replay } = await engine.create(input);
    const driven = !replay && transfer.status === "PENDING" ? await engine.drive(transfer).catch((err) => {
      req.log.warn({ err, transfer_id: transfer.id }, "drive failed; reconciler will retry");
      return transfer;
    }) : transfer;
    return respond(reply, driven, replay);
  };

  async function peerTransfer(req: FastifyRequest, type: "p2p" | "qr", recipient: { id: string; mobile: string; display_name: string }, amount: number, body: unknown, route: string, note?: string, claim?: NewTransfer["claim"]): Promise<NewTransfer> {
    const userId = userIdOf(req);
    if (recipient.id === userId) throw new AppError("SELF_TRANSFER", "you cannot send money to yourself");
    return {
      userId,
      type,
      idempotencyKey: keyOf(req),
      route,
      body,
      amountCentavos: amount,
      sourceAccount: walletCode(userId),
      destAccount: walletCode(recipient.id),
      counterparty: { user_id: recipient.id, mobile: recipient.mobile, display_name: recipient.display_name, ...(note ? { note } : {}) },
      claim,
    };
  }

  app.post("/transfers/p2p", async (req, reply) => {
    userIdOf(req);
    keyOf(req);
    const body = parse(p2pBody, req.body);
    const recipient = await clients.userByMobile(body.to_mobile);
    if (!recipient) throw new AppError("RECIPIENT_NOT_FOUND", "no E-Cash wallet is registered to that mobile number");
    return submit(req, reply, await peerTransfer(req, "p2p", recipient, body.amount_centavos, body, "POST /transfers/p2p", body.note));
  });

  app.post("/qr", async (req, reply) => {
    const userId = userIdOf(req);
    const mobile = String(req.headers["x-user-mobile"] ?? "");
    const { amount_centavos } = parse(qrCreateBody, req.body);
    const id = randomUUID();
    const expiresAt = amount_centavos ? new Date(Date.now() + DYNAMIC_QR_TTL_MS) : null;
    const payload = encodeQr(d.qrSecret, { qr: id, to: mobile, amt: amount_centavos ?? null, exp: expiresAt ? expiresAt.getTime() : null });
    await pool.query(
      "INSERT INTO qr_codes (id, owner_user_id, amount_centavos, payload, single_use, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, userId, amount_centavos ?? null, payload, amount_centavos !== undefined, expiresAt],
    );
    req.log.info({ qr_id: id, dynamic: amount_centavos !== undefined }, "qr created");
    return reply.code(201).send({
      qr_id: id,
      payload,
      amount_centavos: amount_centavos ?? null,
      single_use: amount_centavos !== undefined,
      expires_at: expiresAt?.toISOString() ?? null,
    });
  });

  app.post("/qr/pay", async (req, reply) => {
    userIdOf(req);
    keyOf(req);
    const body = parse(qrPayBody, req.body);
    const claims = decodeQr(d.qrSecret, body.payload);
    if (!claims) throw new AppError("QR_INVALID", "QR code signature is not valid");
    if (claims.exp !== null && claims.exp < Date.now()) throw new AppError("QR_EXPIRED", "this QR code has expired");
    const qr = (
      await pool.query<{ id: string; owner_user_id: string; amount_centavos: number | null; single_use: boolean }>(
        "SELECT id, owner_user_id, amount_centavos, single_use FROM qr_codes WHERE id = $1",
        [claims.qr],
      )
    ).rows[0];
    if (!qr) throw new AppError("QR_NOT_FOUND", "unknown QR code");
    let amount: number;
    if (qr.amount_centavos !== null) {
      if (body.amount_centavos !== undefined && body.amount_centavos !== qr.amount_centavos) {
        throw new AppError("AMOUNT_MISMATCH", "amount does not match the amount on the QR code");
      }
      amount = qr.amount_centavos;
    } else {
      if (body.amount_centavos === undefined) throw new AppError("VALIDATION_ERROR", "amount_centavos is required for a static QR code");
      amount = body.amount_centavos;
    }
    const owner = await clients.userById(qr.owner_user_id);
    const claim: NewTransfer["claim"] = async (c, transferId) => {
      if (!qr.single_use) return;
      const res = await c.query("UPDATE qr_codes SET paid_transfer_id = $2 WHERE id = $1 AND paid_transfer_id IS NULL", [qr.id, transferId]);
      if (res.rowCount === 0) throw new AppError("QR_ALREADY_PAID", "this QR code has already been paid");
    };
    const input = await peerTransfer(req, "qr", owner, amount, { payload: body.payload, amount_centavos: amount }, "POST /qr/pay", undefined, claim);
    input.counterparty = { ...input.counterparty, qr_id: qr.id };
    return submit(req, reply, input);
  });

  app.post("/cash-in", async (req, reply) => {
    const userId = userIdOf(req);
    keyOf(req);
    const body = parse(cashBody, req.body);
    return submit(req, reply, {
      userId,
      type: "cash_in",
      idempotencyKey: keyOf(req),
      route: "POST /cash-in",
      body,
      amountCentavos: body.amount_centavos,
      sourceAccount: bankClearingCode(body.bank),
      destAccount: walletCode(userId),
      counterparty: { bank: body.bank },
    });
  });

  app.post("/cash-out", async (req, reply) => {
    const userId = userIdOf(req);
    keyOf(req);
    const body = parse(cashBody, req.body);
    return submit(req, reply, {
      userId,
      type: "cash_out",
      idempotencyKey: keyOf(req),
      route: "POST /cash-out",
      body,
      amountCentavos: body.amount_centavos,
      sourceAccount: walletCode(userId),
      destAccount: bankClearingCode(body.bank),
      counterparty: { bank: body.bank },
    });
  });

  app.post("/bills", async (req, reply) => {
    const userId = userIdOf(req);
    keyOf(req);
    const body = parse(billsBody, req.body);
    return submit(req, reply, {
      userId,
      type: "bills",
      idempotencyKey: keyOf(req),
      route: "POST /bills",
      body,
      amountCentavos: body.amount_centavos,
      sourceAccount: walletCode(userId),
      destAccount: billerCode(body.biller),
      counterparty: { biller: body.biller, account_number: body.account_number },
    });
  });

  app.get("/transfers", async (req) => {
    const userId = userIdOf(req);
    const { limit } = parse(limitQuery, req.query);
    const { rows } = await pool.query<TransferRow>(
      "SELECT * FROM transfers WHERE user_id = $1 OR (dest_account = $2 AND type IN ('p2p','qr')) ORDER BY created_at DESC, id LIMIT $3",
      [userId, walletCode(userId), limit],
    );
    return { transfers: rows.map((t) => toDto(t, undefined, userId)) };
  });

  async function withHistory(t: TransferRow, viewerId?: string) {
    const h = await pool.query<HistoryRow>("SELECT from_status, to_status, reason, at FROM status_history WHERE transfer_id = $1 ORDER BY id", [t.id]);
    return toDto(t, h.rows, viewerId);
  }

  app.get<{ Params: { id: string } }>("/transfers/:id", async (req) => {
    const userId = userIdOf(req);
    const { id } = parse(idParam, req.params);
    const t = await engine.find(id);
    const visible = t && (t.user_id === userId || (t.dest_account === walletCode(userId) && (t.type === "p2p" || t.type === "qr")));
    if (!t || !visible) throw new AppError("TRANSFER_NOT_FOUND", "no such transfer");
    return withHistory(t, userId);
  });

  app.get("/wallet", async (req) => {
    const userId = userIdOf(req);
    const outgoing = MONEY_EFFECTS.p2p.onComplete!.limit!;
    const incoming = MONEY_EFFECTS.cash_in.onComplete!.limit!;
    const [user, balance, out, cashIn] = await Promise.all([
      clients.userById(userId),
      clients.balance(walletCode(userId)),
      clients.monthTotal(walletCode(userId), outgoing.direction, limitKinds(outgoing)),
      clients.monthTotal(walletCode(userId), incoming.direction, limitKinds(incoming)),
    ]);
    return {
      balance_centavos: balance,
      tier: user.kyc_tier,
      month_out_centavos: out,
      month_limit_centavos: KYC_MONTHLY_LIMIT_CENTAVOS[user.kyc_tier],
      month_cash_in_centavos: cashIn,
    };
  });

  // ---- internal -----------------------------------------------------------

  app.register(async (scope) => {
    // Signature is verified over the raw bytes, so this scope hands handlers the body unparsed.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));
    scope.post("/webhooks/bank-rail", async (req, reply) => {
      const raw = typeof req.body === "string" ? req.body : "";
      const header = req.headers[SIGNATURE_HEADER];
      if (!verifyWebhook(d.railWebhookSecret, Array.isArray(header) ? header[0] : header, raw)) {
        req.log.warn("rejected bank rail webhook: bad signature");
        throw new AppError("INVALID_SIGNATURE", "webhook signature is invalid or expired");
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new AppError("VALIDATION_ERROR", "webhook body is not valid JSON");
      }
      const body = parse(railWebhookBody, json) as Pick<RailWebhookBody, "reference" | "status" | "failure_reason">;
      const t = await engine.find(body.reference);
      if (!t) return reply.code(200).send({ ok: true, ignored: "unknown reference" });
      const next = await engine.apply(t.id, body.status === "COMPLETED" ? { kind: "complete" } : { kind: "fail", reason: body.failure_reason ?? "BANK_DECLINED" });
      const bank = String(t.counterparty?.["bank"] ?? "");
      if (t.status === "PENDING" && next.status !== "PENDING") {
        d.metrics.distribution(METRIC.BANK_RAIL_SETTLEMENT_MS, Date.now() - t.created_at.getTime(), { bank, outcome: next.status });
      }
      // The rail is the source of truth for money at the bank. A transfer that ended otherwise needs a human.
      const agrees = next.status === body.status || (body.status === "COMPLETED" && next.status === "REVERSED");
      if (!agrees) {
        d.metrics.increment(METRIC.BANK_RAIL_SETTLEMENT_CONFLICT, { bank, rail_status: body.status, transfer_status: next.status });
        req.log.error(
          { transfer_id: t.id, type: t.type, rail_status: body.status, transfer_status: next.status, failure_reason: next.failure_reason },
          "bank rail settlement contradicts the transfer",
        );
      }
      return reply.code(200).send({ ok: true, status: next.status });
    });
  });

  app.post<{ Params: { id: string } }>("/internal/bills/:id/result", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(billResultBody, req.body);
    const t = await engine.find(id);
    if (!t || t.type !== "bills") throw new AppError("TRANSFER_NOT_FOUND", "no such bill payment");
    const next = await engine.apply(id, body.success ? { kind: "complete" } : { kind: "fail", reason: body.reason ?? "BILLER_FAILED" });
    return toDto(next);
  });

  app.post<{ Params: { id: string } }>("/internal/transfers/:id/reverse", async (req) => {
    const { id } = parse(idParam, req.params);
    const next = await engine.apply(id, { kind: "reverse" });
    return toDto(next);
  });

  app.get("/internal/transfers/recent", async (req) => {
    const { limit } = parse(limitQuery, req.query);
    const { rows } = await pool.query<TransferRow>("SELECT * FROM transfers ORDER BY created_at DESC, id LIMIT $1", [limit]);
    const hist = await pool.query<HistoryRow & { transfer_id: string }>(
      "SELECT transfer_id, from_status, to_status, reason, at FROM status_history WHERE transfer_id = ANY($1) ORDER BY id",
      [rows.map((r) => r.id)],
    );
    const byTransfer = new Map<string, HistoryRow[]>();
    for (const h of hist.rows) byTransfer.set(h.transfer_id, [...(byTransfer.get(h.transfer_id) ?? []), h]);
    return { transfers: rows.map((t) => toDto(t, byTransfer.get(t.id) ?? [])) };
  });
}
