import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCard, fetchCards } from "./client";

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the card list from the same-origin /api path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await fetchCards();

    expect(fetch).toHaveBeenCalledWith("/api/cards");
  });

  it("creates a card against the same-origin /api path", async () => {
    const created = {
      id: crypto.randomUUID(),
      title: "New task",
      status: "backlog",
      createdAt: new Date().toISOString(),
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 201 }));

    await createCard("New task");

    expect(fetch).toHaveBeenCalledWith(
      "/api/cards",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects a malformed card list on a successful response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: "not-a-uuid" }]), { status: 200 }),
    );

    await expect(fetchCards()).rejects.toThrow("Failed to load cards");
  });

  it("rejects a malformed card on a successful create response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ title: "missing fields" }), { status: 201 }),
    );

    await expect(createCard("New task")).rejects.toThrow("Failed to create card");
  });
});
