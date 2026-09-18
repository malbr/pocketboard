import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiErrorCode, rateLimitedSchema } from "@pocketboard/shared";
import { createFakeGitHubIdentityProvider } from "./auth/testing/fake-github-identity-provider";
import type { Database } from "./db/client";
import { AUTH_ROUTE_LIMIT, DEFAULT_ROUTE_LIMIT } from "./rate-limit";
import { buildTestApp } from "./testing/build-test-app";

/**
 * Every case here is answered before any database access: the limited routes
 * either redirect, fail the fake OAuth exchange, or stop at the owner guard,
 * so no PostgreSQL is needed.
 */
const noDatabase = {} as Database;

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function app(options: Parameters<typeof buildTestApp>[0] = { db: noDatabase }) {
  const built = await buildTestApp(options);
  apps.push(built);
  return built;
}

async function hit(
  target: FastifyInstance,
  url: string,
  times: number,
  request: { remoteAddress?: string; headers?: Record<string, string> } = {},
) {
  const responses = [];
  for (let i = 0; i < times; i += 1) {
    responses.push(await target.inject({ method: "GET", url, ...request }));
  }
  return responses;
}

describe("rate limiting", () => {
  it("allows the OAuth start route up to its limit, then answers 429 with the shared body", async () => {
    const target = await app();
    const responses = await hit(target, "/auth/github", AUTH_ROUTE_LIMIT.max + 1);

    expect(responses.slice(0, AUTH_ROUTE_LIMIT.max).every((r) => r.statusCode === 302)).toBe(true);
    const limited = responses[AUTH_ROUTE_LIMIT.max];
    expect(limited.statusCode).toBe(429);
    expect(rateLimitedSchema.parse(limited.json())).toEqual({ error: ApiErrorCode.RateLimited });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("stops the OAuth callback before any GitHub exchange once the limit is reached", async () => {
    const provider = createFakeGitHubIdentityProvider({ failWith: "invalid_state" });
    const target = await app({ db: noDatabase, identityProvider: provider });
    const responses = await hit(target, "/auth/github/callback?code=c&state=s", AUTH_ROUTE_LIMIT.max + 3);

    expect(responses.slice(AUTH_ROUTE_LIMIT.max).every((r) => r.statusCode === 429)).toBe(true);
    // The limited requests never reached the handler, so no code exchange ran.
    expect(provider.completeAuthorizationCalls).toBe(AUTH_ROUTE_LIMIT.max);
  });

  it("limits other routes at the looser default", async () => {
    const target = await app();
    const responses = await hit(target, "/cards", DEFAULT_ROUTE_LIMIT.max + 1);

    expect(responses.slice(0, DEFAULT_ROUTE_LIMIT.max).every((r) => r.statusCode === 401)).toBe(true);
    expect(responses[DEFAULT_ROUTE_LIMIT.max].statusCode).toBe(429);
    expect(AUTH_ROUTE_LIMIT.max).toBeLessThan(DEFAULT_ROUTE_LIMIT.max);
  });

  it("never limits /health, so container and uptime checks keep working", async () => {
    const target = await app();
    const responses = await hit(target, "/health", DEFAULT_ROUTE_LIMIT.max + 5);

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
  });

  it("counts each forwarded client separately behind a trusted proxy", async () => {
    const target = await app({ db: noDatabase, authConfig: { trustedProxies: ["127.0.0.1"] } });

    const first = await hit(target, "/auth/github", AUTH_ROUTE_LIMIT.max + 1, {
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    const second = await hit(target, "/auth/github", 1, {
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.20" },
    });

    expect(first[AUTH_ROUTE_LIMIT.max].statusCode).toBe(429);
    // A different real client behind the same proxy has its own budget.
    expect(second[0].statusCode).toBe(302);
  });

  it("ignores X-Forwarded-For from an untrusted peer, so rotating it cannot evade the limit", async () => {
    const target = await app({ db: noDatabase, authConfig: { trustedProxies: ["127.0.0.1"] } });

    const responses = [];
    for (let i = 0; i <= AUTH_ROUTE_LIMIT.max; i += 1) {
      responses.push(
        await target.inject({
          method: "GET",
          url: "/auth/github",
          remoteAddress: "198.51.100.7",
          headers: { "x-forwarded-for": `203.0.113.${i + 1}` },
        }),
      );
    }

    expect(responses[AUTH_ROUTE_LIMIT.max].statusCode).toBe(429);
  });
});
