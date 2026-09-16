import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { CleanupTimers } from "./auth/session-cleanup";
import type { Database } from "./db/client";
import { buildTestApp } from "./testing/build-test-app";

/**
 * `/health` needs no database, so these cases exercise the app's own wiring
 * without PostgreSQL. `auth.test.ts` covers what the proxy boundary means for a
 * real session cookie.
 */
async function observeProtocol(
  app: FastifyInstance,
  headers: Record<string, string>,
  remoteAddress: string,
): Promise<string> {
  let protocol = "";
  app.addHook("onRequest", async (request) => {
    protocol = request.protocol;
  });

  await app.inject({ method: "GET", url: "/health", headers, remoteAddress });
  return protocol;
}

const noDatabase = {} as Database;

describe("reverse proxy boundary", () => {
  it("believes X-Forwarded-Proto from a configured proxy", async () => {
    const app = await buildTestApp({
      db: noDatabase,
      authConfig: { trustedProxies: ["127.0.0.1"] },
    });

    // The production deployment terminates TLS in front of the API, so without
    // this the connection looks plaintext and @fastify/session refuses to send
    // the Secure cookie — login appears to succeed and nothing is set.
    expect(await observeProtocol(app, { "x-forwarded-proto": "https" }, "127.0.0.1")).toBe("https");
  });

  it("ignores X-Forwarded-Proto when no proxy is configured", async () => {
    const app = await buildTestApp({ db: noDatabase, authConfig: { trustedProxies: [] } });

    expect(await observeProtocol(app, { "x-forwarded-proto": "https" }, "127.0.0.1")).toBe("http");
  });

  it("ignores X-Forwarded-Proto from a peer outside the configured list", async () => {
    const app = await buildTestApp({
      db: noDatabase,
      authConfig: { trustedProxies: ["127.0.0.1"] },
    });

    // Trusting the header itself, rather than the peer that set it, would let
    // any caller claim an https connection.
    expect(await observeProtocol(app, { "x-forwarded-proto": "https" }, "203.0.113.9")).toBe("http");
  });
});

describe("expired session cleanup lifecycle", () => {
  function recordingTimers() {
    const cleared: unknown[] = [];
    const timers: CleanupTimers = {
      setInterval: vi.fn(() => ({ unref: vi.fn() })),
      clearInterval: vi.fn((handle) => {
        cleared.push(handle);
      }),
    };
    return { timers, cleared };
  }

  it("runs no background sweep unless the composition root asks for one", async () => {
    const { timers } = recordingTimers();

    await buildTestApp({ db: noDatabase });

    expect(timers.setInterval).not.toHaveBeenCalled();
  });

  it("stops the sweep when the app closes", async () => {
    const { timers, cleared } = recordingTimers();
    const app = await buildTestApp({
      db: noDatabase,
      sessionCleanup: { intervalMs: 900_000, timers },
    });

    expect(timers.setInterval).toHaveBeenCalledTimes(1);

    await app.close();

    expect(cleared).toHaveLength(1);
  });
});
