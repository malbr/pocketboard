import { createHash } from "node:crypto";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { testAuthConfig } from "../testing/build-test-app";
import { createGitHubOAuthProvider } from "./github-oauth";

it("redirects to GitHub without requesting a scope while preserving state and PKCE", async () => {
  const app = Fastify();
  const config = testAuthConfig();
  const provider = createGitHubOAuthProvider(config);

  try {
    await provider.register(app);
    app.get("/auth/github", (request, reply) => provider.startAuthorization(request, reply));

    const response = await app.inject({ method: "GET", url: "/auth/github" });
    const location = response.headers.location;
    if (typeof location !== "string") {
      throw new Error("GitHub authorization redirect is missing");
    }
    const url = new URL(location);

    expect(response.statusCode).toBe(302);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(config.githubClientId);
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.get("redirect_uri")).toBe(`${config.appBaseUrl}/api/auth/github/callback`);
    const stateCookie = response.cookies.find((cookie) => cookie.name === "oauth2-redirect-state");
    expect(url.searchParams.get("state")).toBe(stateCookie?.value);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const verifierCookie = response.cookies.find((cookie) => cookie.name === "oauth2-code-verifier");
    if (!verifierCookie?.value) {
      throw new Error("PKCE verifier cookie is missing");
    }
    const challenge = createHash("sha256").update(verifierCookie.value).digest("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
  } finally {
    await app.close();
  }
});
