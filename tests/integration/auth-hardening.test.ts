import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { api, newMobile, stack, startExtraService } from "./helpers";

const wrongCode = (right: string, i: number): string => String((Number(right) + 1 + i) % 1_000_000).padStart(6, "0");

describe("OTP attempts", () => {
  it("invalidate the code after 5 wrong guesses", async () => {
    const register = async () => {
      const mobile = newMobile();
      const reg = await api("POST", "/api/auth/register", { body: { mobile, display_name: "Otp Probe" } });
      expect(reg.status).toBe(201);
      return { mobile, otp: reg.body.dev_otp as string };
    };
    const guess = (mobile: string, otp: string) => api("POST", "/api/auth/verify-otp", { body: { mobile, otp, mpin: "1234" } });

    const capped = await register();
    for (let i = 0; i < 5; i++) expect((await guess(capped.mobile, wrongCode(capped.otp, i))).status).toBe(400);
    const late = await guess(capped.mobile, capped.otp);
    expect([late.status, late.body.error]).toEqual([400, "INVALID_OTP"]);

    // Concurrent wrong guesses cannot slip past the cap either.
    const raced = await register();
    await Promise.all(Array.from({ length: 12 }, (_, i) => guess(raced.mobile, wrongCode(raced.otp, i))));
    expect((await guess(raced.mobile, raced.otp)).status).toBe(400);

    const control = await register();
    for (let i = 0; i < 4; i++) await guess(control.mobile, wrongCode(control.otp, i));
    expect((await guess(control.mobile, control.otp)).status).toBe(200);
  });
});

describe("OTP in logs", () => {
  it("is not written when ECASH_EXPOSE_OTP is off", async () => {
    const auth = await startExtraService("auth-kyc", { ECASH_EXPOSE_OTP: "false" });
    const db = new pg.Client({ connectionString: stack.databaseUrl });
    await db.connect();
    try {
      const mobile = newMobile();
      const reg = await api("POST", "/auth/register", { base: auth.url, body: { mobile, display_name: "Quiet" } });
      expect(reg.status).toBe(201);
      expect(reg.body.dev_otp).toBeUndefined();
      const { rows } = await db.query<{ code_hash: string }>("SELECT code_hash FROM auth.otps WHERE mobile = $1", [mobile]);
      const codeHash = rows[0]!.code_hash;

      await auth.stop();
      const out = auth.output();
      expect(out.split("\n").some((l) => l.includes(mobile) && l.includes("SMS"))).toBe(true);
      const leaked = [...out.matchAll(/(?=(\d{6}))/g)].map((m) => m[1]!).filter((c) => createHash("sha256").update(`${mobile}:${c}`).digest("hex") === codeHash);
      expect(leaked).toEqual([]);
    } finally {
      await db.end();
      await auth.stop();
    }
  });
});
