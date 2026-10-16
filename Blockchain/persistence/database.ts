import "../fuji/server-only.js";
import { Pool, type PoolClient } from "pg";
import { FujiError, fujiOperation } from "../fuji/errors.js";

export function createSettlementPool(): Pool {
  const value = process.env.SUPABASE_DB_URL;
  if (!value) throw new FujiError("CONFIG", "SUPABASE_DB_URL is missing. Configure the server-only Postgres connection and apply the Task 2 migration.");
  let url: URL;
  try {
    url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error();
  } catch {
    throw new FujiError("CONFIG", "SUPABASE_DB_URL must be a valid Postgres connection URI.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // Connection-string SSL parameters otherwise override node-postgres's ssl object.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl"]) url.searchParams.delete(key);
  const pool = new Pool({
    connectionString: url.toString(),
    ssl: local ? false : { rejectUnauthorized: true, ca: process.env.SUPABASE_DB_CA_CERT || undefined },
    max: 5, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000,
  });
  pool.on("error", () => {
    console.error("[PERSISTENCE_FAILED] Idle database connection failed; sensitive diagnostics suppressed.");
  });
  return pool;
}

export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return fujiOperation("PERSISTENCE_FAILED",
    "Database operation failed or commit outcome is uncertain. No fresh signing or broadcast retry was performed.",
    async () => {
      const client = await pool.connect();
      let failed = false;
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL synchronous_commit = on");
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '20s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        failed = true;
        try { await client.query("ROLLBACK"); } catch { /* Discard uncertain connection below. */ }
        throw error;
      } finally {
        client.release(failed);
      }
    });
}
