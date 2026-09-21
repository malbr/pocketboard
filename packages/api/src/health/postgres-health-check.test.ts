import net from "node:net";
import { clearInterval, setInterval } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { connectionString, databaseAvailable } from "../testing/test-database";
import { createDatabaseProbe } from "./database-probe";
import { createPostgresHealthCheck } from "./postgres-health-check";

/**
 * A TCP proxy in front of the real test database that can stop forwarding
 * (a stalled network or a frozen server) or refuse connections outright. It
 * counts open client connections so the tests can prove a stall never piles
 * up database work.
 *
 * With `holdHalfOpen`, a client that half-closes during a stall is kept open,
 * like a peer that never finishes closing. The proxy then keeps writing to
 * it: a client that really closed its socket answers with a reset, which is
 * the only thing that counts as closed.
 */
async function startProxy(target: URL, { holdHalfOpen = false } = {}) {
  let mode: "forward" | "stall" | "refuse" = "forward";
  let open = 0;
  let maxOpen = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: holdHalfOpen }, (client) => {
    if (mode === "refuse") {
      client.destroy();
      return;
    }
    open++;
    maxOpen = Math.max(maxOpen, open);
    sockets.add(client);
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    sockets.add(upstream);
    const forward = (from: net.Socket, to: net.Socket) =>
      from.on("data", (chunk) => {
        if (mode === "forward") to.write(chunk);
      });
    forward(client, upstream);
    forward(upstream, client);
    const close = () => {
      if (sockets.delete(client)) open--;
      client.destroy();
      upstream.destroy();
    };
    client.on("close", close).on("error", close);
    upstream.on("close", close).on("error", close);
    if (holdHalfOpen) {
      client.on("end", () => {
        if (mode === "forward") return close();
        const poke = setInterval(() => client.write("\0"), 20);
        client.once("close", () => clearInterval(poke));
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return {
    url: url.toString(),
    set mode(next: typeof mode) {
      mode = next;
    },
    get open() {
      return open;
    },
    get maxOpen() {
      return maxOpen;
    },
    resetMax() {
      maxOpen = open;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function setUp(proxyOptions: { holdHalfOpen?: boolean } = {}) {
  const proxy = await startProxy(new URL(connectionString), proxyOptions);
  const healthCheck = createPostgresHealthCheck(proxy.url, { connectTimeoutSeconds: 1 });
  cleanup.push(proxy.close, healthCheck.close);
  let running = 0;
  let maxRunning = 0;
  const probe = createDatabaseProbe(
    async (signal) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      try {
        return await healthCheck.check(signal);
      } finally {
        running--;
      }
    },
    { timeoutMs: 150, cacheMs: 50 },
  );
  return { proxy, probe, maxRunning: () => maxRunning };
}

describe.skipIf(!databaseAvailable)("postgres health check against a real database", () => {
  it("is healthy through a working connection", async () => {
    const { probe } = await setUp();

    await expect(probe()).resolves.toBe(true);
  });

  it("stays bounded through a prolonged stall and recovers when the database returns", async () => {
    const { proxy, probe, maxRunning } = await setUp();
    await expect(probe()).resolves.toBe(true);

    proxy.mode = "stall";
    // Outlast the cached healthy result.
    await sleep(60);
    proxy.resetMax();
    const results: boolean[] = [];
    const until = Date.now() + 2_000;
    while (Date.now() < until) {
      results.push(await probe());
      await sleep(25);
    }

    // Each stalled check waits out its 150 ms timeout, so this spans many
    // 50 ms cache windows, each of which could have started another check.
    expect(results.length).toBeGreaterThanOrEqual(10);
    expect(results.every((healthy) => !healthy)).toBe(true);
    expect(maxRunning()).toBe(1);
    // The timed-out connection is destroyed before a new one opens.
    expect(proxy.maxOpen).toBeLessThanOrEqual(1);

    proxy.mode = "forward";
    let recovered = false;
    const deadline = Date.now() + 3_000;
    while (!recovered && Date.now() < deadline) {
      recovered = await probe();
      if (!recovered) await sleep(50);
    }
    expect(recovered).toBe(true);
  });

  // PR #33 re-review: the driver's end() only half-closes, so each timed-out
  // established connection stayed open against a peer that never closed.
  it("really closes every timed-out connection, even when the peer never finishes closing", async () => {
    const { proxy, probe } = await setUp({ holdHalfOpen: true });

    for (let cycle = 0; cycle < 4; cycle++) {
      proxy.mode = "forward";
      await sleep(60);
      let healthy = false;
      const deadline = Date.now() + 3_000;
      while (!healthy && Date.now() < deadline) {
        healthy = await probe();
        if (!healthy) await sleep(50);
      }
      expect(healthy).toBe(true);
      proxy.mode = "stall";
      await sleep(60);
      await expect(probe()).resolves.toBe(false);
      // Still stalled when the aborted check closes its connection.
      await sleep(200);
    }
    // Let the proxy's writes reach every client socket that was closed.
    await sleep(300);

    expect(proxy.open).toBe(0);

    proxy.mode = "forward";
    await sleep(60);
    let recovered = false;
    const deadline = Date.now() + 3_000;
    while (!recovered && Date.now() < deadline) {
      recovered = await probe();
      if (!recovered) await sleep(50);
    }
    expect(recovered).toBe(true);
    expect(proxy.open).toBe(1);
  });

  it("reports refused connections as unhealthy without crashing, then recovers", async () => {
    const { proxy, probe } = await setUp();
    proxy.mode = "refuse";

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(probe()).resolves.toBe(false);
      await sleep(60);
    }

    proxy.mode = "forward";
    await sleep(60);
    let recovered = false;
    const deadline = Date.now() + 3_000;
    while (!recovered && Date.now() < deadline) {
      recovered = await probe();
      if (!recovered) await sleep(50);
    }
    expect(recovered).toBe(true);
  });
});
