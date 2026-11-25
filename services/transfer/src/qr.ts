import { b64url, safeEqual } from "@ecash/common";
import { createHmac } from "node:crypto";

const PREFIX = "ECASH1";
export const DYNAMIC_QR_TTL_MS = 15 * 60 * 1000;

export interface QrClaims {
  qr: string;
  to: string;
  amt: number | null;
  exp: number | null;
}

const sign = (secret: string, signed: string): string => createHmac("sha256", secret).update(signed).digest("base64url");

/** `ECASH1.<base64url(json)>.<base64url(hmac-sha256 over "ECASH1.<base64url(json)>")>` */
export function encodeQr(secret: string, claims: QrClaims): string {
  const signed = `${PREFIX}.${b64url(JSON.stringify(claims))}`;
  return `${signed}.${sign(secret, signed)}`;
}

/** Returns the claims when the signature matches, null for anything else. Expiry is the caller's check. */
export function decodeQr(secret: string, payload: string): QrClaims | null {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, body, sig] = parts as [string, string, string];
  if (!safeEqual(sig, sign(secret, `${PREFIX}.${body}`))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as QrClaims;
    return typeof c.qr === "string" && typeof c.to === "string" ? c : null;
  } catch {
    return null;
  }
}

