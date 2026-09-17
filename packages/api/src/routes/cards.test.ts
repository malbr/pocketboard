import { randomUUID } from "node:crypto";
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

function moveCard(
  app: FastifyInstance,
  auth: { cookie: string; csrfToken: string },
  cardId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "PATCH",
    url: `/cards/${cardId}`,
    headers: {
      cookie: `${SESSION_COOKIE}=${auth.cookie}`,
      "x-csrf-token": auth.csrfToken,
    },
    payload,
  });
}

function deleteCard(
  app: FastifyInstance,
  auth: { cookie: string; csrfToken: string },
  cardId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "DELETE",
    url: `/cards/${cardId}`,
    headers: {
      cookie: `${SESSION_COOKIE}=${auth.cookie}`,
      "x-csrf-token": auth.csrfToken,
    },
    payload,
  });
}

function listCards(
  app: FastifyInstance,
  auth: { cookie: string },
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "GET",
    url: "/cards",
    headers: { cookie: `${SESSION_COOKIE}=${auth.cookie}` },
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

  it("moves a card to Doing and returns the persisted card", async () => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Move me" })).json();

    const response = await moveCard(app, auth, created.id, {
      status: "doing",
      version: created.version,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.id, title: "Move me", status: "doing" });

    const rows = await db.select().from(cards);
    expect(rows[0].status).toBe("doing");
  });

  it("refuses a stale move and reports the card as it now stands", async () => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Contested" })).json();

    const firstMove = await moveCard(app, auth, created.id, {
      status: "doing",
      version: created.version,
    });
    expect(firstMove.statusCode).toBe(200);

    // A second browser still holding the version it loaded before the move.
    const staleMove = await moveCard(app, auth, created.id, {
      status: "done",
      version: created.version,
    });

    expect(staleMove.statusCode).toBe(409);
    expect(staleMove.json()).toEqual({
      error: "card_version_conflict",
      card: firstMove.json(),
    });

    const rows = await db.select().from(cards);
    expect(rows[0].status).toBe("doing");
  });

  it("rejects a malformed card identifier before touching the database", async () => {
    const { app, ...auth } = await signedInApp(db);

    const response = await moveCard(app, auth, "not-a-uuid", { status: "doing", version: 1 });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_card_input" });
  });

  it("rejects a move to a column the board does not have", async () => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Stay put" })).json();

    const response = await moveCard(app, auth, created.id, {
      status: "archived",
      version: created.version,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_card_input" });

    const rows = await db.select().from(cards);
    expect(rows[0].status).toBe("backlog");
  });

  it.each([
    ["a missing token", {}],
    ["a non-numeric token", { version: "1" }],
    ["a zero token", { version: 0 }],
  ])("rejects a move carrying %s", async (_name, versionPart) => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Stay put" })).json();

    const response = await moveCard(app, auth, created.id, { status: "doing", ...versionPart });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_card_input" });

    const rows = await db.select().from(cards);
    expect(rows[0].status).toBe("backlog");
  });

  it("reports a move of a card that does not exist as not found", async () => {
    const { app, ...auth } = await signedInApp(db);

    const response = await moveCard(app, auth, randomUUID(), {
      status: "doing",
      version: 1,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "card_not_found" });
  });

  it("refuses a move from a caller with no session", async () => {
    const { app } = await signedInApp(db);

    const response = await app.inject({
      method: "PATCH",
      url: `/cards/${randomUUID()}`,
      payload: { status: "doing", version: 1 },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "authentication_required" });
  });

  it("refuses a move that carries no CSRF token", async () => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Stay put" })).json();

    const response = await app.inject({
      method: "PATCH",
      url: `/cards/${created.id}`,
      headers: { cookie: `${SESSION_COOKIE}=${auth.cookie}` },
      payload: { status: "doing", version: created.version },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "csrf_token_invalid" });

    const rows = await db.select().from(cards);
    expect(rows[0].status).toBe("backlog");
  });

  it("deletes a card, returns the card it removed, and stops listing it", async () => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Delete me" })).json();

    const response = await deleteCard(app, auth, created.id, { version: created.version });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(created);
    expect((await listCards(app, auth)).json()).toEqual([]);
  });

  it("returns the card as it stood at the version that was deleted", async () => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Delete me" })).json();
    const moved = (
      await moveCard(app, auth, created.id, { status: "doing", version: created.version })
    ).json();

    const response = await deleteCard(app, auth, created.id, { version: moved.version });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(moved);
  });

  it("removes only the named card from the cards table", async () => {
    const { app, ...auth } = await signedInApp(db);
    const doomed = (await postCard(app, auth, { title: "Delete me" })).json();
    await postCard(app, auth, { title: "Keep me" });

    await deleteCard(app, auth, doomed.id, { version: doomed.version });

    const rows = await db.select().from(cards);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Keep me");
  });

  it("refuses a stale delete, keeps the card, and reports it as it now stands", async () => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Contested" })).json();

    const moved = await moveCard(app, auth, created.id, {
      status: "doing",
      version: created.version,
    });
    expect(moved.statusCode).toBe(200);

    // A second browser still holding the version it loaded before the move.
    const staleDelete = await deleteCard(app, auth, created.id, { version: created.version });

    expect(staleDelete.statusCode).toBe(409);
    expect(staleDelete.json()).toEqual({
      error: "card_version_conflict",
      card: moved.json(),
    });

    const rows = await db.select().from(cards);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("doing");
  });

  it("reports a delete of a card that does not exist as not found", async () => {
    const { app, ...auth } = await signedInApp(db);

    const response = await deleteCard(app, auth, randomUUID(), { version: 1 });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "card_not_found" });
  });

  it("reports a repeated delete of the same card as not found", async () => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Delete me" })).json();

    expect((await deleteCard(app, auth, created.id, { version: created.version })).statusCode).toBe(
      200,
    );
    const repeat = await deleteCard(app, auth, created.id, { version: created.version });

    expect(repeat.statusCode).toBe(404);
    expect(repeat.json()).toEqual({ error: "card_not_found" });
  });

  it("rejects a delete of a malformed card identifier before touching the database", async () => {
    const { app, ...auth } = await signedInApp(db);

    const response = await deleteCard(app, auth, "not-a-uuid", { version: 1 });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_card_input" });
  });

  it.each([
    ["a missing token", {}],
    ["a non-numeric token", { version: "1" }],
    ["a zero token", { version: 0 }],
    ["a smuggled status", { version: 1, status: "done" }],
  ])("rejects a delete carrying %s and keeps the card", async (_name, payload) => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Stay put" })).json();

    const response = await deleteCard(app, auth, created.id, payload);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_card_input" });

    const rows = await db.select().from(cards);
    expect(rows).toHaveLength(1);
  });

  it("refuses a delete from a caller with no session", async () => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Stay put" })).json();

    const response = await app.inject({
      method: "DELETE",
      url: `/cards/${created.id}`,
      payload: { version: created.version },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "authentication_required" });

    const rows = await db.select().from(cards);
    expect(rows).toHaveLength(1);
  });

  it("refuses a delete that carries no CSRF token", async () => {
    const { app, ...auth } = await signedInApp(db);
    const created = (await postCard(app, auth, { title: "Stay put" })).json();

    const response = await app.inject({
      method: "DELETE",
      url: `/cards/${created.id}`,
      headers: { cookie: `${SESSION_COOKIE}=${auth.cookie}` },
      payload: { version: created.version },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "csrf_token_invalid" });

    const rows = await db.select().from(cards);
    expect(rows).toHaveLength(1);
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
