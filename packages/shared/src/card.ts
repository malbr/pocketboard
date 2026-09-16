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

export const cardSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200),
    status: cardStatusSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export type Card = z.infer<typeof cardSchema>;

export const cardListSchema = z.array(cardSchema);
