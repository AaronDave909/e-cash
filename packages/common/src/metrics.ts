import { StatsD } from "hot-shots";
import { envInt, envStr } from "./config";

export interface Metrics {
  increment(name: string, tags?: Record<string, string>): void;
  distribution(name: string, value: number, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  close(): void;
}

/** DogStatsD client. UDP is fire-and-forget, so a missing agent never breaks a request. */
export function createMetrics(service: string): Metrics {
  const client = new StatsD({
    host: envStr("DD_DOGSTATSD_HOST", envStr("DD_AGENT_HOST", "127.0.0.1")),
    port: envInt("DD_DOGSTATSD_PORT", 8125),
    globalTags: {
      service,
      env: envStr("DD_ENV", "local"),
      version: envStr("DD_VERSION", "1.0.0"),
    },
    errorHandler: () => undefined,
  });
  return {
    increment: (name, tags) => client.increment(name, 1, tags),
    distribution: (name, value, tags) => client.distribution(name, value, tags),
    gauge: (name, value, tags) => client.gauge(name, value, tags),
    close: () => client.close(() => undefined),
  };
}
