import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

/**
 * Per-client request budgets (OWASP API4, unrestricted resource consumption).
 *
 * The client is `request.ip`, which Fastify derives from X-Forwarded-For only
 * when the socket peer is a configured trusted proxy. Behind the production
 * web proxy each real client gets its own budget, while a direct caller cannot
 * pick a fresh identity by rotating that header.
 *
 * Counters live in process memory: there is one API container, and a restart
 * resetting them is acceptable for a POC.
 */
export const DEFAULT_ROUTE_LIMIT = { max: 300, timeWindow: 60_000 } as const;

/**
 * The OAuth routes start and complete a GitHub round-trip, and the callback
 * performs a token exchange and a session write. A person signs in a handful of
 * times a day, so this budget only ever stops automation.
 */
export const AUTH_ROUTE_LIMIT = { max: 10, timeWindow: 60_000 } as const;

/** Route config for the OAuth routes. */
export const authRouteRateLimit = { rateLimit: AUTH_ROUTE_LIMIT };

/**
 * Route config for `/health`. Container health checks and Uptime Kuma poll it,
 * and throttling a liveness probe would turn load into a false outage.
 */
export const unlimitedRoute = { rateLimit: false as const };

/** Thrown for an exceeded budget; the error handler turns it into the shared 429 body. */
export class RateLimitedError extends Error {
  readonly statusCode = 429;

  constructor() {
    super("rate limit exceeded");
    this.name = "RateLimitedError";
  }
}

/**
 * Must be registered before the session plugin and every route: the limiter's
 * onRequest hook then runs first, so a request over budget never reaches the
 * session store or a handler, and routes pick up their per-route settings.
 */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    ...DEFAULT_ROUTE_LIMIT,
    errorResponseBuilder: () => new RateLimitedError(),
  });
}
