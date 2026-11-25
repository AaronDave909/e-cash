export const SCHEMA = "bankrail";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rail_transfers (
     reference text PRIMARY KEY,
     direction text NOT NULL CHECK (direction IN ('cash_in','cash_out')),
     bank text NOT NULL,
     amount_centavos bigint NOT NULL CHECK (amount_centavos > 0),
     callback_url text NOT NULL,
     status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','FAILED')),
     failure_reason text,
     settle_after timestamptz NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     settled_at timestamptz,
     delivered_at timestamptz,
     next_delivery_at timestamptz,
     delivery_attempts int NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS rail_pending ON rail_transfers (settle_after) WHERE status = 'PENDING'`,
  `CREATE INDEX IF NOT EXISTS rail_undelivered ON rail_transfers (next_delivery_at) WHERE status <> 'PENDING' AND delivered_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
     id bigserial PRIMARY KEY,
     reference text NOT NULL,
     attempt int NOT NULL,
     status_code int,
     at timestamptz NOT NULL DEFAULT now()
   )`,
];
