import { clearTimeout, setTimeout } from "node:timers";

/**
 * Database readiness for `GET /health` (issue #8). The deploy script, the
 * container health check, and Uptime Kuma all read that route, so "healthy"
 * has to mean the API can reach PostgreSQL, not merely that it is listening.
 *
 * `/health` is deliberately exempt from rate limiting (see `rate-limit.ts`),
 * so the probe must not turn a request flood into a query flood: concurrent
 * callers share one in-flight check, and a result is reused for `cacheMs`.
 *
 * A check that times out is aborted but still owned until it settles. While
 * it is outstanding no new check starts and callers get `false`, so a stalled
 * database can never accumulate more than one check.
 */
export type HealthProbe = () => Promise<boolean>;

/** Receives an AbortSignal that fires when the check exceeds its timeout. */
export type DatabaseCheck = (signal: AbortSignal) => Promise<unknown>;

export interface DatabaseProbeOptions {
  /** A check slower than this counts as a failure and is aborted. */
  timeoutMs?: number;
  /** How long a result is reused before the database is asked again. */
  cacheMs?: number;
  now?: () => number;
  /** Receives the cause of a failed check, for server-side logging only. */
  onFailure?: (error: unknown) => void;
}

export function createDatabaseProbe(
  check: DatabaseCheck,
  { timeoutMs = 2_000, cacheMs = 1_000, now = Date.now, onFailure = () => {} }: DatabaseProbeOptions = {},
): HealthProbe {
  let last: { healthy: boolean; at: number } | undefined;
  let verdict: Promise<boolean> | undefined;
  let outstanding = false;

  function run(): Promise<boolean> {
    const controller = new AbortController();
    let work: Promise<unknown>;
    try {
      work = Promise.resolve(check(controller.signal));
    } catch (error) {
      work = Promise.reject(error);
    }
    outstanding = true;
    const release = () => {
      outstanding = false;
    };
    work.then(release, release);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        controller.abort();
        onFailure(new Error(`database check exceeded ${timeoutMs} ms`));
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      work.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        (error: unknown) => {
          clearTimeout(timer);
          // After a timeout the rejection is the abort itself, already reported.
          if (!controller.signal.aborted) onFailure(error);
          resolve(false);
        },
      );
    });
  }

  return () => {
    if (last && now() - last.at < cacheMs) {
      return Promise.resolve(last.healthy);
    }
    if (verdict) return verdict;
    if (outstanding) return Promise.resolve(false);
    verdict = run().then((healthy) => {
      last = { healthy, at: now() };
      verdict = undefined;
      return healthy;
    });
    return verdict;
  };
}
