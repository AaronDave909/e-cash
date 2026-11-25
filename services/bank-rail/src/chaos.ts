import { CHAOS_KEY, type Redis } from "@ecash/common";
import { z } from "zod";

export const chaosSchema = z.object({
  latency_ms: z.number().int().min(0).max(30_000),
  failure_rate: z.number().min(0).max(1),
});
export type Chaos = z.infer<typeof chaosSchema>;

export const NO_CHAOS: Chaos = { latency_ms: 0, failure_rate: 0 };

export async function readChaos(redis: Redis): Promise<Chaos> {
  try {
    const raw = await redis.get(CHAOS_KEY);
    if (!raw) return NO_CHAOS;
    const parsed = chaosSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : NO_CHAOS;
  } catch {
    return NO_CHAOS;
  }
}

export async function writeChaos(redis: Redis, chaos: Chaos): Promise<void> {
  await redis.set(CHAOS_KEY, JSON.stringify(chaos));
}
