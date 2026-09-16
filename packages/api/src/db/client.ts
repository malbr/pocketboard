import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDbClient(connectionString: string) {
  const queryClient = postgres(connectionString);
  return { db: drizzle(queryClient, { schema }), queryClient };
}

export type Database = ReturnType<typeof createDbClient>["db"];
