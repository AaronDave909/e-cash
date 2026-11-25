import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { api, balanceOf, fund, newUser, pesos, readLog, stack, waitFor } from "./helpers";

describe("trace propagation", () => {
  it("carries one request's trace through gateway, transfer and ledger, and across the event stream into the worker", async () => {
    const [alice, bob] = await Promise.all([newUser(), newUser()]);
    await fund(alice, pesos(500));
    const correlationId = randomUUID();

    const sent = await api("POST", "/api/transfers/p2p", {
      token: alice.token,
      key: randomUUID(),
      headers: { "x-correlation-id": correlationId },
      body: { to_mobile: bob.mobile, amount_centavos: pesos(100) },
    });
    expect(sent.status).toBe(201);
    expect(sent.headers.get("x-correlation-id")).toBe(correlationId);

    // Gateway: the request's log lines carry the correlation id and a trace id.
    const gatewayLines = await waitFor(async () => {
      const lines = readLog("api-gateway").filter((l) => l.correlation_id === correlationId && l.dd?.trace_id);
      return lines.length > 0 ? lines : undefined;
    }, "gateway log lines");
    const traceId = String(gatewayLines[0]!.dd.trace_id);
    expect(traceId).toMatch(/^\d+$/);

    // Ledger: the same trace id, so the HTTP call from transfer was propagated end to end.
    const ledgerLines = await waitFor(async () => {
      const lines = readLog("ledger").filter((l) => l.dd?.trace_id === traceId);
      return lines.length > 0 ? lines : undefined;
    }, "ledger log lines for the trace");
    expect(ledgerLines.some((l) => l.msg === "journal posted")).toBe(true);
    expect(ledgerLines.every((l) => l.service === "ecash-ledger")).toBe(true);

    // Transfer: the downstream hop too, with the correlation id forwarded.
    expect(readLog("transfer").some((l) => l.correlation_id === correlationId && l.dd?.trace_id === traceId)).toBe(true);

    // Worker: the transfer.created event carries the request's trace id, and the worker logs under it.
    const created = await waitFor(async () => {
      const audit = (await (await fetch(`${stack.worker}/audit?limit=200`)).json()) as { events: Array<{ type: string; payload: any }> };
      return audit.events.find((e) => e.type === "transfer.created" && e.payload.payload.transfer_id === sent.body.id);
    }, "worker audit row for transfer.created");
    expect(created.payload.trace_id).toBe(traceId);
    const workerLines = await waitFor(async () => {
      const lines = readLog("worker").filter((l) => l.dd?.trace_id === created.payload.trace_id && l.msg === "event processed");
      return lines.length > 0 ? lines : undefined;
    }, "worker log lines under the event's trace");
    expect(workerLines[0]!.service).toBe("ecash-worker");

    expect(await balanceOf(bob)).toBe(pesos(100));
  });

  it("emits JSON logs with service, correlation_id and dd ids on every service", async () => {
    await api("GET", "/api/system/health");
    for (const svc of ["api-gateway", "auth-kyc", "ledger", "transfer", "bank-rail", "worker"]) {
      const lines = readLog(svc).filter((l) => l.correlation_id && l.dd?.trace_id);
      expect(lines.length, svc).toBeGreaterThan(0);
      expect(lines[0]!.service, svc).toBe(`ecash-${svc}`);
    }
  });
});
