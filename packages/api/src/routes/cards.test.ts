import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Database } from "../db/client";
import { cards } from "../db/schema";
import { buildTestApp } from "../testing/build-test-app";
import { createTestDatabase, databaseAvailable } from "../testing/test-database";

const SESSION_COOKIE = "pocketboard.sid";

/**
 * Card routes are owner-only, so every case here signs in first. The
 * unauthenticated and wrong-user paths are covered in `auth.test.ts`.
 */
async function signedInApp(db: Database) {
  const app = await buildTestApp({ db });
  const login = await app.inject({
    method: "GET",
    url: "/auth/github/callback?code=test-code&state=test-state",
  });
  const cookie = login.cookies.find((candidate) => candidate.name === SESSION_COOKIE)?.value;
  if (!cookie) {
    throw new Error("sign-in did not establish a session cookie");
  }

  const session = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  });

  return { app, cookie, csrfToken: session.json().csrfToken as string };
}

function postCard(
  app: FastifyInstance,
  auth: { cookie: string; csrfToken: string },
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/cards",
    headers: {
      cookie: `${SESSION_COOKIE}=${auth.cookie}`,
      "x-csrf-token": auth.csrfToken,
    },
    payload,
  });
}

describe.skipIf(!databaseAvailable)("card routes (real PostgreSQL)", () => {
  let db: Database;
  let queryClient: Awaited<ReturnType<typeof createTestDatabase>>["queryClient"];

  beforeAll(async () => {
    const client = await createTestDatabase();
    db = client.db;
    queryClient = client.queryClient;
  });

  beforeEach(async () => {
    await queryClient`truncate table cards`;
    await queryClient`truncate table sessions`;
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("creates a Backlog card and returns it", async () => {
    const { app, ...auth } = await signedInApp(db);

    const response = await postCard(app, auth, { title: "Write ADR" });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ title: "Write ADR", status: "backlog" });
    expect(body.id).toBeTypeOf("string");
    expect(body.createdAt).toBeTypeOf("string");
  });

  it("rejects an empty title with a deterministic 400 error", async () => {
    const { app, ...auth } = await signedInApp(db);

    const response = await postCard(app, auth, { title: "" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_card_input" });
  });

  it("rejects a missing title with a deterministic 400 error", async () => {
    const { app, ...auth } = await signedInApp(db);

    const response = await postCard(app, auth, {});

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_card_input" });
  });

  it("lists created cards newest first", async () => {
    const { app, ...auth } = await signedInApp(db);

    await postCard(app, auth, { title: "First card" });
    await postCard(app, auth, { title: "Second card" });

    const response = await app.inject({
      method: "GET",
      url: "/cards",
      headers: { cookie: `${SESSION_COOKIE}=${auth.cookie}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body[0].title).toBe("Second card");
    expect(body[1].title).toBe("First card");
  });

  it("lists an empty array when no cards exist", async () => {
    const { app, ...auth } = await signedInApp(db);

    const response = await app.inject({
      method: "GET",
      url: "/cards",
      headers: { cookie: `${SESSION_COOKIE}=${auth.cookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("persists cards durably in the cards table", async () => {
    const { app, ...auth } = await signedInApp(db);

    await postCard(app, auth, { title: "Durable card" });

    const rows = await db.select().from(cards);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Durable card");
    expect(rows[0].status).toBe("backlog");
  });
});
