import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "fastify";
import { createFakeGitHubIdentityProvider } from "../auth/testing/fake-github-identity-provider";
import type { Database } from "../db/client";
import { cards, sessions } from "../db/schema";
import {
  TEST_OWNER_GITHUB_USER_ID,
  TEST_WRONG_GITHUB_USER_ID,
  buildTestApp,
} from "../testing/build-test-app";
import { createTestDatabase, databaseAvailable } from "../testing/test-database";

const SESSION_COOKIE = "pocketboard.sid";
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

function sessionCookie(response: LightMyRequestResponse): string | undefined {
  const cookie = response.cookies.find((candidate) => candidate.name === SESSION_COOKIE);
  return cookie?.value;
}

function cookieHeader(value: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${value}` };
}

async function signIn(app: FastifyInstance, headers: Record<string, string> = {}) {
  const response = await app.inject({
    method: "GET",
    url: "/auth/github/callback?code=test-code&state=test-state",
    headers,
  });
  const cookie = sessionCookie(response);
  if (!cookie) {
    throw new Error("sign-in did not establish a session cookie");
  }
  return { response, cookie };
}

async function csrfTokenFor(app: FastifyInstance, cookie: string): Promise<string> {
  const response = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: cookieHeader(cookie),
  });
  return response.json().csrfToken;
}

describe.skipIf(!databaseAvailable)("owner authentication (real PostgreSQL)", () => {
  let db: Database;
  let queryClient: Awaited<ReturnType<typeof createTestDatabase>>["queryClient"];

  beforeAll(async () => {
    const client = await createTestDatabase();
    db = client.db;
    queryClient = client.queryClient;
  });

  beforeEach(async () => {
    await queryClient`truncate table sessions`;
    await queryClient`truncate table cards`;
  });

  afterAll(async () => {
    await queryClient.end();
  });

  describe("unauthenticated access", () => {
    it.each([
      ["GET", "/cards"],
      ["GET", "/auth/session"],
    ])("rejects %s %s with 401 authentication_required", async (method, url) => {
      const app = await buildTestApp({ db });

      const response = await app.inject({ method: method as "GET", url });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "authentication_required" });
    });

    it("rejects an unauthenticated card creation with 401 before any CSRF check", async () => {
      const app = await buildTestApp({ db });

      const response = await app.inject({
        method: "POST",
        url: "/cards",
        payload: { title: "Should never persist" },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "authentication_required" });
      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it("rejects a forged session cookie", async () => {
      const app = await buildTestApp({ db });

      const response = await app.inject({
        method: "GET",
        url: "/cards",
        headers: cookieHeader("not-a-real-session-id"),
      });

      expect(response.statusCode).toBe(401);
    });

    it("creates no session row for an anonymous request", async () => {
      const app = await buildTestApp({ db });

      await app.inject({ method: "GET", url: "/cards" });

      expect(await db.select().from(sessions)).toHaveLength(0);
    });
  });

  describe("owner sign-in", () => {
    it("redirects the browser to the identity provider", async () => {
      const app = await buildTestApp({ db });

      const response = await app.inject({ method: "GET", url: "/auth/github" });

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain("code_challenge_method=S256");
    });

    it("establishes a session for the owner and redirects to the app", async () => {
      const app = await buildTestApp({ db });

      const { response, cookie } = await signIn(app);

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("http://127.0.0.1:5173/");
      expect(cookie).toBeTruthy();
      expect(await db.select().from(sessions)).toHaveLength(1);
    });

    it("issues an HttpOnly SameSite=Lax session cookie", async () => {
      const app = await buildTestApp({ db });

      const { response } = await signIn(app);
      const cookie = response.cookies.find((candidate) => candidate.name === SESSION_COOKIE);

      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite?.toLowerCase()).toBe("lax");
      expect(cookie?.path).toBe("/");
    });

    it("marks the session cookie Secure in production", async () => {
      const app = await buildTestApp({
        db,
        authConfig: { cookieSecure: true, trustedProxies: ["127.0.0.1"] },
      });

      const { response } = await signIn(app, { "x-forwarded-proto": "https" });
      const cookie = response.cookies.find((candidate) => candidate.name === SESSION_COOKIE);

      expect(cookie?.secure).toBe(true);
    });

    it("issues the Secure cookie behind a trusted TLS-terminating proxy", async () => {
      const app = await buildTestApp({
        db,
        authConfig: { cookieSecure: true, trustedProxies: ["127.0.0.1"] },
      });

      const { response } = await signIn(app, { "x-forwarded-proto": "https" });

      expect(response.statusCode).toBe(302);
      expect(sessionCookie(response)).toBeTruthy();
    });

    it("refuses to issue a Secure cookie over a connection it cannot see as TLS", async () => {
      // @fastify/session silently declines to save a Secure cookie when
      // `request.protocol` is not https. That is the correct fail-closed
      // behaviour: an unconfigured proxy boundary must not be papered over by
      // believing whatever the caller put in X-Forwarded-Proto.
      const app = await buildTestApp({
        db,
        authConfig: { cookieSecure: true, trustedProxies: [] },
      });

      const response = await app.inject({
        method: "GET",
        url: "/auth/github/callback?code=test-code&state=test-state",
        headers: { "x-forwarded-proto": "https" },
      });

      expect(sessionCookie(response)).toBeUndefined();
    });

    it("expires the session eight hours after login", async () => {
      const now = new Date("2026-09-16T09:00:00.000Z");
      const app = await buildTestApp({ db, now: () => now });

      const { cookie } = await signIn(app);
      const response = await app.inject({
        method: "GET",
        url: "/auth/session",
        headers: cookieHeader(cookie),
      });

      const [row] = await db.select().from(sessions);
      expect(row.expiresAt.getTime() - now.getTime()).toBeLessThanOrEqual(EIGHT_HOURS_MS);
      expect(response.json().githubUserId).toBe(TEST_OWNER_GITHUB_USER_ID);
    });

    it("returns the owner session without ever exposing an access token", async () => {
      const app = await buildTestApp({ db });

      const { cookie } = await signIn(app);
      const response = await app.inject({
        method: "GET",
        url: "/auth/session",
        headers: cookieHeader(cookie),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        authenticated: true,
        githubUserId: TEST_OWNER_GITHUB_USER_ID,
      });
      expect(JSON.stringify(response.json())).not.toMatch(/access_?token|gho_|ghu_/i);

      const [row] = await db.select().from(sessions);
      expect(JSON.stringify(row.data)).not.toMatch(/access_?token|gho_|ghu_/i);
    });
  });

  describe("wrong user", () => {
    it("denies a non-owner GitHub account with 403 access_denied", async () => {
      const app = await buildTestApp({
        db,
        identityProvider: createFakeGitHubIdentityProvider({
          githubUserId: TEST_WRONG_GITHUB_USER_ID,
        }),
      });

      const response = await app.inject({
        method: "GET",
        url: "/auth/github/callback?code=test-code&state=test-state",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "access_denied" });
    });

    it("creates no session for a non-owner", async () => {
      const app = await buildTestApp({
        db,
        identityProvider: createFakeGitHubIdentityProvider({
          githubUserId: TEST_WRONG_GITHUB_USER_ID,
        }),
      });

      const response = await app.inject({
        method: "GET",
        url: "/auth/github/callback?code=test-code&state=test-state",
      });

      expect(sessionCookie(response)).toBeUndefined();
      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it("denies an existing session once it no longer matches the configured owner", async () => {
      const app = await buildTestApp({ db });
      const { cookie } = await signIn(app);

      // The owner id changed (for example, the secret file was corrected).
      const reconfigured = await buildTestApp({
        db,
        authConfig: { ownerGitHubUserId: TEST_WRONG_GITHUB_USER_ID },
      });

      const response = await reconfigured.inject({
        method: "GET",
        url: "/cards",
        headers: cookieHeader(cookie),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "access_denied" });
      expect(await db.select().from(sessions)).toHaveLength(0);
    });
  });

  describe("failed exchanges", () => {
    it("returns 400 invalid_oauth_state when the state does not verify", async () => {
      const app = await buildTestApp({
        db,
        identityProvider: createFakeGitHubIdentityProvider({ failWith: "invalid_state" }),
      });

      const response = await app.inject({
        method: "GET",
        url: "/auth/github/callback?code=test-code&state=tampered",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_oauth_state" });
      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it("returns 502 oauth_exchange_failed when GitHub cannot be reached", async () => {
      const app = await buildTestApp({
        db,
        identityProvider: createFakeGitHubIdentityProvider({ failWith: "exchange_failed" }),
      });

      const response = await app.inject({
        method: "GET",
        url: "/auth/github/callback?code=test-code&state=test-state",
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: "oauth_exchange_failed" });
      expect(await db.select().from(sessions)).toHaveLength(0);
    });
  });

  describe("session rotation", () => {
    it("issues a new session id on every login", async () => {
      const app = await buildTestApp({ db });

      const first = await signIn(app);
      const second = await app.inject({
        method: "GET",
        url: "/auth/github/callback?code=test-code&state=test-state",
        headers: cookieHeader(first.cookie),
      });

      expect(sessionCookie(second)).not.toBe(first.cookie);
    });

    it("invalidates the pre-login session id, defeating session fixation", async () => {
      const app = await buildTestApp({ db });

      const first = await signIn(app);
      await app.inject({
        method: "GET",
        url: "/auth/github/callback?code=test-code&state=test-state",
        headers: cookieHeader(first.cookie),
      });

      const response = await app.inject({
        method: "GET",
        url: "/cards",
        headers: cookieHeader(first.cookie),
      });

      expect(response.statusCode).toBe(401);
      expect(await db.select().from(sessions)).toHaveLength(1);
    });
  });

  describe("session expiry", () => {
    it("rejects a session once its eight-hour window has passed", async () => {
      const loginAt = new Date("2026-09-16T09:00:00.000Z");
      const app = await buildTestApp({ db, now: () => loginAt });
      const { cookie } = await signIn(app);

      const laterApp = await buildTestApp({
        db,
        now: () => new Date(loginAt.getTime() + EIGHT_HOURS_MS + 1000),
      });

      const response = await laterApp.inject({
        method: "GET",
        url: "/cards",
        headers: cookieHeader(cookie),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "authentication_required" });
    });

    it("deletes the expired row rather than leaving it readable", async () => {
      const loginAt = new Date("2026-09-16T09:00:00.000Z");
      const app = await buildTestApp({ db, now: () => loginAt });
      const { cookie } = await signIn(app);

      const laterApp = await buildTestApp({
        db,
        now: () => new Date(loginAt.getTime() + EIGHT_HOURS_MS + 1000),
      });
      await laterApp.inject({ method: "GET", url: "/cards", headers: cookieHeader(cookie) });

      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it("still accepts the session just before it expires", async () => {
      const loginAt = new Date("2026-09-16T09:00:00.000Z");
      const app = await buildTestApp({ db, now: () => loginAt });
      const { cookie } = await signIn(app);

      const response = await app.inject({
        method: "GET",
        url: "/cards",
        headers: cookieHeader(cookie),
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe("logout", () => {
    it("clears the session and returns 204", async () => {
      const app = await buildTestApp({ db });
      const { cookie } = await signIn(app);
      const csrfToken = await csrfTokenFor(app, cookie);

      const response = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { ...cookieHeader(cookie), "x-csrf-token": csrfToken },
      });

      expect(response.statusCode).toBe(204);
      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it("invalidates the cookie so it cannot be replayed after logout", async () => {
      const app = await buildTestApp({ db });
      const { cookie } = await signIn(app);
      const csrfToken = await csrfTokenFor(app, cookie);

      await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { ...cookieHeader(cookie), "x-csrf-token": csrfToken },
      });

      const replay = await app.inject({
        method: "GET",
        url: "/cards",
        headers: cookieHeader(cookie),
      });

      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toEqual({ error: "authentication_required" });
    });

    it("requires authentication before CSRF, so an anonymous logout is 401", async () => {
      const app = await buildTestApp({ db });

      const response = await app.inject({ method: "POST", url: "/auth/logout" });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("CSRF protection", () => {
    it("rejects a logout with no CSRF token", async () => {
      const app = await buildTestApp({ db });
      const { cookie } = await signIn(app);
      await csrfTokenFor(app, cookie);

      const response = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: cookieHeader(cookie),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "csrf_token_invalid" });
      expect(await db.select().from(sessions)).toHaveLength(1);
    });

    it("rejects card creation with no CSRF token", async () => {
      const app = await buildTestApp({ db });
      const { cookie } = await signIn(app);
      await csrfTokenFor(app, cookie);

      const response = await app.inject({
        method: "POST",
        url: "/cards",
        headers: cookieHeader(cookie),
        payload: { title: "Forged card" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "csrf_token_invalid" });
      expect(await db.select().from(cards)).toHaveLength(0);
    });

    it("rejects card creation with a token from a different session", async () => {
      const app = await buildTestApp({ db });
      const owner = await signIn(app);
      await csrfTokenFor(app, owner.cookie);

      const other = await app.inject({
        method: "GET",
        url: "/auth/github/callback?code=test-code&state=test-state",
      });
      const otherCookie = sessionCookie(other) as string;
      const otherToken = await csrfTokenFor(app, otherCookie);

      const response = await app.inject({
        method: "POST",
        url: "/cards",
        headers: { ...cookieHeader(owner.cookie), "x-csrf-token": otherToken },
        payload: { title: "Cross-session card" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "csrf_token_invalid" });
    });

    it("does not name the CSRF plugin or its internal code in the rejection", async () => {
      const app = await buildTestApp({ db });
      const { cookie } = await signIn(app);
      await csrfTokenFor(app, cookie);

      const response = await app.inject({
        method: "POST",
        url: "/cards",
        headers: { ...cookieHeader(cookie), "x-csrf-token": "forged" },
        payload: { title: "Forged card" },
      });

      expect(response.body).not.toContain("FST_CSRF");
      expect(response.body).not.toContain("Forbidden");
    });

    it("accepts card creation with a matching CSRF token", async () => {
      const app = await buildTestApp({ db });
      const { cookie } = await signIn(app);
      const csrfToken = await csrfTokenFor(app, cookie);

      const response = await app.inject({
        method: "POST",
        url: "/cards",
        headers: { ...cookieHeader(cookie), "x-csrf-token": csrfToken },
        payload: { title: "Legitimate card" },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ title: "Legitimate card", status: "backlog" });
    });

    it("does not require a CSRF token for a safe read", async () => {
      const app = await buildTestApp({ db });
      const { cookie } = await signIn(app);

      const response = await app.inject({
        method: "GET",
        url: "/cards",
        headers: cookieHeader(cookie),
      });

      expect(response.statusCode).toBe(200);
    });
  });
});
