import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  AppError,
  KYC_TIERS,
  METRIC,
  createMetrics,
  createPool,
  createService,
  databaseUrl,
  envBool,
  envSecret,
  envStr,
  migrate,
  mobileSchema,
  parse,
  parseMobile,
  signToken,
  withTx,
  type KycTier,
  type Pool,
} from "@ecash/common";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MIGRATIONS, SCHEMA } from "./migrations";
import { hashMpin, verifyMpin } from "./mpin";

const MAX_FAILED_ATTEMPTS = 3;
const OTP_TTL_S = 300;
/** Wrong guesses one OTP survives; the next guess, right or wrong, is refused and a new code is needed. */
const MAX_OTP_ATTEMPTS = 5;

const mpinSchema = z.string().regex(/^\d{4,6}$/, "mpin must be 4 to 6 digits");
const registerBody = z.object({ mobile: mobileSchema, display_name: z.string().trim().min(1).max(80) });
const verifyBody = z.object({ mobile: mobileSchema, otp: z.string().regex(/^\d{6}$/, "otp must be 6 digits"), mpin: mpinSchema });
const loginBody = z.object({ mobile: mobileSchema, mpin: mpinSchema });
const kycBody = z.object({ tier: z.enum(KYC_TIERS) });
const idParam = z.object({ id: z.string().uuid() });

interface UserRow {
  id: string;
  mobile: string;
  display_name: string;
  kyc_tier: KycTier;
  mpin_hash: string | null;
  mpin_salt: string | null;
  failed_mpin_attempts: number;
  locked_at: Date | null;
  persona: string | null;
  created_at: Date;
}

function userView(u: UserRow) {
  return {
    id: u.id,
    mobile: u.mobile,
    display_name: u.display_name,
    kyc_tier: u.kyc_tier,
    locked: u.locked_at !== null,
    failed_mpin_attempts: u.failed_mpin_attempts,
    persona: u.persona,
    created_at: u.created_at.toISOString(),
  };
}

const hashOtp = (mobile: string, code: string): string => createHash("sha256").update(`${mobile}:${code}`).digest("hex");

export async function buildApp(): Promise<{ app: FastifyInstance; pool: Pool }> {
  const pool = createPool(databaseUrl(), SCHEMA);
  await migrate(pool, SCHEMA, MIGRATIONS);
  const metrics = createMetrics("ecash-auth-kyc");
  const jwtSecret = envSecret("JWT_SECRET");
  const exposeOtp = envBool("ECASH_EXPOSE_OTP");
  const app = createService({ name: "ecash-auth-kyc", ready: async () => void (await pool.query("SELECT 1")) });

  const findById = async (id: string): Promise<UserRow | null> =>
    (await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id])).rows[0] ?? null;

  app.post("/auth/register", async (req, reply) => {
    const { mobile, display_name } = parse(registerBody, req.body);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await withTx(pool, async (c) => {
      const existing = (await c.query<UserRow>("SELECT * FROM users WHERE mobile = $1 FOR UPDATE", [mobile])).rows[0];
      if (existing?.mpin_hash) throw new AppError("MOBILE_ALREADY_REGISTERED", "this mobile number is already registered");
      if (existing) await c.query("UPDATE users SET display_name = $2 WHERE id = $1", [existing.id, display_name]);
      else await c.query("INSERT INTO users (id, mobile, display_name) VALUES ($1, $2, $3)", [randomUUID(), mobile, display_name]);
      await c.query("INSERT INTO otps (mobile, code_hash, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))", [
        mobile,
        hashOtp(mobile, code),
        OTP_TTL_S,
      ]);
    });
    // Logs reach Datadog, so the code goes in them only where it is already in the response (dev).
    if (exposeOtp) req.log.info({ mobile }, `simulated SMS to ${mobile}: your E-Cash code is ${code}`);
    else req.log.info({ mobile }, `simulated SMS with a sign-up code sent to ${mobile}`);
    return reply.code(201).send({ mobile, expires_in_s: OTP_TTL_S, ...(exposeOtp ? { dev_otp: code } : {}) });
  });

  app.post("/auth/verify-otp", async (req) => {
    const { mobile, otp, mpin } = parse(verifyBody, req.body);
    const secret = await hashMpin(mpin);
    // A wrong guess returns null instead of throwing, so its counter increment commits.
    const user = await withTx(pool, async (c) => {
      const row = (
        await c.query<{ id: number; code_hash: string; expires_at: Date; failed_attempts: number }>(
          "SELECT id, code_hash, expires_at, failed_attempts FROM otps WHERE mobile = $1 AND consumed_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE",
          [mobile],
        )
      ).rows[0];
      if (!row || row.expires_at.getTime() < Date.now() || row.failed_attempts >= MAX_OTP_ATTEMPTS) return null;
      if (row.code_hash !== hashOtp(mobile, otp)) {
        // The row lock serializes concurrent guesses, so the cap holds under a burst.
        await c.query("UPDATE otps SET failed_attempts = failed_attempts + 1 WHERE id = $1", [row.id]);
        return null;
      }
      const u = (await c.query<UserRow>("SELECT * FROM users WHERE mobile = $1 FOR UPDATE", [mobile])).rows[0];
      if (!u) throw new AppError("USER_NOT_FOUND", "register first");
      if (u.mpin_hash) throw new AppError("MOBILE_ALREADY_REGISTERED", "this mobile number is already registered");
      await c.query("UPDATE otps SET consumed_at = now() WHERE id = $1", [row.id]);
      return (
        await c.query<UserRow>("UPDATE users SET mpin_hash = $2, mpin_salt = $3 WHERE id = $1 RETURNING *", [u.id, secret.hash, secret.salt])
      ).rows[0]!;
    });
    if (!user) throw new AppError("INVALID_OTP", "the code is wrong or has expired; after 5 wrong codes, register again for a new one");
    return { token: signToken(jwtSecret, { sub: user.id, mobile: user.mobile, tier: user.kyc_tier }), user: userView(user) };
  });

  app.post("/auth/login", async (req) => {
    const { mobile, mpin } = parse(loginBody, req.body);
    const user = (await pool.query<UserRow>("SELECT * FROM users WHERE mobile = $1", [mobile])).rows[0];
    if (!user?.mpin_hash || !user.mpin_salt) throw new AppError("INVALID_CREDENTIALS", "mobile number or MPIN is incorrect");
    if (user.locked_at) throw new AppError("ACCOUNT_LOCKED", "account is locked after too many wrong MPIN attempts");

    if (await verifyMpin(mpin, user.mpin_hash, user.mpin_salt)) {
      const ok = await pool.query("UPDATE users SET failed_mpin_attempts = 0 WHERE id = $1 AND locked_at IS NULL", [user.id]);
      if (ok.rowCount === 0) throw new AppError("ACCOUNT_LOCKED", "account is locked after too many wrong MPIN attempts");
      req.log.info({ user_id: user.id }, "login succeeded");
      return { token: signToken(jwtSecret, { sub: user.id, mobile: user.mobile, tier: user.kyc_tier }), user: userView(user) };
    }

    // One statement increments and locks, so concurrent wrong guesses cannot slip past the limit.
    const failed = await pool.query<{ failed_mpin_attempts: number; locked_at: Date | null }>(
      `UPDATE users SET failed_mpin_attempts = failed_mpin_attempts + 1,
                        locked_at = CASE WHEN failed_mpin_attempts + 1 >= $2 THEN now() END
        WHERE id = $1 AND locked_at IS NULL RETURNING failed_mpin_attempts, locked_at`,
      [user.id, MAX_FAILED_ATTEMPTS],
    );
    metrics.increment(METRIC.MPIN_FAILED);
    const after = failed.rows[0];
    req.log.warn({ user_id: user.id, failed_attempts: after?.failed_mpin_attempts ?? null }, "wrong MPIN");
    if (!after || after.locked_at) throw new AppError("ACCOUNT_LOCKED", "account is locked after too many wrong MPIN attempts");
    throw new AppError("INVALID_CREDENTIALS", "mobile number or MPIN is incorrect", {
      attempts_remaining: MAX_FAILED_ATTEMPTS - after.failed_mpin_attempts,
    });
  });

  app.post<{ Params: { id: string } }>("/auth/users/:id/unlock", async (req) => {
    const { id } = parse(idParam, req.params);
    const { rows } = await pool.query<UserRow>("UPDATE users SET failed_mpin_attempts = 0, locked_at = NULL WHERE id = $1 RETURNING *", [id]);
    if (!rows[0]) throw new AppError("USER_NOT_FOUND", "no such user");
    req.log.info({ user_id: id }, "account unlocked");
    return { user: userView(rows[0]) };
  });

  app.post<{ Params: { id: string } }>("/auth/users/:id/kyc", async (req) => {
    const { id } = parse(idParam, req.params);
    const { tier } = parse(kycBody, req.body);
    const { rows } = await pool.query<UserRow>("UPDATE users SET kyc_tier = $2 WHERE id = $1 RETURNING *", [id, tier]);
    if (!rows[0]) throw new AppError("USER_NOT_FOUND", "no such user");
    req.log.info({ user_id: id, tier }, "kyc tier changed");
    return { user: userView(rows[0]) };
  });

  // Internal reads
  app.get<{ Params: { mobile: string } }>("/users/by-mobile/:mobile", async (req) => {
    const mobile = parseMobile(req.params.mobile);
    const u = mobile ? (await pool.query<UserRow>("SELECT * FROM users WHERE mobile = $1 AND mpin_hash IS NOT NULL", [mobile])).rows[0] : undefined;
    if (!u) throw new AppError("USER_NOT_FOUND", "no such user");
    return userView(u);
  });

  app.get<{ Params: { id: string } }>("/users/:id", async (req) => {
    const idOk = z.string().uuid().safeParse(req.params.id);
    const u = idOk.success ? await findById(idOk.data) : null;
    if (!u) throw new AppError("USER_NOT_FOUND", "no such user");
    return userView(u);
  });

  app.get("/users", async () => {
    const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE mpin_hash IS NOT NULL ORDER BY created_at DESC LIMIT 500");
    return { users: rows.map(userView) };
  });

  app.addHook("onClose", async () => {
    metrics.close();
    await pool.end();
  });
  return { app, pool };
}
