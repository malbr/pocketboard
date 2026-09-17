import { defineConfig } from "drizzle-kit";
import { loadRepositoryEnvFile } from "./src/config/repository-root";

// Same reason as src/db/migrate.ts: drizzle-kit runs from `packages/api`.
loadRepositoryEnvFile();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://pocketboard:pocketboard@127.0.0.1:5432/pocketboard",
  },
});
