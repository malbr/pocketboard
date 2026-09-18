import { describe, expect, it } from "vitest";
import { ApiErrorCode, rateLimitedSchema } from "./error";

describe("rateLimitedSchema", () => {
  it("accepts the rate-limit body", () => {
    expect(rateLimitedSchema.parse({ error: "rate_limited" })).toEqual({
      error: ApiErrorCode.RateLimited,
    });
  });

  it("rejects extra fields, so limiter internals such as counts or keys never leak", () => {
    expect(rateLimitedSchema.safeParse({ error: "rate_limited", max: 10 }).success).toBe(false);
  });

  it("rejects any other error code", () => {
    expect(rateLimitedSchema.safeParse({ error: "internal_error" }).success).toBe(false);
  });
});
