import { eq, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { sessions } from "../db/schema";
import { isExpired, resolveExpiresAt } from "./session-expiry";

type SessionData = Record<string, unknown>;
type Callback = (err?: unknown) => void;
type GetCallback = (err: unknown, session?: SessionData | null) => void;

/**
 * Writes the session payload, keeping the earliest expiry of the two.
 *
 * `resolveExpiresAt` can only clamp against the cookie the request carried; it
 * cannot see what the stored row already says. The clamp therefore belongs in
 * the statement itself, where `least` compares the existing deadline with the
 * proposed one, so no later write can extend a session past the absolute
 * eight-hour cap.
 */
export function buildSessionUpsert(
  db: Database,
  sessionId: string,
  session: SessionData,
  expiresAt: Date,
) {
  return db
    .insert(sessions)
    .values({ sid: sessionId, data: session, expiresAt })
    .onConflictDoUpdate({
      target: sessions.sid,
      set: {
        data: session,
        expiresAt: sql`least(${sessions.expiresAt}, ${expiresAt.toISOString()}::timestamptz)`,
      },
    });
}

/**
 * A @fastify/session store backed by the `sessions` table.
 *
 * The callback signatures are dictated by the plugin's express-session
 * compatible store contract, so each method adapts a promise to a callback.
 */
export class PostgresSessionStore {
  readonly #db: Database;
  readonly #ttlMs: number;
  readonly #now: () => Date;

  constructor(db: Database, ttlMs: number, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  set(sessionId: string, session: SessionData, callback: Callback): void {
    const expiresAt = resolveExpiresAt(session, this.#now(), this.#ttlMs);

    buildSessionUpsert(this.#db, sessionId, session, expiresAt).then(() => callback(), callback);
  }

  get(sessionId: string, callback: GetCallback): void {
    this.#db
      .select()
      .from(sessions)
      .where(eq(sessions.sid, sessionId))
      .limit(1)
      .then((rows) => {
        const row = rows[0];
        if (!row) {
          callback(null, null);
          return;
        }

        // Expired rows are treated as absent and deleted rather than trusted.
        // The plugin performs its own expiry check too; this is the backstop
        // that also stops an expired row from being resurrected by a later set.
        if (isExpired(row.expiresAt, this.#now())) {
          this.destroy(sessionId, () => callback(null, null));
          return;
        }

        callback(null, row.data as SessionData);
      }, callback);
  }

  destroy(sessionId: string, callback: Callback): void {
    this.#db
      .delete(sessions)
      .where(eq(sessions.sid, sessionId))
      .then(() => callback(), callback);
  }

  /** Housekeeping for expired rows; safe to call at any time. */
  async deleteExpired(): Promise<void> {
    await this.#db.delete(sessions).where(lte(sessions.expiresAt, this.#now()));
  }
}
