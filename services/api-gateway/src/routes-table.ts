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

export function matchRoute(path: string): ProxyRoute | undefined {
  return PROXY_ROUTES.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
}

export const requiresIdempotencyKey = (method: string, path: string): boolean =>
  method === "POST" && IDEMPOTENT_POST_PATTERNS.some((p) => p.test(path));
