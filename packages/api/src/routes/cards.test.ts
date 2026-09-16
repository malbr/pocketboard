import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { buildApp } from "../app";
import { createDbClient, type Database } from "../db/client";
import { cards } from "../db/schema";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://pocketboard:pocketboard@localhost:5432/pocketboard";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

let databaseAvailable = true;
try {
  const probe = postgres(connectionString, { connect_timeout: 2, max: 1 });
  await probe`select 1`;
  await probe.end();
} catch {
  databaseAvailable = false;
}

describe.skipIf(!databaseAvailable)("card routes (real PostgreSQL)", () => {
  let db: Database;
  let queryClient: ReturnType<typeof createDbClient>["queryClient"];

  beforeAll(async () => {
    const client = createDbClient(connectionString);
    db = client.db;
    queryClient = client.queryClient;
    await migrate(db, { migrationsFolder });
  });

  beforeEach(async () => {
    await queryClient`truncate table cards`;
  });

  afterAll(async () => {
    await queryClient.end();
  });

  it("creates a Backlog card and returns it", async () => {
    const app = buildApp(db);

    const response = await app.inject({
      method: "POST",
      url: "/cards",
      payload: { title: "Write ADR" },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ title: "Write ADR", status: "backlog" });
    expect(body.id).toBeTypeOf("string");
    expect(body.createdAt).toBeTypeOf("string");
  });

  it("rejects an empty title with a deterministic 400 error", async () => {
    const app = buildApp(db);

    const response = await app.inject({
      method: "POST",
      url: "/cards",
      payload: { title: "" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_card_input" });
  });

  it("rejects a missing title with a deterministic 400 error", async () => {
    const app = buildApp(db);

    const response = await app.inject({
      method: "POST",
      url: "/cards",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_card_input" });
  });

  it("lists created cards newest first", async () => {
    const app = buildApp(db);

    await app.inject({ method: "POST", url: "/cards", payload: { title: "First card" } });
    await app.inject({ method: "POST", url: "/cards", payload: { title: "Second card" } });

    const response = await app.inject({ method: "GET", url: "/cards" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toHaveLength(2);
    expect(body[0].title).toBe("Second card");
    expect(body[1].title).toBe("First card");
  });

  it("lists an empty array when no cards exist", async () => {
    const app = buildApp(db);

    const response = await app.inject({ method: "GET", url: "/cards" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("persists cards durably in the cards table", async () => {
    const app = buildApp(db);

    await app.inject({ method: "POST", url: "/cards", payload: { title: "Durable card" } });

    const rows = await db.select().from(cards);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Durable card");
    expect(rows[0].status).toBe("backlog");
  });
});
