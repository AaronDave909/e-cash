const php = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

/** 123450 -> "₱1,234.50" */
export const formatPhp = (centavos: number): string => php.format(centavos / 100);

/** "1,234.5" -> 123450. Returns null for anything that is not a positive peso amount. */
export function parsePesos(input: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ""));
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export const normalizeMobile = (s: string): string => {
  const t = s.replace(/[\s-]/g, "");
  return /^09\d{9}$/.test(t) ? `+63${t.slice(1)}` : t;
};

export const isMobile = (s: string): boolean => /^\+639\d{9}$/.test(s);

export const shortId = (id: string): string => id.slice(0, 8);

export const timeOf = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-PH", { hour12: false });
};

/**
 * Whether a retry after a failed request must reuse its Idempotency-Key. Keep it when the server may
 * not have decided (network error = status 0, 429, any 5xx). Any other 4xx is a decision the server
 * stored under that key (a 422 is a FAILED transfer), so a retry after fixing the cause needs a new key.
 */
export const keepsIdempotencyKey = (status: number): boolean => status === 0 || status === 429 || status >= 500;

export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
