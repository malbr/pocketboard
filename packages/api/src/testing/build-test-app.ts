import type { FastifyInstance } from "fastify";
import { buildApp, type AppDependencies } from "../app";
import type { GitHubIdentityProvider } from "../auth/github-identity-provider";
import { createFakeGitHubIdentityProvider } from "../auth/testing/fake-github-identity-provider";
import type { AuthConfig } from "../config/auth-config";
import type { Database } from "../db/client";

/** The owner id used across tests. Not a secret; GitHub user ids are public. */
export const TEST_OWNER_GITHUB_USER_ID = 325861437;
export const TEST_WRONG_GITHUB_USER_ID = 99999999;

/**
 * Placeholder credentials only. Real values live in root-owned files on the
 * host and are never read, printed, or committed by tests.
 */
export function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    githubClientId: "test-client-id",
    githubClientSecret: "test-client-secret",
    sessionSecret: "test-session-secret-at-least-32-chars",
    ownerGitHubUserId: TEST_OWNER_GITHUB_USER_ID,
    appBaseUrl: "http://127.0.0.1:5173",
    cookieSecure: false,
    sessionTtlMs: 8 * 60 * 60 * 1000,
    trustedProxies: [],
    ...overrides,
  };
}

export interface TestAppOptions {
  db: Database;
  identityProvider?: GitHubIdentityProvider;
  authConfig?: Partial<AuthConfig>;
  now?: () => Date;
  sessionCleanup?: AppDependencies["sessionCleanup"];
}

export function buildTestApp(options: TestAppOptions): Promise<FastifyInstance> {
  return buildApp({
    db: options.db,
    authConfig: testAuthConfig(options.authConfig),
    identityProvider: options.identityProvider ?? createFakeGitHubIdentityProvider(),
    now: options.now,
    sessionCleanup: options.sessionCleanup,
  });
}
