export const title = "E-Cash transfer t1 (t2 races it on the same wallet)";
export const state = (v) => {
  const st = v.status.t1;
  if (st === "none") return "Not started";
  if (st === "PENDING") return v.posted.t1 ? "PENDING, ledger posted" : v.rejected.t1 ? "PENDING, ledger rejected" : "PENDING";
  return st;
};
export const step = (a, f, t) => {
  if (state(f) === state(t)) return null;
  return ({ Create: "you tap Send", PostLocked: "ledger debits under row lock", PostUnlocked: "ledger debits after stale check",
    Check: "ledger reads balance", Complete: "transfer marked done", Fail: "transfer marked failed", Reverse: "ops reverses it" })[a] ?? a;
};
export const group = (v) => ({ none: "start", PENDING: "pending", COMPLETED: "ok", FAILED: "bad", REVERSED: "bad" })[v.status.t1];
export const colors = { start: "blue", pending: "orange", ok: "teal", bad: "pink" };
