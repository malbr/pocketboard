import { z } from "zod";

/**
 * Deterministic auth failures. The API distinguishes "you are not signed in"
 * (401) from "you are signed in as somebody who is not the owner" (403) so the
 * frontend can tell a fresh visitor apart from a rejected account.
 */
export const AuthErrorCode = {
  AuthenticationRequired: "authentication_required",
  AccessDenied: "access_denied",
  CsrfTokenInvalid: "csrf_token_invalid",
  InvalidOAuthState: "invalid_oauth_state",
  OAuthExchangeFailed: "oauth_exchange_failed",
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

export const authErrorSchema = z
  .object({
    error: z.enum([
      AuthErrorCode.AuthenticationRequired,
      AuthErrorCode.AccessDenied,
      AuthErrorCode.CsrfTokenInvalid,
      AuthErrorCode.InvalidOAuthState,
      AuthErrorCode.OAuthExchangeFailed,
    ]),
  })
  .strict();

export type AuthError = z.infer<typeof authErrorSchema>;

/**
 * `.strict()` is load-bearing: it makes an accidental `accessToken` or GitHub
 * profile field on this response a test failure rather than a silent leak.
 */
export const sessionSchema = z
  .object({
    authenticated: z.literal(true),
    githubUserId: z.number().int().positive(),
    csrfToken: z.string().min(1),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type Session = z.infer<typeof sessionSchema>;
