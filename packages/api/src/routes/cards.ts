import type { FastifyInstance } from "fastify";
import { desc } from "drizzle-orm";
import type { ZodIssue } from "zod";
import { createCardInputSchema } from "@pocketboard/shared";
import type { Database } from "../db/client";
import { cards } from "../db/schema";

type CardRow = typeof cards.$inferSelect;

export function registerCardRoutes(app: FastifyInstance, db: Database): void {
  app.post("/cards", async (request, reply) => {
    const parsed = createCardInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_card_input",
        issues: parsed.error.issues.map((issue: ZodIssue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
    }

    const [created] = await db.insert(cards).values({ title: parsed.data.title }).returning();
    return reply.status(201).send(serializeCard(created));
  });

  app.get("/cards", async (_request, reply) => {
    const rows = await db.select().from(cards).orderBy(desc(cards.createdAt));
    return reply.status(200).send(rows.map(serializeCard));
  });
}

function serializeCard(row: CardRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}
