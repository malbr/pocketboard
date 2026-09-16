import { describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { buildTestApp } from "../testing/build-test-app";

describe("GET /health", () => {
  it("returns 200 with an ok status without touching the database", async () => {
    const app = await buildTestApp({ db: {} as Database });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("stays reachable without a session, so deploy health checks never need auth", async () => {
    const app = await buildTestApp({ db: {} as Database });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});
