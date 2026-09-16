import { buildApp } from "./app";
import { createGitHubOAuthProvider } from "./auth/github-oauth";
import { loadAuthConfig } from "./config/auth-config";
import { createDbClient } from "./db/client";
import { serializeErrorForLog } from "./errors";
import type { FastifyInstance } from "fastify";

/**
 * Often enough that an abandoned session row is gone well within the day, rare
 * enough that the sweep is invisible next to real traffic.
 */
const SESSION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The only place production wiring happens. It always builds the real GitHub
 * adapter; there is no environment variable, flag, or branch that can swap in
 * a fake or skip the owner check.
 */
export async function createProductionApp(
  env: Record<string, string | undefined>,
): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  // Loaded first so a misconfigured secret file stops the process before a
  // listener is ever opened.
  const authConfig = loadAuthConfig(env);

  const connectionString =
    env.DATABASE_URL ?? "postgres://pocketboard:pocketboard@127.0.0.1:5432/pocketboard";
  const { db, queryClient } = createDbClient(connectionString);

  const app = await buildApp({
    db,
    authConfig,
    identityProvider: createGitHubOAuthProvider(authConfig),
    // Without this the API is silent about its own failures, and the generic
    // `internal_error` body would be the only trace a 500 ever left.
    logger: {
      level: env.LOG_LEVEL ?? "info",
      serializers: { err: serializeErrorForLog },
    },
    sessionCleanup: { intervalMs: SESSION_CLEANUP_INTERVAL_MS },
  });

  return {
    app,
    close: async () => {
      // Closing the app first runs the onClose hook that stops the sweep, so
      // no timer can fire against a connection that is already gone.
      await app.close();
      await queryClient.end();
    },
  };
}
