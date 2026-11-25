export const SCHEMA = "auth";

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id uuid PRIMARY KEY,
     mobile text UNIQUE NOT NULL,
     display_name text NOT NULL,
     kyc_tier text NOT NULL DEFAULT 'BASIC' CHECK (kyc_tier IN ('BASIC','FULLY_VERIFIED')),
     mpin_hash text,
     mpin_salt text,
     failed_mpin_attempts int NOT NULL DEFAULT 0,
     locked_at timestamptz,
     persona text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS otps (
     id bigserial PRIMARY KEY,
     mobile text NOT NULL,
     code_hash text NOT NULL,
     expires_at timestamptz NOT NULL,
     consumed_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS otps_mobile ON otps (mobile, id DESC)`,
  `ALTER TABLE otps ADD COLUMN IF NOT EXISTS failed_attempts int NOT NULL DEFAULT 0`,
];
