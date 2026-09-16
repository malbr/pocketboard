import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDbClient } from "./client";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://pocketboard:pocketboard@127.0.0.1:5432/pocketboard";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

const { db, queryClient } = createDbClient(connectionString);

await migrate(db, { migrationsFolder });
await queryClient.end();

console.log("Migrations applied");
