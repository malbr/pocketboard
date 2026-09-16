import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type OAuthFailureCode = "invalid_state" | "exchange_failed";

export class OAuthFailure extends Error {
  readonly code: OAuthFailureCode;

  constructor(code: OAuthFailureCode) {
    super(`GitHub OAuth failed: ${code}`);
    this.name = "OAuthFailure";
    this.code = code;
  }
}

/**
 * The seam that lets tests drive the callback route without talking to GitHub.
 *
 * Only two implementations exist: the real one in `github-oauth.ts`, wired by
 * the composition root, and the fake under `testing/`, which is never imported
 * from a production module (enforced by `composition-root.test.ts`).
 */
export interface GitHubIdentityProvider {
  /** Registers any plugins the provider needs. Called once during buildApp. */
  register(app: FastifyInstance): Promise<void>;

  /** Redirects the browser to GitHub's authorize endpoint. */
  startAuthorization(request: FastifyRequest, reply: FastifyReply): Promise<void>;

  /**
   * Completes the authorization-code exchange and resolves the caller's
   * immutable numeric GitHub user id. The access token is used only to make
   * that one call and is discarded; it is never returned, logged, or stored.
   */
  completeAuthorization(request: FastifyRequest, reply: FastifyReply): Promise<number>;
}
