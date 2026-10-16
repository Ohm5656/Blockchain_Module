import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";

async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No test database port.");
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function startTestPostgres() {
  // Always a NEW local cluster. Never reads SUPABASE_DB_URL or any real database.
  const directory = resolve(await mkdtemp(join(tmpdir(), "fuji-task2-")));
  if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith("fuji-task2-")) {
    throw new Error("Unsafe temporary test database path.");
  }
  const port = await availablePort();
  const password = randomBytes(24).toString("hex");
  const db = new EmbeddedPostgres({
    databaseDir: join(directory, "data"), user: "postgres", password, port,
    persistent: true, createPostgresUser: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: [
      "-h", "127.0.0.1", "-c", "fsync=on", "-c", "synchronous_commit=on",
      "-c", "log_statement=none", "-c", "log_min_error_statement=panic",
      "-c", "log_parameter_max_length=0", "-c", "log_parameter_max_length_on_error=0",
    ],
    // A failed SQL statement can include signed bytes. Never relay raw DB logs.
    onLog: () => {}, onError: () => {},
  });
  const connection = { host: "127.0.0.1", port, user: "postgres", password, database: "postgres" };
  const admin = new Pool(connection);
  const appPools: Pool[] = [];
  async function close() {
    await Promise.all(appPools.map((pool) => pool.end()));
    await admin.end();
    await db.stop();
    // Only the validated, freshly created test directory is removed.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  try {
    await db.initialise();
    await db.start();
    const migrationsDirectory = new URL("../../supabase/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of migrations) {
      await admin.query(await readFile(new URL(name, migrationsDirectory), "utf8"));
    }
    // Restricted runtime role exercises GRANTs and RLS instead of superuser bypass.
    await admin.query(`CREATE ROLE fuji_test_backend LOGIN PASSWORD '${password}' IN ROLE fuji_settlement_service`);
    const config = { ...connection, user: "fuji_test_backend", max: 5, connectionTimeoutMillis: 5_000 };
    const pool = new Pool(config);
    const secondPool = new Pool(config);
    appPools.push(pool, secondPool);
    return {
      admin, pool, secondPool,
      connectionString: `postgresql://fuji_test_backend:${password}@127.0.0.1:${port}/postgres`,
      close,
    };
  } catch {
    await close();
    throw new Error("Local Postgres fixture failed to start or apply the migration; sensitive diagnostics suppressed.");
  }
}
