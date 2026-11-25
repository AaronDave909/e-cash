import pg from "pg";
import { envInt } from "./config";

// bigint (int8) and numeric sums arrive as strings by default. All amounts stay below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
export type Queryable = Pick<pg.Pool, "query">;

/** One pool per service. `search_path` pins the service to its own schema. */
export function createPool(databaseUrl: string, schema: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: envInt("DB_POOL_MAX", 20),
    options: `-c search_path=${schema},public`,
    idleTimeoutMillis: 30_000,
  });
}

export async function withTx<T>(pool: pg.Pool, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForDb(pool: pg.Pool, attempts = 60): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await sleep(1000);
    }
  }
}

/** Idempotent migrations: every statement must be safe to re-run. A schema-scoped advisory lock serializes concurrent boots. */
export async function migrate(pool: pg.Pool, schema: string, statements: readonly string[]): Promise<void> {
  await waitForDb(pool);
  await withTx(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ecash:migrate:${schema}`]);
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    for (const sql of statements) await c.query(sql);
  });
}

export const isUniqueViolation = (err: unknown): boolean => (err as { code?: string })?.code === "23505";
export const isDeadlock = (err: unknown): boolean => (err as { code?: string })?.code === "40P01";
