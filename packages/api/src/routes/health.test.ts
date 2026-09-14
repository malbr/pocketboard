import { describe, expect, it } from "vitest";
import { buildApp } from "../app";
import type { Database } from "../db/client";

describe("GET /health", () => {
  it("returns 200 with an ok status without touching the database", async () => {
    const app = buildApp({} as Database);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
