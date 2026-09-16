import { AuthErrorCode } from "@pocketboard/shared";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_OWNER_KEY = "githubUserId";

/**
 * The single authorization boundary for every protected route.
 *
 * 401 and 403 are kept distinct and deterministic: 401 means "no usable
 * session", 403 means "a valid session that does not belong to the owner".
 * The second case is reachable after the configured owner id changes, so the
 * guard re-checks identity on every request instead of trusting login time.
 */
export function createRequireOwner(ownerGitHubUserId: number) {
  return async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = request.session;
    const githubUserId = session?.get(SESSION_OWNER_KEY);

    if (typeof githubUserId !== "number") {
      await reply.status(401).send({ error: AuthErrorCode.AuthenticationRequired });
      return;
    }

    if (githubUserId !== ownerGitHubUserId) {
      // Fail closed: drop the session so a demoted identity cannot keep
      // presenting the same cookie.
      await session.destroy();
      await reply.status(403).send({ error: AuthErrorCode.AccessDenied });
      return;
    }
  };
}
