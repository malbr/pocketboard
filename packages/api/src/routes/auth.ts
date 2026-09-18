import { AuthErrorCode, type Session as SessionResponse } from "@pocketboard/shared";
import type { FastifyInstance, preHandlerAsyncHookHandler, FastifyRequest } from "fastify";
import type { AuthConfig } from "../config/auth-config";
import { OAuthFailure, type GitHubIdentityProvider } from "../auth/github-identity-provider";
import { SESSION_OWNER_KEY } from "../auth/require-owner";
import "../auth/session-augmentation";
import { authRouteRateLimit } from "../rate-limit";

export interface AuthRouteDependencies {
  config: AuthConfig;
  provider: GitHubIdentityProvider;
  requireOwner: preHandlerAsyncHookHandler;
}

function sessionExpiresAt(request: FastifyRequest, ttlMs: number): string {
  const expires = request.session.cookie?.expires;
  return expires ? new Date(expires).toISOString() : new Date(Date.now() + ttlMs).toISOString();
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDependencies): void {
  const { config, provider, requireOwner } = deps;

  app.get("/auth/github", { config: authRouteRateLimit }, async (request, reply) => {
    await provider.startAuthorization(request, reply);
  });

  app.get("/auth/github/callback", { config: authRouteRateLimit }, async (request, reply) => {
    let githubUserId: number;
    try {
      githubUserId = await provider.completeAuthorization(request, reply);
    } catch (error) {
      if (error instanceof OAuthFailure && error.code === "invalid_state") {
        return reply.status(400).send({ error: AuthErrorCode.InvalidOAuthState });
      }
      return reply.status(502).send({ error: AuthErrorCode.OAuthExchangeFailed });
    }

    if (githubUserId !== config.ownerGitHubUserId) {
      // A non-owner never gets a session row at all.
      return reply.status(403).send({ error: AuthErrorCode.AccessDenied });
    }

    // Rotate the session id on privilege change so a pre-login cookie planted
    // by an attacker cannot survive into the authenticated session.
    await request.session.regenerate();
    request.session.set(SESSION_OWNER_KEY, githubUserId);
    // Seeds the CSRF secret into the freshly rotated session.
    reply.generateCsrf();

    return reply.redirect(`${config.appBaseUrl}/`);
  });

  app.get("/auth/session", { preHandler: requireOwner }, async (request, reply) => {
    const body: SessionResponse = {
      authenticated: true,
      githubUserId: config.ownerGitHubUserId,
      csrfToken: reply.generateCsrf(),
      expiresAt: sessionExpiresAt(request, config.sessionTtlMs),
    };
    return reply.status(200).send(body);
  });

  app.post(
    "/auth/logout",
    { preHandler: [requireOwner, app.csrfProtection] },
    async (request, reply) => {
      await request.session.destroy();
      return reply.status(204).send();
    },
  );
}
