import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type Database } from "../db/client";
import { sessions } from "../db/schema";
import { createTestDatabase, databaseAvailable } from "../testing/test-database";
import { PostgresSessionStore, buildSessionUpsert } from "./session-store";

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

describe("session upsert", () => {
  // postgres-js connects lazily, so building a statement opens no socket and
  // this case runs with or without a database.
  const { db } = createDbClient("postgres://pocketboard:pocketboard@127.0.0.1:5432/pocketboard");

  it("clamps an update to whichever expiry comes first", () => {
    const expiresAt = new Date("2026-09-16T17:00:00.000Z");

    const { sql, params } = buildSessionUpsert(db, "sid-1", { cookie: {} }, expiresAt).toSQL();

    // Any write during the session — a rotated CSRF token, a touched cookie —
    // goes through this statement. Without the clamp it would push the
    // absolute eight-hour deadline forward every time, turning the documented
    // cap into a sliding window.
    expect(sql.toLowerCase()).toContain("on conflict");
    expect(sql.toLowerCase()).toMatch(/"expires_at"\s*=\s*least\(/);
    expect(sql).toContain('"sessions"."expires_at"');
    expect(params).toContain(expiresAt.toISOString());
  });
});

function setSession(store: PostgresSessionStore, sid: string, expires: Date): Promise<void> {
  return new Promise((resolve, reject) => {
    store.set(sid, { cookie: { expires } }, (error) => (error ? reject(error) : resolve()));
  });
}

describe.skipIf(!databaseAvailable)("PostgresSessionStore (real PostgreSQL)", () => {
  let db: Database;
  let queryClient: Awaited<ReturnType<typeof createTestDatabase>>["queryClient"];

  beforeAll(async () => {
    const client = await createTestDatabase();
    db = client.db;
    queryClient = client.queryClient;
  });

  beforeEach(async () => {
    await queryClient`truncate table sessions`;
  });

  afterAll(async () => {
    await queryClient.end();
  });

  describe("absolute expiry", () => {
    const loginAt = new Date("2026-09-16T09:00:00.000Z");
    const deadline = new Date(loginAt.getTime() + EIGHT_HOURS_MS);
    const midSession = new Date(loginAt.getTime() + 4 * 60 * 60 * 1000);

    it("keeps the original deadline when the session is written again later", async () => {
      await setSession(new PostgresSessionStore(db, EIGHT_HOURS_MS, () => loginAt), "sid", deadline);

      const later = new PostgresSessionStore(db, EIGHT_HOURS_MS, () => midSession);
      await setSession(later, "sid", new Date(midSession.getTime() + EIGHT_HOURS_MS));

      const [row] = await db.select().from(sessions).where(eq(sessions.sid, "sid"));
      expect(row.expiresAt.getTime()).toBe(deadline.getTime());
    });

    it("still records the payload of the later write", async () => {
      await setSession(new PostgresSessionStore(db, EIGHT_HOURS_MS, () => loginAt), "sid", deadline);

      const later = new PostgresSessionStore(db, EIGHT_HOURS_MS, () => midSession);
      await new Promise<void>((resolve, reject) => {
        later.set("sid", { cookie: { expires: deadline }, githubUserId: 42 }, (error) =>
          error ? reject(error) : resolve(),
        );
      });

      const [row] = await db.select().from(sessions).where(eq(sessions.sid, "sid"));
      expect(row.data).toMatchObject({ githubUserId: 42 });
    });

    it("accepts an earlier deadline, so logout-adjacent shortening still works", async () => {
      await setSession(new PostgresSessionStore(db, EIGHT_HOURS_MS, () => loginAt), "sid", deadline);

      const store = new PostgresSessionStore(db, EIGHT_HOURS_MS, () => loginAt);
      await setSession(store, "sid", midSession);

      const [row] = await db.select().from(sessions).where(eq(sessions.sid, "sid"));
      expect(row.expiresAt.getTime()).toBe(midSession.getTime());
    });
  });

  describe("deleteExpired", () => {
    const now = new Date("2026-09-16T17:00:00.000Z");

    it("reaps an abandoned row that will never be presented again", async () => {
      const store = new PostgresSessionStore(db, EIGHT_HOURS_MS, () => now);
      await setSession(store, "abandoned", new Date(now.getTime() - 1000));

      await store.deleteExpired();

      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it("leaves a session that is still within its window", async () => {
      const store = new PostgresSessionStore(db, EIGHT_HOURS_MS, () => now);
      await setSession(store, "live", new Date(now.getTime() + 60_000));
      await setSession(store, "abandoned", new Date(now.getTime() - 1000));

      await store.deleteExpired();

      const rows = await db.select().from(sessions);
      expect(rows.map((row) => row.sid)).toEqual(["live"]);
    });
  });
});
