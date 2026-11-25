export const SCHEMA = "worker";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS processed_events (
     event_id uuid PRIMARY KEY,
     processed_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS receipts (
     id bigserial PRIMARY KEY,
     event_id uuid NOT NULL,
     transfer_id uuid NOT NULL,
     user_id uuid NOT NULL,
     channel text NOT NULL CHECK (channel IN ('SMS','IN_APP')),
     body text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     UNIQUE (event_id, user_id, channel)
   )`,
  `CREATE INDEX IF NOT EXISTS receipts_user ON receipts (user_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id bigserial PRIMARY KEY,
     event_id uuid NOT NULL,
     type text NOT NULL,
     payload jsonb NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE OR REPLACE FUNCTION deny_audit_mutation() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION '% on audit_log is not allowed: the audit log is append-only', TG_OP USING ERRCODE = 'restrict_violation';
   END;
   $$ LANGUAGE plpgsql`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_append_only' AND tgrelid = (current_schema() || '.audit_log')::regclass) THEN
       CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION deny_audit_mutation();
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_no_truncate' AND tgrelid = (current_schema() || '.audit_log')::regclass) THEN
       CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION deny_audit_mutation();
     END IF;
   END $$`,
];
