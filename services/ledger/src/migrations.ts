export const SCHEMA = "ledger";

/** Append-only: no table has a balance column and journal rows can never change. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id bigserial PRIMARY KEY,
     code text UNIQUE NOT NULL,
     kind text NOT NULL CHECK (kind IN ('USER_WALLET','SYSTEM')),
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS journal_entries (
     id uuid PRIMARY KEY,
     idempotency_key text UNIQUE NOT NULL,
     request_hash text NOT NULL,
     kind text NOT NULL,
     metadata jsonb NOT NULL DEFAULT '{}',
     balances jsonb NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS ledger_postings (
     id bigserial PRIMARY KEY,
     journal_id uuid NOT NULL REFERENCES journal_entries(id),
     account_id bigint NOT NULL REFERENCES accounts(id),
     direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
     amount_centavos bigint NOT NULL CHECK (amount_centavos > 0),
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS ledger_postings_account_created ON ledger_postings (account_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS ledger_postings_journal ON ledger_postings (journal_id)`,
  `CREATE OR REPLACE FUNCTION deny_ledger_mutation() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION '% on % is not allowed: the ledger is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
   END;
   $$ LANGUAGE plpgsql`,
  `DO $$
   DECLARE t text;
   BEGIN
     FOREACH t IN ARRAY ARRAY['journal_entries','ledger_postings'] LOOP
       IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_append_only' AND tgrelid = (current_schema() || '.' || t)::regclass) THEN
         EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation()', t || '_append_only', t);
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_no_truncate' AND tgrelid = (current_schema() || '.' || t)::regclass) THEN
         EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION deny_ledger_mutation()', t || '_no_truncate', t);
       END IF;
     END LOOP;
   END $$`,
];
