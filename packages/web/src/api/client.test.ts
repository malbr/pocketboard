import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthRequiredError,
  CardNotFoundError,
  createCard,
  deleteCard,
  fetchCards,
  fetchSession,
  logout,
  moveCard,
} from "./client";

const csrfToken = "test-csrf-token";

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

    expect(fetch).toHaveBeenCalledWith("/api/cards", { credentials: "same-origin" });
  });

  it("creates a card against the same-origin /api path with a CSRF token", async () => {
    const created = {
      id: crypto.randomUUID(),
      title: "New task",
      status: "backlog",
      createdAt: new Date().toISOString(),
      version: 1,
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 201 }));

    await createCard("New task", csrfToken);

    expect(fetch).toHaveBeenCalledWith(
      "/api/cards",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": csrfToken }),
      }),
    );
  });

  it("moves a card with its concurrency token and a CSRF token", async () => {
    const card = {
      id: crypto.randomUUID(),
      title: "Move me",
      status: "doing",
      createdAt: new Date().toISOString(),
      version: 2,
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(card), { status: 200 }));

    await expect(moveCard(card.id, "doing", 1, csrfToken)).resolves.toEqual(card);

    expect(fetch).toHaveBeenCalledWith(
      `/api/cards/${card.id}`,
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": csrfToken }),
        body: JSON.stringify({ status: "doing", version: 1 }),
      }),
    );
  });

  it("surfaces a stale move as a conflict carrying the card as it now stands", async () => {
    const current = {
      id: crypto.randomUUID(),
      title: "Contested",
      status: "done",
      createdAt: new Date().toISOString(),
      version: 3,
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "card_version_conflict", card: current }), {
        status: 409,
      }),
    );

    await expect(moveCard(current.id, "doing", 1, csrfToken)).rejects.toMatchObject({
      name: "CardVersionConflictError",
      card: current,
    });
  });

  it("deletes a card with its concurrency token and returns the card it removed", async () => {
    const deleted = {
      id: crypto.randomUUID(),
      title: "Delete me",
      status: "backlog",
      createdAt: new Date().toISOString(),
      version: 2,
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(deleted), { status: 200 }));

    await expect(deleteCard(deleted.id, 2, csrfToken)).resolves.toEqual(deleted);

    expect(fetch).toHaveBeenCalledWith(
      `/api/cards/${deleted.id}`,
      expect.objectContaining({
        method: "DELETE",
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": csrfToken }),
        body: JSON.stringify({ version: 2 }),
      }),
    );
  });

  it("surfaces a stale delete as a conflict carrying the card as it now stands", async () => {
    const current = {
      id: crypto.randomUUID(),
      title: "Contested",
      status: "doing",
      createdAt: new Date().toISOString(),
      version: 2,
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "card_version_conflict", card: current }), {
        status: 409,
      }),
    );

    await expect(deleteCard(current.id, 1, csrfToken)).rejects.toMatchObject({
      name: "CardVersionConflictError",
      card: current,
    });
  });

  it("surfaces a delete of a card the API no longer has as CardNotFoundError", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "card_not_found" }), { status: 404 }),
    );

    await expect(deleteCard(crypto.randomUUID(), 1, csrfToken)).rejects.toBeInstanceOf(
      CardNotFoundError,
    );
  });

  it.each([
    ["an unrelated error code", JSON.stringify({ error: "not_found" })],
    ["a card-not-found body carrying extra fields", JSON.stringify({ error: "card_not_found", card: null })],
    ["a body that is not JSON at all", "<html>404 Not Found</html>"],
  ])("does not claim a card was already deleted from a 404 carrying %s", async (_name, body) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status: 404 }));

    const attempt = deleteCard(crypto.randomUUID(), 1, csrfToken);

    await expect(attempt).rejects.toThrow("Failed to delete card");
    await expect(attempt).rejects.not.toBeInstanceOf(CardNotFoundError);
  });

  it("rejects a malformed card on a successful delete response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ title: "missing fields" }), { status: 200 }),
    );

    await expect(deleteCard(crypto.randomUUID(), 1, csrfToken)).rejects.toThrow(
      "Failed to delete card",
    );
  });

  it("rejects any other refused delete", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    );

    await expect(deleteCard(crypto.randomUUID(), 1, csrfToken)).rejects.toThrow(
      "Failed to delete card",
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

    await expect(createCard("New task", csrfToken)).rejects.toThrow("Failed to create card");
  });

  it.each([
    ["fetchCards", () => fetchCards()],
    ["createCard", () => createCard("New task", csrfToken)],
    ["moveCard", () => moveCard(crypto.randomUUID(), "doing", 1, csrfToken)],
    ["deleteCard", () => deleteCard(crypto.randomUUID(), 1, csrfToken)],
  ])("surfaces a 401 from %s as AuthRequiredError", async (_name, call) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 }),
    );

    await expect(call()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  describe("fetchSession", () => {
    it("reports an authenticated owner session", async () => {
      const session = {
        authenticated: true,
        githubUserId: 325861437,
        csrfToken,
        expiresAt: new Date("2026-09-16T17:00:00.000Z").toISOString(),
      };
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }));

      await expect(fetchSession()).resolves.toEqual({ status: "authenticated", session });
    });

    it("reports 401 as unauthenticated", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 }),
      );

      await expect(fetchSession()).resolves.toEqual({ status: "unauthenticated" });
    });

    it("reports 403 as denied, distinct from unauthenticated", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "access_denied" }), { status: 403 }),
      );

      await expect(fetchSession()).resolves.toEqual({ status: "denied" });
    });

    it("rejects a session payload that carries unexpected fields", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authenticated: true,
            githubUserId: 325861437,
            csrfToken,
            expiresAt: new Date().toISOString(),
            accessToken: "gho_should_never_be_here",
          }),
          { status: 200 },
        ),
      );

      await expect(fetchSession()).rejects.toThrow("Failed to load session");
    });
  });

  describe("logout", () => {
    it("posts with the CSRF token", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));

      await logout(csrfToken);

      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/logout",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
          headers: { "X-CSRF-Token": csrfToken },
        }),
      );
    });

    it("throws when the server rejects the logout", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "csrf_token_invalid" }), { status: 403 }),
      );

      await expect(logout(csrfToken)).rejects.toThrow("Failed to sign out");
    });
  });
});
