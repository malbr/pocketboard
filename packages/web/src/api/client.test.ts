import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError, createCard, fetchCards, fetchSession, logout } from "./client";

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
