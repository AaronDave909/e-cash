import jwt from "jsonwebtoken";
import { z } from "zod";
import { KYC_TIERS } from "./kyc";
import { AppError } from "./errors";

export const claimsSchema = z.object({
  sub: z.string().uuid(),
  mobile: z.string(),
  tier: z.enum(KYC_TIERS),
});
export type TokenClaims = z.infer<typeof claimsSchema>;

export const TOKEN_TTL_S = 3600;

export function signToken(secret: string, claims: TokenClaims): string {
  return jwt.sign(claims, secret, { algorithm: "HS256", expiresIn: TOKEN_TTL_S });
}

export function verifyToken(secret: string, token: string): TokenClaims {
  try {
    const payload = jwt.verify(token, secret, { algorithms: ["HS256"] });
    return claimsSchema.parse(payload);
  } catch {
    throw new AppError("UNAUTHORIZED", "missing, invalid, or expired token");
  }
}
