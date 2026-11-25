import { Redis } from "ioredis";

export type { Redis };

export function createRedis(url: string, name: string): Redis {
  const r = new Redis(url, { connectionName: name, maxRetriesPerRequest: 3, lazyConnect: false });
  r.on("error", () => undefined); // reconnect is automatic; callers see command errors
  return r;
}
