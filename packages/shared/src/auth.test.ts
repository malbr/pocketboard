import { describe, expect, it } from "vitest";
import { AuthErrorCode, authErrorSchema, sessionSchema } from "./auth";

describe("sessionSchema", () => {
  const validSession = {
    authenticated: true as const,
    githubUserId: 325861437,
    csrfToken: "a-csrf-token",
    expiresAt: new Date("2026-09-16T12:00:00.000Z").toISOString(),
  };

  it("accepts an authenticated owner session", () => {
    expect(sessionSchema.parse(validSession)).toEqual(validSession);
  });

  it("rejects unknown properties so the API cannot leak extra identity fields", () => {
    expect(
      sessionSchema.safeParse({ ...validSession, accessToken: "gho_should_never_be_here" }).success,
    ).toBe(false);
  });

  it("rejects a non-integer or non-positive github user id", () => {
    expect(sessionSchema.safeParse({ ...validSession, githubUserId: 1.5 }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...validSession, githubUserId: 0 }).success).toBe(false);
  });

  it("rejects an empty csrf token", () => {
    expect(sessionSchema.safeParse({ ...validSession, csrfToken: "" }).success).toBe(false);
  });

  it("rejects an expiry that is not an ISO datetime", () => {
    expect(sessionSchema.safeParse({ ...validSession, expiresAt: "soon" }).success).toBe(false);
  });
});

describe("authErrorSchema", () => {
  it.each([
    AuthErrorCode.AuthenticationRequired,
    AuthErrorCode.AccessDenied,
    AuthErrorCode.CsrfTokenInvalid,
    AuthErrorCode.InvalidOAuthState,
    AuthErrorCode.OAuthExchangeFailed,
  ])("accepts the deterministic error code %s", (error) => {
    expect(authErrorSchema.parse({ error })).toEqual({ error });
  });

  it("rejects an undeclared error code", () => {
    expect(authErrorSchema.safeParse({ error: "something_went_wrong" }).success).toBe(false);
  });

  it("keeps authentication_required and access_denied distinct", () => {
    expect(AuthErrorCode.AuthenticationRequired).toBe("authentication_required");
    expect(AuthErrorCode.AccessDenied).toBe("access_denied");
  });
});
