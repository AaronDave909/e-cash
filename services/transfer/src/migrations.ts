import { OUTBOX_MIGRATION } from "@ecash/common";

export const SCHEMA = "transfer";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS transfers (
     id uuid PRIMARY KEY,
     type text NOT NULL CHECK (type IN ('p2p','qr','bills','cash_in','cash_out')),
     status text NOT NULL CHECK (status IN ('PENDING','COMPLETED','FAILED','REVERSED')),
     user_id uuid NOT NULL,
     idempotency_key text NOT NULL,
     request_hash text NOT NULL,
     amount_centavos bigint NOT NULL CHECK (amount_centavos > 0),
     source_account text NOT NULL,
     dest_account text NOT NULL,
     counterparty jsonb,
     failure_reason text,
     rail_reference text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (user_id, idempotency_key)
   )`,
  `CREATE INDEX IF NOT EXISTS transfers_user_created ON transfers (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS transfers_dest_created ON transfers (dest_account, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS transfers_pending ON transfers (created_at) WHERE status = 'PENDING'`,
  `CREATE TABLE IF NOT EXISTS status_history (
     id bigserial PRIMARY KEY,
     transfer_id uuid NOT NULL REFERENCES transfers(id),
     from_status text,
     to_status text NOT NULL,
     reason text,
     at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS status_history_transfer ON status_history (transfer_id, id)`,
  `CREATE TABLE IF NOT EXISTS qr_codes (
     id uuid PRIMARY KEY,
     owner_user_id uuid NOT NULL,
     amount_centavos bigint CHECK (amount_centavos > 0),
     payload text NOT NULL,
     single_use boolean NOT NULL,
     paid_transfer_id uuid,
     expires_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  OUTBOX_MIGRATION,
];
