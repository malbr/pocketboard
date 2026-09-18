import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../db/client";
import { buildTestApp } from "../testing/build-test-app";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "../testing/test-database";

/** Just enough of Drizzle for the health probe's `select 1`. */
function fakeDb(execute: () => Promise<unknown>): Database {
  return { execute } as unknown as Database;
}

describe("GET /health", () => {
  it("returns 200 with an ok status when the database answers", async () => {
    const app = await buildTestApp({ db: fakeDb(async () => []) });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("returns 503 without internal detail when the database does not answer", async () => {
    const app = await buildTestApp({
      db: fakeDb(() => Promise.reject(new Error("password authentication failed for user pocketboard"))),
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
    expect(response.body).not.toContain("password");
  });

  it("stays reachable without a session, so deploy health checks never need auth", async () => {
    const app = await buildTestApp({ db: fakeDb(async () => []) });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});

describe.skipIf(!databaseAvailable)("GET /health against PostgreSQL", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.queryClient.end();
  });

  it("reports ok when the real database answers", async () => {
    const app = await buildTestApp({ db: database.db });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
