import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SafeParseReturnType, ZodIssue } from "zod";
import {
  CardErrorCode,
  cardIdParamsSchema,
  createCardInputSchema,
  moveCardInputSchema,
} from "@pocketboard/shared";
import type { Database } from "../db/client";
import { cards } from "../db/schema";

type CardRow = typeof cards.$inferSelect;

export function registerCardRoutes(
  app: FastifyInstance,
  db: Database,
  requireOwner: preHandlerAsyncHookHandler,
): void {
  // Every card route is owner-only. Mutations additionally carry CSRF
  // protection; the guard runs first so an unauthenticated caller always sees
  // 401 rather than a CSRF failure.
  app.post("/cards", { preHandler: [requireOwner, app.csrfProtection] }, async (request, reply) => {
    const parsed = createCardInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(invalidCardInput(parsed));
    }

    const [created] = await db.insert(cards).values({ title: parsed.data.title }).returning();
    return reply.status(201).send(serializeCard(created));
  });

  app.get("/cards", { preHandler: requireOwner }, async (_request, reply) => {
    const rows = await db.select().from(cards).orderBy(desc(cards.createdAt));
    return reply.status(200).send(rows.map(serializeCard));
  });

  app.patch(
    "/cards/:cardId",
    { preHandler: [requireOwner, app.csrfProtection] },
    async (request, reply) => {
      const params = cardIdParamsSchema.safeParse(request.params);
      const body = moveCardInputSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send(invalidCardInput(params, body));
      }

      // The version check lives inside the UPDATE, so the read of the stored
      // token and the write that supersedes it are one statement. A concurrent
      // move either loses the race here or is refused below; neither can slip
      // between a separate read and write.
      const [moved] = await db
        .update(cards)
        .set({ status: body.data.status, version: sql`${cards.version} + 1` })
        .where(and(eq(cards.id, params.data.cardId), eq(cards.version, body.data.version)))
        .returning();

      if (moved) {
        return reply.status(200).send(serializeCard(moved));
      }

      // Nothing was updated: either the card is gone or the caller's token is
      // stale. Only now is it worth asking which.
      const [current] = await db.select().from(cards).where(eq(cards.id, params.data.cardId));
      if (!current) {
        return reply.status(404).send({ error: CardErrorCode.CardNotFound });
      }

      return reply
        .status(409)
        .send({ error: CardErrorCode.CardVersionConflict, card: serializeCard(current) });
    },
  );
}

/**
 * One 400 body for every rejected card request, whether the identifier, the
 * body, or both were wrong. The issue list names the offending fields without
 * echoing their values back.
 */
function invalidCardInput(...results: SafeParseReturnType<unknown, unknown>[]) {
  return {
    error: CardErrorCode.InvalidCardInput,
    issues: results.flatMap((result) =>
      result.success
        ? []
        : result.error.issues.map((issue: ZodIssue) => ({
            path: issue.path,
            message: issue.message,
          })),
    ),
  };
}

function serializeCard(row: CardRow) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
  };
}
