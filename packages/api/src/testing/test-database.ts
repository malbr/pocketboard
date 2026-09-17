import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createDbClient, type Database } from "../db/client";
import { resolveDatabaseAvailability } from "./database-requirement";

export const connectionString =
  process.env.DATABASE_URL ?? "postgres://pocketboard:pocketboard@127.0.0.1:5432/pocketboard";

export const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

async function probeDatabase(): Promise<boolean> {
  try {
    const probe = postgres(connectionString, { connect_timeout: 2, max: 1 });
    await probe`select 1`;
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * PostgreSQL-backed suites self-skip when no database is reachable so a local
 * `npm test` stays useful. In CI an unreachable database throws here instead,
 * which fails every importing suite loudly rather than reporting them skipped.
 */
export const databaseAvailable = resolveDatabaseAvailability(process.env, await probeDatabase());

export interface TestDatabase {
  db: Database;
  queryClient: ReturnType<typeof createDbClient>["queryClient"];
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const { db, queryClient } = createDbClient(connectionString);
  await migrate(db, { migrationsFolder });
  return { db, queryClient };
}
