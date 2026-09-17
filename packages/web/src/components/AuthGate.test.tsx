import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthGate } from "./AuthGate";

const ownerSession = {
  authenticated: true,
  githubUserId: 325861437,
  csrfToken: "csrf-token-value",
  expiresAt: new Date("2026-09-16T17:00:00.000Z").toISOString(),
};

function respondWith(body: unknown, status: number) {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

describe("AuthGate", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prompts an unauthenticated visitor to sign in with GitHub", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respondWith({ error: "authentication_required" }, 401),
    );

    render(<AuthGate />);

    const link = await screen.findByRole("link", { name: "Sign in with GitHub" });
    expect(link).toHaveAttribute("href", "/api/auth/github");
  });

  it("never renders the board to an unauthenticated visitor", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respondWith({ error: "authentication_required" }, 401),
    );

    render(<AuthGate />);

    await screen.findByRole("link", { name: "Sign in with GitHub" });
    expect(screen.queryByRole("heading", { name: "Backlog" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New card title")).not.toBeInTheDocument();
  });

  it("tells a non-owner that their account has no access", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respondWith({ error: "access_denied" }, 403));

    render(<AuthGate />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "does not have access to this board",
    );
    expect(screen.queryByRole("heading", { name: "Backlog" })).not.toBeInTheDocument();
  });

  it("renders the board for the owner", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respondWith(ownerSession, 200))
      .mockResolvedValueOnce(respondWith([], 200));

    render(<AuthGate />);

    expect(await screen.findByRole("heading", { name: "Backlog" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("sends the CSRF token when signing out and re-checks the session", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch)
      .mockResolvedValueOnce(respondWith(ownerSession, 200))
      .mockResolvedValueOnce(respondWith([], 200))
      .mockResolvedValueOnce(respondWith(null, 204))
      .mockResolvedValueOnce(respondWith({ error: "authentication_required" }, 401));

    render(<AuthGate />);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/auth/logout",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ "X-CSRF-Token": "csrf-token-value" }),
        }),
      ),
    );

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeInTheDocument();
  });

  it("returns to the sign-in prompt when the session expires mid-session", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respondWith(ownerSession, 200))
      // The board's first card load finds the session already gone.
      .mockResolvedValueOnce(respondWith({ error: "authentication_required" }, 401))
      .mockResolvedValueOnce(respondWith({ error: "authentication_required" }, 401));

    render(<AuthGate />);

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeInTheDocument();
  });

  it("offers a retry when the session check itself fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respondWith({ error: "boom" }, 500));

    render(<AuthGate />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check your session");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
