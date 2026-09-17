import { OAuthFailure, type GitHubIdentityProvider } from "../github-identity-provider";

/**
 * TEST ONLY. Never import this from a production module — `buildApp` takes the
 * provider as a dependency precisely so this stays out of the server binary,
 * and `composition-root.test.ts` fails the build if that rule is broken.
 */
export interface FakeGitHubIdentityProviderOptions {
  /** The numeric GitHub id the fake callback resolves to. */
  githubUserId?: number;
  /** Make the exchange fail instead of resolving an id. */
  failWith?: "invalid_state" | "exchange_failed";
  /** Where `startAuthorization` pretends to send the browser. */
  authorizeUrl?: string;
}

export function createFakeGitHubIdentityProvider(
  options: FakeGitHubIdentityProviderOptions = {},
): GitHubIdentityProvider & { completeAuthorizationCalls: number } {
  const {
    githubUserId = 325861437,
    failWith,
    authorizeUrl = "https://github.test/login/oauth/authorize?client_id=fake&code_challenge_method=S256",
  } = options;

  return {
    completeAuthorizationCalls: 0,

    async register(): Promise<void> {},

    async startAuthorization(_request, reply): Promise<void> {
      reply.redirect(authorizeUrl);
    },

    async completeAuthorization(): Promise<number> {
      this.completeAuthorizationCalls += 1;
      if (failWith) {
        throw new OAuthFailure(failWith);
      }
      return githubUserId;
    },
  };
}
