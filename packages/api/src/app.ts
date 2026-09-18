import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import session, { type SessionStore } from "@fastify/session";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { GitHubIdentityProvider } from "./auth/github-identity-provider";
import { createRequireOwner } from "./auth/require-owner";
import { startExpiredSessionCleanup, type CleanupTimers } from "./auth/session-cleanup";
import { PostgresSessionStore } from "./auth/session-store";
import type { AuthConfig } from "./config/auth-config";
import type { Database } from "./db/client";
import { registerErrorHandler } from "./errors";
import { createDatabaseProbe } from "./health/database-probe";
import { registerRateLimit } from "./rate-limit";
import { registerAuthRoutes } from "./routes/auth";
import { registerCardRoutes } from "./routes/cards";
import { registerHealthRoutes } from "./routes/health";

const SESSION_COOKIE_NAME = "pocketboard.sid";

export interface AppDependencies {
  db: Database;
  authConfig: AuthConfig;
  /**
   * Injected so tests can drive the OAuth callback without GitHub. Production
   * always passes the real adapter from `composition-root.ts`.
   */
  identityProvider: GitHubIdentityProvider;
  now?: () => Date;
  /** Off by default so test output stays readable; production always sets it. */
  logger?: FastifyServerOptions["logger"];
  /**
   * Opt-in background sweep of abandoned expired session rows. Only the
   * composition root turns it on, so no test leaves a timer behind.
   */
  sessionCleanup?: { intervalMs: number; timers?: CleanupTimers };
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const { db, authConfig, identityProvider, now = () => new Date(), logger = false } = deps;
  const app = Fastify({
    logger,
    // Only the addresses the deployment actually puts in front of the API may
    // set X-Forwarded-*. With none configured this is `false`, and
    // `request.protocol` reflects the socket rather than a caller-supplied
    // header — which is what keeps a Secure session cookie honest.
    trustProxy: authConfig.trustedProxies.length > 0 ? authConfig.trustedProxies : false,
  });

  registerErrorHandler(app);
  // Before the session plugin and all routes; see registerRateLimit.
  await registerRateLimit(app);

  const sessionStore = new PostgresSessionStore(db, authConfig.sessionTtlMs, now);

  await app.register(cookie);
  await app.register(session, {
    secret: authConfig.sessionSecret,
    cookieName: SESSION_COOKIE_NAME,
    store: sessionStore as unknown as SessionStore,
    // Anonymous visitors must not create session rows.
    saveUninitialized: false,
    // Absolute eight-hour expiry; no sliding renewal on activity.
    rolling: false,
    cookie: {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: authConfig.cookieSecure,
      maxAge: authConfig.sessionTtlMs,
    },
  });
  await app.register(csrfProtection, { sessionPlugin: "@fastify/session" });
  await identityProvider.register(app);

  const requireOwner = createRequireOwner(authConfig.ownerGitHubUserId);

  registerHealthRoutes(
    app,
    createDatabaseProbe(() => db.execute(sql`select 1`), {
      onFailure: (error) => app.log.warn({ err: error }, "health check could not reach the database"),
    }),
  );
  registerAuthRoutes(app, { config: authConfig, provider: identityProvider, requireOwner });
  registerCardRoutes(app, db, requireOwner);

  if (deps.sessionCleanup) {
    const stop = startExpiredSessionCleanup({
      reap: () => sessionStore.deleteExpired(),
      onError: (error) => app.log.error({ err: error }, "expired session cleanup failed"),
      ...deps.sessionCleanup,
    });
    app.addHook("onClose", () => {
      stop();
    });
  }

  return app;
}
