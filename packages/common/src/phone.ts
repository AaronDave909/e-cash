import { z } from "zod";

export type MobileNumber = string & { readonly __brand: "MobileNumber" };

const CANONICAL = /^\+639\d{9}$/;

/** Accepts `+639XXXXXXXXX`, `639XXXXXXXXX` and `09XXXXXXXXX`; returns the canonical form or null. */
export function parseMobile(input: string): MobileNumber | null {
  const raw = input.trim().replace(/[\s-]/g, "");
  let candidate: string;
  if (/^09\d{9}$/.test(raw)) candidate = `+63${raw.slice(1)}`;
  else if (/^639\d{9}$/.test(raw)) candidate = `+${raw}`;
  else candidate = raw;
  return CANONICAL.test(candidate) ? (candidate as MobileNumber) : null;
}

export const mobileSchema = z
  .string({ required_error: "mobile is required" })
  .transform((s, ctx) => {
    const m = parseMobile(s);
    if (m === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "mobile must be +639XXXXXXXXX or 09XXXXXXXXX" });
      return z.NEVER;
    }
    return m;
  });
