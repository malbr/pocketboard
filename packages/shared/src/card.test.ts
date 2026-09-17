import { describe, expect, it } from "vitest";
import {
  CardErrorCode,
  CardStatus,
  cardVersionConflictSchema,
  createCardInputSchema,
  cardSchema,
  cardListSchema,
  cardIdParamsSchema,
  cardNotFoundSchema,
  deleteCardInputSchema,
  moveCardInputSchema,
} from "./card";

describe("createCardInputSchema", () => {
  it("accepts a valid title", () => {
    const result = createCardInputSchema.safeParse({ title: "Write ADR" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty title", () => {
    const result = createCardInputSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing title", () => {
    const result = createCardInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a title over 200 characters", () => {
    const result = createCardInputSchema.safeParse({ title: "a".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const result = createCardInputSchema.safeParse({ title: "ok", status: "doing" });
    expect(result.success).toBe(false);
  });
});

describe("cardSchema", () => {
  it("accepts a fully-formed Backlog card", () => {
    const result = cardSchema.safeParse({
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      title: "Write ADR",
      status: CardStatus.Backlog,
      createdAt: new Date().toISOString(),
      version: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a card that carries no concurrency token", () => {
    const result = cardSchema.safeParse({
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      title: "Write ADR",
      status: CardStatus.Backlog,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid status", () => {
    const result = cardSchema.safeParse({
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      title: "Write ADR",
      status: "blocked",
      createdAt: new Date().toISOString(),
      version: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    const result = cardSchema.safeParse({
      id: "not-a-uuid",
      title: "Write ADR",
      status: CardStatus.Backlog,
      createdAt: new Date().toISOString(),
      version: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("moveCardInputSchema", () => {
  it("accepts a move to Doing carrying the card's concurrency token", () => {
    const result = moveCardInputSchema.safeParse({ status: CardStatus.Doing, version: 1 });
    expect(result.success).toBe(true);
  });

  it("rejects a column the board does not have", () => {
    const result = moveCardInputSchema.safeParse({ status: "archived", version: 1 });
    expect(result.success).toBe(false);
  });

  it.each([["1"], [0], [-1], [1.5], [Number.NaN], [null]])(
    "rejects %o as a concurrency token",
    (version) => {
      const result = moveCardInputSchema.safeParse({ status: CardStatus.Done, version });
      expect(result.success).toBe(false);
    },
  );

  it("rejects a move that smuggles in extra fields", () => {
    const result = moveCardInputSchema.safeParse({
      status: CardStatus.Done,
      version: 1,
      title: "renamed on the side",
    });
    expect(result.success).toBe(false);
  });
});

describe("deleteCardInputSchema", () => {
  it("accepts a delete carrying the card's concurrency token", () => {
    const result = deleteCardInputSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
  });

  it.each([["1"], [0], [-1], [1.5], [Number.NaN], [null]])(
    "rejects %o as a concurrency token",
    (version) => {
      const result = deleteCardInputSchema.safeParse({ version });
      expect(result.success).toBe(false);
    },
  );

  it("rejects a delete that states no version at all", () => {
    const result = deleteCardInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a delete that smuggles in extra fields", () => {
    const result = deleteCardInputSchema.safeParse({ version: 1, status: CardStatus.Done });
    expect(result.success).toBe(false);
  });
});

describe("cardVersionConflictSchema", () => {
  const currentCard = {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    title: "Write ADR",
    status: CardStatus.Doing,
    createdAt: new Date().toISOString(),
    version: 2,
  };

  it("carries the card as it now stands so a stale browser can recover", () => {
    const result = cardVersionConflictSchema.safeParse({
      error: CardErrorCode.CardVersionConflict,
      card: currentCard,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a conflict that does not say what the card now is", () => {
    const result = cardVersionConflictSchema.safeParse({
      error: CardErrorCode.CardVersionConflict,
    });
    expect(result.success).toBe(false);
  });

  it("rejects another error code wearing the conflict shape", () => {
    const result = cardVersionConflictSchema.safeParse({
      error: CardErrorCode.CardNotFound,
      card: currentCard,
    });
    expect(result.success).toBe(false);
  });
});

describe("cardNotFoundSchema", () => {
  it("accepts the card-not-found response", () => {
    const result = cardNotFoundSchema.safeParse({ error: CardErrorCode.CardNotFound });
    expect(result.success).toBe(true);
  });

  it("rejects another error code", () => {
    const result = cardNotFoundSchema.safeParse({ error: CardErrorCode.InvalidCardInput });
    expect(result.success).toBe(false);
  });

  it("rejects a response that states no error at all", () => {
    const result = cardNotFoundSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects extra fields alongside the error", () => {
    const result = cardNotFoundSchema.safeParse({
      error: CardErrorCode.CardNotFound,
      card: { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" },
    });
    expect(result.success).toBe(false);
  });
});

describe("cardIdParamsSchema", () => {
  it("accepts a well-formed card identifier", () => {
    const result = cardIdParamsSchema.safeParse({
      cardId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed card identifier", () => {
    const result = cardIdParamsSchema.safeParse({ cardId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });
});

describe("cardListSchema", () => {
  it("accepts an empty list", () => {
    const result = cardListSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it("accepts a list of well-formed cards", () => {
    const result = cardListSchema.safeParse([
      {
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        title: "Write ADR",
        status: CardStatus.Backlog,
        createdAt: new Date().toISOString(),
        version: 1,
      },
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects a list containing a malformed card", () => {
    const result = cardListSchema.safeParse([
      {
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        title: "Write ADR",
        status: "not-a-status",
        createdAt: new Date().toISOString(),
        version: 1,
      },
    ]);
    expect(result.success).toBe(false);
  });

  it("rejects a non-array payload", () => {
    const result = cardListSchema.safeParse({ id: "not-a-list" });
    expect(result.success).toBe(false);
  });
});
