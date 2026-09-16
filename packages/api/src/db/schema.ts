import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const cardStatusEnum = pgEnum("card_status", ["backlog", "doing", "done"]);

export const cards = pgTable("cards", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  status: cardStatusEnum("status").notNull().default("backlog"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
