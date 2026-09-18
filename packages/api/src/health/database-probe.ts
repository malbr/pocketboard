import { clearTimeout, setTimeout } from "node:timers";

/**
 * Database readiness for `GET /health` (issue #8). The deploy script, the
 * container health check, and Uptime Kuma all read that route, so "healthy"
 * has to mean the API can reach PostgreSQL, not merely that it is listening.
 *
 * `/health` is deliberately exempt from rate limiting (see `rate-limit.ts`),
 * so the probe must not turn a request flood into a query flood: concurrent
 * callers share one in-flight check, and a result is reused for `cacheMs`.
 */
export type HealthProbe = () => Promise<boolean>;

export interface DatabaseProbeOptions {
  /** A check slower than this counts as a failure. */
  timeoutMs?: number;
  /** How long a result is reused before the database is asked again. */
  cacheMs?: number;
  now?: () => number;
  /** Receives the cause of a failed check, for server-side logging only. */
  onFailure?: (error: unknown) => void;
}

export function createDatabaseProbe(
  check: () => Promise<unknown>,
  { timeoutMs = 2_000, cacheMs = 1_000, now = Date.now, onFailure = () => {} }: DatabaseProbeOptions = {},
): HealthProbe {
  let last: { healthy: boolean; at: number } | undefined;
  let inFlight: Promise<boolean> | undefined;

  async function run(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`database check exceeded ${timeoutMs} ms`)), timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([check(), timeout]);
      return true;
    } catch (error) {
      onFailure(error);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return () => {
    if (last && now() - last.at < cacheMs) {
      return Promise.resolve(last.healthy);
    }
    inFlight ??= run().then((healthy) => {
      last = { healthy, at: now() };
      inFlight = undefined;
      return healthy;
    });
    return inFlight;
  };
}
