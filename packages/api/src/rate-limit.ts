import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

/**
 * Per-client request budgets (OWASP API4, unrestricted resource consumption).
 *
 * The client is `request.ip`. Fastify walks X-Forwarded-For from the right,
 * starting at the socket peer, and stops at the first address that is not in
 * `TRUSTED_PROXY_IPS`. Production has two hops in front of the API:
 *
 *   client → host Caddy → 127.0.0.1:8080 → web nginx (172.31.250.10) → api
 *
 * Caddy replaces any client-sent X-Forwarded-For with the client's address
 * (its default), and reaches nginx from the `frontend` bridge gateway
 * (172.31.250.1), which nginx appends. Both of those addresses are trusted, so
 * the walk passes them and lands on the address Caddy wrote. A value a client
 * forges stays to the left of that and is never reached, and a direct caller
 * from any other address is its own identity whatever it sends.
 * `proxy-chain.test.ts` models the chain from the deployment files.
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
