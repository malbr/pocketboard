import { describe, expect, it, vi } from "vitest";
import { createDatabaseProbe } from "./database-probe";

describe("createDatabaseProbe", () => {
  it("reports healthy when the check resolves", async () => {
    const probe = createDatabaseProbe(async () => [{ "?column?": 1 }]);

    await expect(probe()).resolves.toBe(true);
  });

  it("reports unhealthy and hands the error to onFailure when the check rejects", async () => {
    const failure = new Error("connection refused");
    const onFailure = vi.fn();
    const probe = createDatabaseProbe(() => Promise.reject(failure), { onFailure });

    await expect(probe()).resolves.toBe(false);
    expect(onFailure).toHaveBeenCalledWith(failure);
  });

  it("reports unhealthy when the check hangs past the timeout", async () => {
    const onFailure = vi.fn();
    const probe = createDatabaseProbe(() => new Promise(() => {}), { timeoutMs: 20, onFailure });

    await expect(probe()).resolves.toBe(false);
    expect(onFailure.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("shares one check between concurrent callers", async () => {
    let release!: () => void;
    const check = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const probe = createDatabaseProbe(check);

    const results = Promise.all([probe(), probe(), probe()]);
    release();

    await expect(results).resolves.toEqual([true, true, true]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("reuses a result inside the cache window and checks again after it", async () => {
    let clock = 1_000;
    const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("down"));
    const probe = createDatabaseProbe(check, { cacheMs: 1_000, now: () => clock, onFailure: () => {} });

    await expect(probe()).resolves.toBe(true);
    clock += 999;
    await expect(probe()).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(1);

    clock += 1;
    await expect(probe()).resolves.toBe(false);
    expect(check).toHaveBeenCalledTimes(2);
  });

  // PR #29 review finding 4: a timed-out check kept running while every later
  // cache window started another one in the shared pool.
  describe("when the database stalls", () => {
    function stalledCheck() {
      const pending: Array<{ signal: AbortSignal; settle: () => void }> = [];
      const check = vi.fn(
        (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            pending.push({ signal, settle: resolve });
          }),
      );
      return { check, pending };
    }

    it("keeps at most one check outstanding across repeated timeouts", async () => {
      let clock = 0;
      const { check, pending } = stalledCheck();
      const probe = createDatabaseProbe(check, { timeoutMs: 5, cacheMs: 10, now: () => clock });

      for (let cycle = 0; cycle < 5; cycle++) {
        await expect(probe()).resolves.toBe(false);
        clock += 11;
      }

      expect(check).toHaveBeenCalledTimes(1);
      expect(pending).toHaveLength(1);
    });

    it("aborts the outstanding check when it times out", async () => {
      const { check, pending } = stalledCheck();
      const probe = createDatabaseProbe(check, { timeoutMs: 5 });

      await expect(probe()).resolves.toBe(false);

      expect(pending[0]?.signal.aborted).toBe(true);
    });

    it("stays unhealthy until the stalled check settles, then recovers", async () => {
      let clock = 0;
      const { check, pending } = stalledCheck();
      const probe = createDatabaseProbe(check, { timeoutMs: 5, cacheMs: 10, now: () => clock });

      await expect(probe()).resolves.toBe(false);
      clock += 11;
      await expect(probe()).resolves.toBe(false);

      pending[0]?.settle();
      await Promise.resolve();
      clock += 11;
      check.mockResolvedValueOnce(undefined);

      await expect(probe()).resolves.toBe(true);
      expect(check).toHaveBeenCalledTimes(2);
    });

    it("never reports a late success from a check that already timed out", async () => {
      let clock = 0;
      const { check, pending } = stalledCheck();
      const probe = createDatabaseProbe(check, { timeoutMs: 5, cacheMs: 10, now: () => clock });

      await expect(probe()).resolves.toBe(false);
      pending[0]?.settle();
      await Promise.resolve();

      await expect(probe()).resolves.toBe(false);
    });
  });
});
