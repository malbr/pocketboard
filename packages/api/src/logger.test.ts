import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { createFakeGitHubIdentityProvider } from "./auth/testing/fake-github-identity-provider";
import type { Database } from "./db/client";
import { apiLoggerOptions } from "./logger";
import { testAuthConfig } from "./testing/build-test-app";

describe("API request logging", () => {
  it("redacts OAuth callback values while retaining the route and status", async () => {
    const lines: string[] = [];
    const app = await buildApp({
      db: {} as Database,
      authConfig: testAuthConfig(),
      identityProvider: createFakeGitHubIdentityProvider({ failWith: "invalid_state" }),
      logger: {
        ...apiLoggerOptions("info"),
        stream: { write(line: string) { lines.push(line); } },
      },
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/auth/github/callback?code=oauth-code-canary&state=oauth-state-canary&page=2&access_token=oauth-token-canary&code=second-code-canary",
      });
      expect(response.statusCode).toBe(400);

      const output = lines.join("");
      expect(output).not.toContain("oauth-code-canary");
      expect(output).not.toContain("oauth-state-canary");
      expect(output).not.toContain("oauth-token-canary");
      expect(output).not.toContain("second-code-canary");
      expect(output).toContain("/auth/github/callback");
      expect(output).toContain("page=2");
      expect(output).toContain('"statusCode":400');

      const error = Object.assign(new Error("error-message-canary"), {
        parameters: ["error-parameter-canary"],
      });
      app.log.error({ err: error }, "error logging still works");
      const errorOutput = lines.join("");
      expect(errorOutput).toContain("error-message-canary");
      expect(errorOutput).not.toContain("error-parameter-canary");
    } finally {
      await app.close();
    }
  });
});
