import { z } from "zod";

export const CardStatus = {
  Backlog: "backlog",
  Doing: "doing",
  Done: "done",
} as const;

export type CardStatus = (typeof CardStatus)[keyof typeof CardStatus];

const cardStatusSchema = z.enum([CardStatus.Backlog, CardStatus.Doing, CardStatus.Done]);

export const createCardInputSchema = z
  .object({
    title: z.string().trim().min(1, "title is required").max(200, "title is too long"),
  })
  .strict();

export type CreateCardInput = z.infer<typeof createCardInputSchema>;

/**
 * The card's concurrency token. It starts at 1 and the API increments it on
 * every accepted move, so a browser that has not seen the latest state holds a
 * token the API can recognise as stale.
 */
const cardVersionSchema = z.number().int().positive();

export const cardIdParamsSchema = z.object({ cardId: z.string().uuid() }).strict();

export type CardIdParams = z.infer<typeof cardIdParamsSchema>;

/**
 * A move states where the card should end up and which version of the card the
 * caller was looking at when it decided. `.strict()` keeps this to a move: a
 * title arriving here would be silently ignored, so it is rejected instead.
 */
export const moveCardInputSchema = z
  .object({
    status: cardStatusSchema,
    version: cardVersionSchema,
  })
  .strict();

export type MoveCardInput = z.infer<typeof moveCardInputSchema>;

/**
 * A delete says nothing about where the card should end up, only which version
 * of it the caller was looking at when it decided to remove it. Requiring the
 * token here is what keeps a delete from silently discarding a change the
 * caller never saw.
 */
export const deleteCardInputSchema = z.object({ version: cardVersionSchema }).strict();

export type DeleteCardInput = z.infer<typeof deleteCardInputSchema>;

export const cardSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200),
    status: cardStatusSchema,
    createdAt: z.string().datetime(),
    version: cardVersionSchema,
  })
  .strict();

export type Card = z.infer<typeof cardSchema>;

export const cardListSchema = z.array(cardSchema);

/**
 * Deterministic card failures, mirroring `AuthErrorCode`. A conflict is not an
 * error the caller can fix by retrying the same request, so it is named
 * separately from a malformed one.
 */
export const CardErrorCode = {
  InvalidCardInput: "invalid_card_input",
  CardNotFound: "card_not_found",
  CardVersionConflict: "card_version_conflict",
} as const;

export type CardErrorCode = (typeof CardErrorCode)[keyof typeof CardErrorCode];

/**
 * The answer to a stale move. It returns the card as the API now holds it, so
 * the frontend can tell the owner what actually happened instead of guessing.
 */
export const cardVersionConflictSchema = z
  .object({
    error: z.literal(CardErrorCode.CardVersionConflict),
    card: cardSchema,
  })
  .strict();

export type CardVersionConflict = z.infer<typeof cardVersionConflictSchema>;

/**
 * The answer when the API has no such card. A caller must be able to tell this
 * apart from any other 404 it might meet — a proxy's, a typo'd path — before it
 * tells the owner the card was already deleted, so the shape is stated here and
 * checked rather than inferred from the status code.
 */
export const cardNotFoundSchema = z
  .object({ error: z.literal(CardErrorCode.CardNotFound) })
  .strict();

export type CardNotFound = z.infer<typeof cardNotFoundSchema>;
