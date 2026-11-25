import type { Redis } from "@ecash/common";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterS: number;
}

/** Fixed-window counter in Redis. Fails open: a Redis outage must not take the API down. */
export async function hit(redis: Redis, scope: string, id: string, max: number, windowS: number): Promise<RateLimitResult> {
  const nowS = Math.floor(Date.now() / 1000);
  const window = Math.floor(nowS / windowS);
  const key = `ecash:rl:${scope}:${id}:${window}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowS + 1);
    return { allowed: count <= max, retryAfterS: Math.max(1, (window + 1) * windowS - nowS) };
  } catch {
    return { allowed: true, retryAfterS: 0 };
  }
}
