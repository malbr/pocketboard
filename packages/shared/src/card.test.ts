import { describe, expect, it } from "vitest";
import { CardStatus, createCardInputSchema, cardSchema } from "./card";

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
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid status", () => {
    const result = cardSchema.safeParse({
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      title: "Write ADR",
      status: "blocked",
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    const result = cardSchema.safeParse({
      id: "not-a-uuid",
      title: "Write ADR",
      status: CardStatus.Backlog,
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
