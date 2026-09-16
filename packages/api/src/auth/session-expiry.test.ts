import { describe, expect, it } from "vitest";
import { isExpired, resolveExpiresAt } from "./session-expiry";

const TTL_MS = 8 * 60 * 60 * 1000;
const NOW = new Date("2026-09-16T09:00:00.000Z");

describe("resolveExpiresAt", () => {
  it("uses the session cookie's own expiry when the plugin has set one", () => {
    const expires = new Date("2026-09-16T17:00:00.000Z");

    expect(resolveExpiresAt({ cookie: { expires } }, NOW, TTL_MS)).toEqual(expires);
  });

  it("accepts an ISO string expiry, because jsonb round-trips Date to string", () => {
    const expires = new Date("2026-09-16T17:00:00.000Z");

    expect(resolveExpiresAt({ cookie: { expires: expires.toISOString() } }, NOW, TTL_MS)).toEqual(
      expires,
    );
  });

  it("falls back to now plus the eight-hour ttl when the cookie has no expiry", () => {
    expect(resolveExpiresAt({ cookie: {} }, NOW, TTL_MS)).toEqual(
      new Date("2026-09-16T17:00:00.000Z"),
    );
  });

  it("falls back to the ttl when the session has no cookie at all", () => {
    expect(resolveExpiresAt({}, NOW, TTL_MS)).toEqual(new Date("2026-09-16T17:00:00.000Z"));
  });

  it("falls back to the ttl rather than trusting an unparseable expiry", () => {
    expect(resolveExpiresAt({ cookie: { expires: "whenever" } }, NOW, TTL_MS)).toEqual(
      new Date("2026-09-16T17:00:00.000Z"),
    );
  });

  it("never extends a session beyond the ttl, even if the cookie asks for more", () => {
    const farFuture = new Date("2027-01-01T00:00:00.000Z");

    expect(resolveExpiresAt({ cookie: { expires: farFuture } }, NOW, TTL_MS)).toEqual(
      new Date("2026-09-16T17:00:00.000Z"),
    );
  });
});

describe("isExpired", () => {
  it("treats a future expiry as live", () => {
    expect(isExpired(new Date("2026-09-16T09:00:00.001Z"), NOW)).toBe(false);
  });

  it("treats a past expiry as expired", () => {
    expect(isExpired(new Date("2026-09-16T08:59:59.999Z"), NOW)).toBe(true);
  });

  it("treats an exactly-now expiry as expired, failing closed on the boundary", () => {
    expect(isExpired(NOW, NOW)).toBe(true);
  });

  it("treats an invalid expiry as expired rather than trusting it", () => {
    expect(isExpired(new Date("nonsense"), NOW)).toBe(true);
  });
});
