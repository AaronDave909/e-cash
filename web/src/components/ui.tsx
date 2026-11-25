import type { ReactNode } from "react";
import type { Tier, TransferStatus } from "../api";

export const StatusPill = ({ status }: { status: TransferStatus }) => (
  <span className={`pill pill-${status.toLowerCase()}`}>{status}</span>
);

export const TierBadge = ({ tier }: { tier: Tier }) => (
  <span className={`badge badge-${tier === "FULLY_VERIFIED" ? "full" : "basic"}`}>
    {tier === "FULLY_VERIFIED" ? "Fully Verified" : "Basic"}
  </span>
);

export const Panel = ({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) => (
  <section className="panel">
    <header className="panel-head">
      <h2>{title}</h2>
      {aside}
    </header>
    {children}
  </section>
);

export const Notice = ({ ok, children }: { ok: boolean; children: ReactNode }) => (
  <p className={`notice ${ok ? "notice-ok" : "notice-err"}`} role="status">
    {children}
  </p>
);
