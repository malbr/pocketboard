import { describe, expect, it, vi } from "vitest";
import { startExpiredSessionCleanup, type CleanupTimers } from "./session-cleanup";

/**
 * A hand-driven clock. Nothing here waits on real time, so the scheduling
 * contract is asserted directly rather than inferred from a sleep.
 */
function fakeTimers() {
  const scheduled: Array<{ handler: () => void; intervalMs: number; unrefCalls: number }> = [];
  const cleared: number[] = [];

  const timers: CleanupTimers = {
    setInterval(handler, intervalMs) {
      const entry = { handler, intervalMs, unrefCalls: 0 };
      scheduled.push(entry);
      return {
        unref() {
          entry.unrefCalls += 1;
          return this;
        },
        id: scheduled.length - 1,
      } as unknown as ReturnType<CleanupTimers["setInterval"]>;
    },
    clearInterval(handle) {
      cleared.push((handle as unknown as { id: number }).id);
    },
  };

  return {
    timers,
    scheduled,
    cleared,
    tick: () => scheduled[0].handler(),
  };
}

describe("expired session cleanup", () => {
  it("sweeps on the configured interval", () => {
    const { timers, scheduled } = fakeTimers();

    startExpiredSessionCleanup({ reap: vi.fn().mockResolvedValue(undefined), intervalMs: 900_000, timers });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].intervalMs).toBe(900_000);
  });

  it("does not sweep before the first interval elapses", () => {
    const { timers } = fakeTimers();
    const reap = vi.fn().mockResolvedValue(undefined);

    startExpiredSessionCleanup({ reap, intervalMs: 900_000, timers });

    expect(reap).not.toHaveBeenCalled();
  });

  it("deletes expired rows when the interval fires", () => {
    const { timers, tick } = fakeTimers();
    const reap = vi.fn().mockResolvedValue(undefined);

    startExpiredSessionCleanup({ reap, intervalMs: 900_000, timers });
    tick();

    expect(reap).toHaveBeenCalledTimes(1);
  });

  it("unrefs the timer so a sweep pending in the background cannot hold the process open", () => {
    const { timers, scheduled } = fakeTimers();

    startExpiredSessionCleanup({ reap: vi.fn().mockResolvedValue(undefined), intervalMs: 900_000, timers });

    expect(scheduled[0].unrefCalls).toBe(1);
  });

  it("reports a failed sweep instead of crashing the API with an unhandled rejection", async () => {
    const { timers, tick } = fakeTimers();
    const failure = new Error("connection terminated");
    const onError = vi.fn();

    startExpiredSessionCleanup({
      reap: vi.fn().mockRejectedValue(failure),
      intervalMs: 900_000,
      timers,
      onError,
    });
    tick();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });

  it("keeps sweeping after a failure", async () => {
    const { timers, tick } = fakeTimers();
    const reap = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue(undefined);
    const onError = vi.fn();

    startExpiredSessionCleanup({ reap, intervalMs: 900_000, timers, onError });
    tick();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    tick();

    expect(reap).toHaveBeenCalledTimes(2);
  });

  it("stops the timer when the app closes", () => {
    const { timers, cleared } = fakeTimers();

    const stop = startExpiredSessionCleanup({
      reap: vi.fn().mockResolvedValue(undefined),
      intervalMs: 900_000,
      timers,
    });
    stop();

    expect(cleared).toEqual([0]);
  });

  it("never sweeps again once stopped", () => {
    const { timers, tick } = fakeTimers();
    const reap = vi.fn().mockResolvedValue(undefined);

    const stop = startExpiredSessionCleanup({ reap, intervalMs: 900_000, timers });
    stop();
    // The fake clock cannot forget the handler, so this stands in for a tick
    // already queued when the app closed.
    tick();

    expect(reap).not.toHaveBeenCalled();
  });

  it("tolerates being stopped twice, as a double close would do", () => {
    const { timers, cleared } = fakeTimers();

    const stop = startExpiredSessionCleanup({
      reap: vi.fn().mockResolvedValue(undefined),
      intervalMs: 900_000,
      timers,
    });
    stop();
    stop();

    expect(cleared).toEqual([0]);
  });
});
