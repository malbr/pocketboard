/**
 * Expired rows are normally removed the next time their session id is
 * presented. A session that is simply abandoned — the browser closed, the
 * cookie discarded — never comes back, so its row would sit in the table
 * forever holding the owner's GitHub id and CSRF secret.
 *
 * The timers are injectable so the schedule can be asserted directly instead of
 * waited on.
 */

import { clearInterval, setInterval } from "node:timers";

export interface CleanupTimers {
  setInterval: (handler: () => void, intervalMs: number) => { unref?: () => unknown };
  clearInterval: (handle: { unref?: () => unknown }) => void;
}

const systemTimers: CleanupTimers = {
  setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface SessionCleanupDependencies {
  reap: () => Promise<void>;
  intervalMs: number;
  timers?: CleanupTimers;
  onError?: (error: unknown) => void;
}

/** Returns the stop function the caller must run on shutdown. */
export function startExpiredSessionCleanup(deps: SessionCleanupDependencies): () => void {
  const { reap, intervalMs, timers = systemTimers, onError } = deps;
  let stopped = false;

  const handle = timers.setInterval(() => {
    if (stopped) {
      return;
    }
    // Housekeeping must never take the API down, so a failed sweep is reported
    // and the next one still runs.
    reap().catch((error: unknown) => onError?.(error));
  }, intervalMs);

  // Keeps the sweep from being a reason the process stays alive.
  handle.unref?.();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    timers.clearInterval(handle);
  };
}
