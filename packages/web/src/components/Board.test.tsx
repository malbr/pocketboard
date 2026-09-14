import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Board } from "./Board";
import type { Card } from "@pocketboard/shared";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: crypto.randomUUID(),
    title: "Existing card",
    status: "backlog",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Board", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the Backlog, Doing, and Done columns", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    render(<Board />);

    expect(await screen.findByRole("heading", { name: "Backlog" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Doing" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Done" })).toBeInTheDocument();
  });

  it("loads existing cards into their status column", async () => {
    const existing = makeCard({ title: "From the API", status: "doing" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([existing]), { status: 200 }));

    render(<Board />);

    const doingColumn = await screen.findByTestId("column-doing");
    expect(within(doingColumn).getByText("From the API")).toBeInTheDocument();
  });

  it("lets a user create a card and immediately see it in Backlog", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    render(<Board />);
    await screen.findByRole("heading", { name: "Backlog" });

    const created = makeCard({ title: "New task" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 201 }));

    await user.type(screen.getByLabelText("New card title"), "New task");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    const backlogColumn = await screen.findByTestId("column-backlog");
    await waitFor(() => expect(within(backlogColumn).getByText("New task")).toBeInTheDocument());

    expect(fetch).toHaveBeenLastCalledWith(
      "/api/cards",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("disables the submit button while the title is blank", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    render(<Board />);
    await screen.findByRole("heading", { name: "Backlog" });

    expect(screen.getByRole("button", { name: "Add card" })).toBeDisabled();
  });

  it("shows an error message when card creation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    render(<Board />);
    await screen.findByRole("heading", { name: "Backlog" });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_card_input" }), { status: 400 }),
    );

    await user.type(screen.getByLabelText("New card title"), "Bad card");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid_card_input");
  });
});
