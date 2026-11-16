import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "pg";

export interface Database {
  query<Row extends object>(sql: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

const schema = `
CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  event_hash text NOT NULL,
  payload jsonb NOT NULL,
  subject text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'queued', 'running', 'retrying', 'awaiting_approval', 'completed', 'rejected', 'failed'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL,
  lease_until timestamptz,
  lease_token uuid,
  classification jsonb,
  draft text,
  error_code text,
  trace jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((status = 'running') = (lease_until IS NOT NULL AND lease_token IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS runs_ready_idx ON runs (available_at, created_at, id)
  WHERE status IN ('queued', 'retrying');
CREATE INDEX IF NOT EXISTS runs_lease_idx ON runs (lease_until)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS runs_recent_idx ON runs (created_at DESC, id DESC);
`;

export async function openDatabase({ url, path = "memory://" }: { url?: string; path?: string } = {}): Promise<Database> {
  if (!url) {
    if (path !== "memory://") await mkdir(dirname(resolve(path)), { recursive: true });
    const embedded = await PGlite.create(path);
    try {
      await embedded.exec(schema);
    } catch (error) {
      await embedded.close();
      throw error;
    }
    return {
      async query<Row extends object>(sql: string, params: unknown[] = []) {
        return (await embedded.query<Row>(sql, params)).rows;
      },
      close: () => embedded.close()
    };
  }

  const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 8000 });
  pool.on("error", () => console.error(JSON.stringify({ event: "db_idle_connection_error" })));
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(79389126)");
      await client.query(schema);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    async query<Row extends object>(sql: string, params: unknown[] = []) {
      return (await pool.query<Row>(sql, params)).rows;
    },
    close: () => pool.end()
  };
}
