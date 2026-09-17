import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

/**
 * Smoke coverage for one thing only: the development-only board-UI prototype
 * cannot be reached in a production build. Everything else about the prototype
 * is judged in a browser, not here.
 */
describe("App routing", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status: 401 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    window.history.replaceState(null, "", "/");
  });

  it("serves the real board gate on the ordinary path", async () => {
    render(<App />);

    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeInTheDocument();
  });

  it("serves the throwaway prototype at /prototype/board in development", () => {
    window.history.replaceState(null, "", "/prototype/board?variant=C&state=conflict");

    render(<App />);

    expect(screen.getByRole("group", { name: "Prototype controls" })).toBeInTheDocument();
  });

  it("falls through to the board gate at /prototype/board in a production build", async () => {
    vi.stubEnv("DEV", false);
    window.history.replaceState(null, "", "/prototype/board?variant=C&state=conflict");

    render(<App />);

    expect(screen.queryByRole("group", { name: "Prototype controls" })).not.toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Sign in with GitHub" })).toBeInTheDocument();
  });
});
