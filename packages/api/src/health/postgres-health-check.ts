import postgres from "postgres";
import type { DatabaseCheck } from "./database-probe";

export interface PostgresHealthCheckOptions {
  /** Driver deadline for opening a connection. */
  connectTimeoutSeconds?: number;
  /** Server-side deadline for the health query. */
  statementTimeoutMs?: number;
}

/**
 * The `select 1` behind `GET /health`, on its own single connection so a
 * stalled database can never tie up the application's pool. When the probe
 * aborts a check, that connection is destroyed at once: the pending query
 * settles, and the next check opens a fresh connection. At most one health
 * connection is therefore open at any time.
 */
export function createPostgresHealthCheck(
  connectionString: string,
  { connectTimeoutSeconds = 2, statementTimeoutMs = 2_000 }: PostgresHealthCheckOptions = {},
): { check: DatabaseCheck; close: () => Promise<void> } {
  const open = () =>
    postgres(connectionString, {
      max: 1,
      connect_timeout: connectTimeoutSeconds,
      idle_timeout: 60,
      connection: { application_name: "pocketboard-health", statement_timeout: statementTimeoutMs },
    });
  let client = open();

  const destroy = (target: ReturnType<typeof open>) => target.end({ timeout: 0 }).catch(() => {});

  return {
    async check(signal) {
      const current = client;
      const abort = () => {
        if (client === current) client = open();
        void destroy(current);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await current`select 1`;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    close: () => destroy(client),
  };
}
