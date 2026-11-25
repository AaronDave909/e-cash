import tracer from "dd-trace";

export { tracer };

export type Carrier = Record<string, string>;

export function currentTraceId(): string | null {
  const span = tracer.scope().active();
  return span ? span.context().toTraceId() : null;
}

/** Serializes the active span so another process can continue the trace. */
export function injectCarrier(): Carrier {
  const carrier: Carrier = {};
  const span = tracer.scope().active();
  if (span) tracer.inject(span, "text_map", carrier);
  return carrier;
}

export function traceIdFromCarrier(carrier: Carrier): string | null {
  return carrier["x-datadog-trace-id"] ?? null;
}

/** Runs `fn` inside a span that continues the trace stored in `carrier`. */
export async function withExtractedSpan<T>(
  name: string,
  carrier: Carrier,
  tags: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = tracer.extract("text_map", carrier);
  const span = tracer.startSpan(name, { childOf: parent ?? undefined, tags });
  try {
    return await tracer.scope().activate(span, fn);
  } catch (err) {
    span.setTag("error", err as Error);
    throw err;
  } finally {
    span.finish();
  }
}
