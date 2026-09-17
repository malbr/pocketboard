import oauth2, { type OAuth2Namespace } from "@fastify/oauth2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthConfig } from "../config/auth-config";
import { OAuthFailure, type GitHubIdentityProvider } from "./github-identity-provider";

const NAMESPACE = "oauth2GitHub";
const GITHUB_USER_ENDPOINT = "https://api.github.com/user";

/**
 * Only the immutable numeric id is read. The login handle is deliberately
 * ignored because GitHub lets users rename themselves, and a renamed handle
 * can later be claimed by somebody else.
 */
const githubUserSchema = z.object({ id: z.number().int().positive() });

function namespaceOf(app: FastifyInstance): OAuth2Namespace {
  const namespace = app[NAMESPACE];
  if (!namespace) {
    throw new OAuthFailure("exchange_failed");
  }
  return namespace;
}

async function fetchAuthenticatedUserId(accessToken: string): Promise<number> {
  let response: Response;
  try {
    response = await fetch(GITHUB_USER_ENDPOINT, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "pocketboard",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    throw new OAuthFailure("exchange_failed");
  }

  if (!response.ok) {
    throw new OAuthFailure("exchange_failed");
  }

  const parsed = githubUserSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new OAuthFailure("exchange_failed");
  }
  return parsed.data.id;
}

export function createGitHubOAuthProvider(config: AuthConfig): GitHubIdentityProvider {
  return {
    async register(app: FastifyInstance): Promise<void> {
      await app.register(oauth2, {
        name: NAMESPACE,
        credentials: {
          client: { id: config.githubClientId, secret: config.githubClientSecret },
          auth: oauth2.GITHUB_CONFIGURATION,
        },
        // `scope` is intentionally omitted. PocketBoard needs identity only, so
        // the token it briefly holds grants no repository or account access.
        callbackUri: `${config.appBaseUrl}/api/auth/github/callback`,
        pkce: "S256",
        cookie: {
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          secure: config.cookieSecure,
        },
      });
    },

    async startAuthorization(request, reply): Promise<void> {
      // Generating the URI here (rather than using startRedirectPath) is what
      // sets the state and PKCE verifier cookies for this browser.
      const uri = await namespaceOf(request.server).generateAuthorizationUri(request, reply);
      reply.redirect(uri);
    },

    async completeAuthorization(request, reply): Promise<number> {
      let accessToken: string;
      try {
        const result = await namespaceOf(request.server).getAccessTokenFromAuthorizationCodeFlow(
          request,
          reply,
        );
        accessToken = result.token.access_token;
      } catch (error) {
        if (error instanceof OAuthFailure) {
          throw error;
        }
        const message = error instanceof Error ? error.message : "";
        throw new OAuthFailure(message === "Invalid state" ? "invalid_state" : "exchange_failed");
      }

      // The token leaves scope the moment this returns; nothing persists it.
      return fetchAuthenticatedUserId(accessToken);
    },
  };
}
