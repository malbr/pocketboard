import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const cardStatusEnum = pgEnum("card_status", ["backlog", "doing", "done"]);

export const cards = pgTable("cards", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  status: cardStatusEnum("status").notNull().default("backlog"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Server-side session records backing @fastify/session. The browser only ever
 * holds the opaque, signed session id in an HttpOnly cookie; everything that
 * matters — the owner's GitHub id and the CSRF secret — stays in this table.
 *
 * GitHub access tokens are deliberately absent: the callback discards the token
 * as soon as it has resolved the numeric user id.
 */
export const sessions = pgTable(
  "sessions",
  {
    sid: text("sid").primaryKey(),
    data: jsonb("data").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_expires_at_idx").on(table.expiresAt)],
);
