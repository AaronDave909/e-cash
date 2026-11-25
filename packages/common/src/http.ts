import http from "node:http";
import { URL } from "node:url";
import { AppError } from "./errors";
import { currentCorrelationId } from "./context";

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
  headers: http.IncomingHttpHeaders;
}

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Send this exact string as the body instead of serializing `body`. */
  rawBody?: string;
  timeoutMs?: number;
}

export class UpstreamError extends AppError {
  constructor(url: string, cause: string) {
    super("UPSTREAM_UNAVAILABLE", `upstream call failed: ${cause}`, { url });
  }
}

/**
 * JSON over node:http, so dd-trace's http plugin injects trace headers.
 * Resolves for any HTTP status; rejects with UpstreamError on network failure or timeout.
 */
export function callJson<T = any>(url: string, opts: CallOptions = {}): Promise<JsonResponse<T>> {
  const u = new URL(url);
  const payload = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  const cid = currentCorrelationId();
  if (cid && !headers["x-correlation-id"]) headers["x-correlation-id"] = cid;
  if (payload !== undefined) {
    headers["content-type"] ??= "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? (payload === undefined ? "GET" : "POST"),
        headers,
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          if (text.length > 0) {
            try {
              body = JSON.parse(text);
            } catch {
              body = { raw: text };
            }
          }
          resolve({ status: res.statusCode ?? 0, body: body as T, headers: res.headers });
        });
        res.on("error", (e) => reject(new UpstreamError(url, e.message)));
      },
    );
    req.setTimeout(opts.timeoutMs ?? 10_000, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(new UpstreamError(url, e.message)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
