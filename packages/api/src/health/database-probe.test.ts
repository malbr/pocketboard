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
});
