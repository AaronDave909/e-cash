import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import QRCode from "qrcode";
import { BANKS, BILLERS, cashIn, cashOut, createQr, payBill, payQr, sendP2p, type Bank, type Biller, type Transfer } from "../api";
import { formatPhp, isMobile, normalizeMobile, parsePesos, shortId } from "../format";
import { useSession } from "../session";
import { errText, useAction, type Outcome } from "./useAction";
import { Notice } from "./ui";

const describe = (t: Transfer) => `${t.type || "transfer"} ${shortId(t.id)} ${t.status}${t.replayed ? " (idempotent replay)" : ""}`;

function Amount({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const c = parsePesos(value);
  return (
    <label className="field">
      <span>Amount (₱)</span>
      <input inputMode="decimal" placeholder="100.00" value={value} onChange={(e) => onChange(e.target.value)} />
      {c && <span className="muted small">{formatPhp(c)}</span>}
    </label>
  );
}

function Result({ outcome }: { outcome: Outcome | null }) {
  return outcome ? <Notice ok={outcome.ok}>{outcome.text}</Notice> : null;
}

function Form({ onSubmit, busy, label, children, outcome }: { onSubmit: () => void; busy: boolean; label: string; children: ReactNode; outcome: Outcome | null }) {
  return (
    <form
      className="stack"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
      <button className="btn" disabled={busy}>
        {busy ? "Working..." : label}
      </button>
      <Result outcome={outcome} />
    </form>
  );
}

function SendForm() {
  const { state } = useSession();
  const { run, busy, outcome, active } = useAction();
  const others = Object.values(state.personas).filter((p) => p.userId !== active?.userId);
  const [pick, setPick] = useState("");
  const [typed, setTyped] = useState("+639");
  const [amount, setAmount] = useState("");
  const sel = pick !== "" ? pick : (others[0]?.mobile ?? "other");
  const to = sel === "other" ? normalizeMobile(typed) : sel;
  const cents = parsePesos(amount);
  const ok = isMobile(to) && cents !== null;
  return (
    <Form busy={busy} outcome={outcome} label="Express Send" onSubmit={() => ok && void run(`p2p|${to}|${cents}`, (t, k) => sendP2p(t, k, to, cents!), describe)}>
      <label className="field">
        <span>Recipient</span>
        <select value={sel} onChange={(e) => setPick(e.target.value)}>
          {others.map((p) => (
            <option key={p.userId} value={p.mobile}>
              {p.displayName} ({p.mobile})
            </option>
          ))}
          <option value="other">Other number...</option>
        </select>
      </label>
      {sel === "other" && (
        <label className="field">
          <span>Mobile</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="tel" />
        </label>
      )}
      <Amount value={amount} onChange={setAmount} />
      {!ok && amount !== "" && <p className="err small">Needs a valid +639 number and amount.</p>}
    </Form>
  );
}

function CashForm({ kind }: { kind: "in" | "out" }) {
  const { run, busy, outcome } = useAction();
  const [bank, setBank] = useState<Bank>("INSTAPAY");
  const [amount, setAmount] = useState("");
  const cents = parsePesos(amount);
  const fn = kind === "in" ? cashIn : cashOut;
  return (
    <Form busy={busy} outcome={outcome} label={kind === "in" ? "Cash in" : "Cash out"} onSubmit={() => cents && void run(`cash${kind}|${bank}|${cents}`, (t, k) => fn(t, k, bank, cents), describe)}>
      <label className="field">
        <span>Bank</span>
        <select value={bank} onChange={(e) => setBank(e.target.value as Bank)}>
          {BANKS.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </label>
      <Amount value={amount} onChange={setAmount} />
      <p className="muted small">Settles asynchronously through the bank rail webhook. Watch the activity feed.</p>
    </Form>
  );
}

function BillsForm() {
  const { run, busy, outcome } = useAction();
  const [biller, setBiller] = useState<Biller>("MERALCO");
  const [acct, setAcct] = useState("");
  const [amount, setAmount] = useState("");
  const cents = parsePesos(amount);
  return (
    <Form busy={busy} outcome={outcome} label="Pay bill" onSubmit={() => cents && acct.trim() && void run(`bill|${biller}|${acct}|${cents}`, (t, k) => payBill(t, k, biller, acct.trim(), cents), describe)}>
      <label className="field">
        <span>Biller</span>
        <select value={biller} onChange={(e) => setBiller(e.target.value as Biller)}>
          {BILLERS.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Account number</span>
        <input value={acct} onChange={(e) => setAcct(e.target.value)} inputMode="numeric" placeholder="1234567890" />
        <span className="muted small">Hint: an account number ending in 0000 makes the biller fail and the hold is released.</span>
      </label>
      <Amount value={amount} onChange={setAmount} />
    </Form>
  );
}

function QrImage({ payload }: { payload: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) void QRCode.toCanvas(ref.current, payload, { width: 200, margin: 1, errorCorrectionLevel: "L" }).catch(() => undefined);
  }, [payload]);
  return <canvas ref={ref} className="qr" aria-label="QR code" />;
}

function QrForm() {
  const { state, dispatch, active, callAs } = useSession();
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [payload, setPayload] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const { run, busy, outcome } = useAction();
  const current = state.qrs.find((q) => q.qrId === shown) ?? state.qrs[0];
  const cents = parsePesos(payAmount);

  async function generate() {
    if (!active) return;
    const amt = amount.trim() === "" ? undefined : parsePesos(amount);
    if (amount.trim() !== "" && !amt) {
      setErr("Invalid amount. Leave blank for a static QR.");
      return;
    }
    try {
      const qr = await callAs(active.userId, (t) => createQr(t, amt ?? undefined));
      dispatch({ type: "addQr", qr });
      setShown(qr.qrId);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    }
  }

  return (
    <div className="stack">
      <h3>Generate</h3>
      <div className="row">
        <label className="field grow">
          <span>Amount (₱, blank = static QR)</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button className="btn" onClick={() => void generate()}>
          Generate QR
        </button>
      </div>
      {err && <Notice ok={false}>{err}</Notice>}
      {current && (
        <div className="qr-box">
          <QrImage payload={current.payload} />
          <code className="payload">{current.payload}</code>
          <span className="muted small">{current.amountCentavos ? `Dynamic, ${formatPhp(current.amountCentavos)}, single use` : "Static, any amount"}</span>
        </div>
      )}
      <h3>Scan and pay</h3>
      <Form busy={busy} outcome={outcome} label="Pay QR" onSubmit={() => payload.trim() && void run(`qr|${payload}|${cents ?? ""}`, (t, k) => payQr(t, k, payload.trim(), cents ?? undefined), describe)}>
        <label className="field">
          <span>Pick a generated QR</span>
          <select value="" onChange={(e) => setPayload(e.target.value)}>
            <option value="">Choose...</option>
            {state.qrs.map((q) => (
              <option key={q.qrId} value={q.payload}>
                {shortId(q.qrId)} {q.amountCentavos ? formatPhp(q.amountCentavos) : "static"}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Or paste payload</span>
          <textarea rows={3} value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="ECASH1...." />
        </label>
        <label className="field">
          <span>Amount (₱, needed for static QR)</span>
          <input inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
        </label>
      </Form>
    </div>
  );
}

const TABS = ["Send", "Cash-In", "Cash-Out", "Bills", "QR"] as const;
type Tab = (typeof TABS)[number];

export function Flows() {
  const { active } = useSession();
  const [tab, setTab] = useState<Tab>("Send");
  if (!active) return <p className="muted">Create or select a persona to start.</p>;
  return (
    <div className="stack">
      <p className="small">
        Acting as <strong>{active.displayName}</strong>
      </p>
      <div className="tabs sub" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Send" && <SendForm />}
      {tab === "Cash-In" && <CashForm kind="in" />}
      {tab === "Cash-Out" && <CashForm kind="out" />}
      {tab === "Bills" && <BillsForm />}
      {tab === "QR" && <QrForm />}
    </div>
  );
}
