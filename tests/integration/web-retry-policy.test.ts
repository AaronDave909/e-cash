import { describe, expect, it } from "vitest";
import { keepsIdempotencyKey } from "../../web/src/format";

describe("web retry policy", () => {
  it("reuses the Idempotency-Key only when the request may not have been decided", () => {
    for (const status of [0, 429, 500, 502, 503, 504]) expect({ status, keep: keepsIdempotencyKey(status) }).toEqual({ status, keep: true });
    for (const status of [400, 401, 404, 409, 413, 422, 423]) expect({ status, keep: keepsIdempotencyKey(status) }).toEqual({ status, keep: false });
  });
});
