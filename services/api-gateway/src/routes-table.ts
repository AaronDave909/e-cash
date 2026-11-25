/** Where each public path prefix goes. The only routing data in the gateway. */
export type Upstream = "auth" | "transfer";

export interface ProxyRoute {
  prefix: string;
  upstream: Upstream;
  /** Path prefix on the upstream service. */
  rewrite: string;
  /** Requires a valid JWT. */
  jwt: boolean;
}

export const PROXY_ROUTES: readonly ProxyRoute[] = [
  { prefix: "/api/auth", upstream: "auth", rewrite: "/auth", jwt: false },
  { prefix: "/api/transfers", upstream: "transfer", rewrite: "/transfers", jwt: true },
  { prefix: "/api/wallet", upstream: "transfer", rewrite: "/wallet", jwt: true },
  { prefix: "/api/qr", upstream: "transfer", rewrite: "/qr", jwt: true },
  { prefix: "/api/cash-in", upstream: "transfer", rewrite: "/cash-in", jwt: true },
  { prefix: "/api/cash-out", upstream: "transfer", rewrite: "/cash-out", jwt: true },
  { prefix: "/api/bills", upstream: "transfer", rewrite: "/bills", jwt: true },
];

/** POSTs matching these paths move money and need an Idempotency-Key. */
export const IDEMPOTENT_POST_PATTERNS: readonly RegExp[] = [
  /^\/api\/transfers\/.+/,
  /^\/api\/qr\/pay$/,
  /^\/api\/cash-in$/,
  /^\/api\/cash-out$/,
  /^\/api\/bills$/,
];

/**
 * The one form of a request path the gateway routes on and forwards: each segment percent-decoded
 * once, then re-encoded. Returns null for a path an upstream URL parser could read differently from
 * the route table: a `.` or `..` segment, an empty segment, a slash or backslash inside a segment
 * (`%2f`, `%5c`, `\`), or malformed percent-encoding.
 */
export function canonicalPath(raw: string): string | null {
  const [lead, ...segments] = raw.split("/");
  if (lead !== "") return null;
  const out: string[] = [];
  for (const segment of segments) {
    let s: string;
    try {
      s = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (s === "" || s === "." || s === ".." || s.includes("/") || s.includes("\\")) return null;
    out.push(encodeURIComponent(s));
  }
  return `/${out.join("/")}`;
}

export function matchRoute(path: string): ProxyRoute | undefined {
  return PROXY_ROUTES.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
}

export const requiresIdempotencyKey = (method: string, path: string): boolean =>
  method === "POST" && IDEMPOTENT_POST_PATTERNS.some((p) => p.test(path));

/** Admin endpoints on auth (unlock, KYC) are reachable only through the simulator routes. */
export const isInternalOnly = (path: string): boolean => /^\/api\/auth\/users(\/|$)/.test(path);
