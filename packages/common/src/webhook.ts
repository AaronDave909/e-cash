import { hmacHex, safeEqual } from "./hash";

export const SIGNATURE_HEADER = "x-ecash-signature";
export const SIGNATURE_MAX_AGE_S = 300;

/** `t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<raw body>")>` */
export function signWebhook(secret: string, rawBody: string, nowS = Math.floor(Date.now() / 1000)): string {
  return `t=${nowS},v1=${hmacHex(secret, `${nowS}.${rawBody}`)}`;
}

export function verifyWebhook(
  secret: string,
  header: string | undefined,
  rawBody: string,
  nowS = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts["t"]);
  const v1 = parts["v1"];
  if (!Number.isInteger(t) || !v1) return false;
  if (Math.abs(nowS - t) > SIGNATURE_MAX_AGE_S) return false;
  return safeEqual(v1, hmacHex(secret, `${t}.${rawBody}`));
}
