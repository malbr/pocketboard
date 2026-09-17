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
    version: 1,
    ...overrides,
  };
}

describe("Board", () => {
  const csrfToken = "test-csrf-token";

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // The delete cases spy on window.confirm; no other case may inherit it.
    vi.restoreAllMocks();
  });

  it("renders the Backlog, Doing, and Done columns", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);

    expect(await screen.findByRole("heading", { name: "Backlog" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Doing" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Done" })).toBeInTheDocument();
  });

  it("loads existing cards into their status column", async () => {
    const existing = makeCard({ title: "From the API", status: "doing" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([existing]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);

    const doingColumn = await screen.findByTestId("column-doing");
    expect(within(doingColumn).getByText("From the API")).toBeInTheDocument();
  });

  it("lets a user create a card and immediately see it in Backlog", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByRole("heading", { name: "Backlog" });

    const created = makeCard({ title: "New task" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 201 }));

    await user.type(screen.getByLabelText("New card title"), "New task");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    const backlogColumn = await screen.findByTestId("column-backlog");
    await waitFor(() => expect(within(backlogColumn).getByText("New task")).toBeInTheDocument());

    expect(fetch).toHaveBeenLastCalledWith(
      "/api/cards",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": csrfToken }),
      }),
    );
  });

  it("moves a card to Doing and shows it in that column", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Move me" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Move me");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ...card, status: "doing", version: 2 }), { status: 200 }),
    );

    await user.click(screen.getByRole("button", { name: 'Move "Move me" to Doing' }));

    const doingColumn = await screen.findByTestId("column-doing");
    await waitFor(() => expect(within(doingColumn).getByText("Move me")).toBeInTheDocument());
    expect(within(screen.getByTestId("column-backlog")).queryByText("Move me")).toBeNull();

    expect(fetch).toHaveBeenLastCalledWith(
      `/api/cards/${card.id}`,
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "X-CSRF-Token": csrfToken }),
        body: JSON.stringify({ status: "doing", version: 1 }),
      }),
    );
  });

  it("keeps the board it has and says how to recover when a move is stale", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Contested" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Contested");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "card_version_conflict",
          card: { ...card, status: "done", version: 2 },
        }),
        { status: 409 },
      ),
    );

    await user.click(screen.getByRole("button", { name: 'Move "Contested" to Doing' }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Contested");
    expect(alert).toHaveTextContent("Done");
    expect(alert).toHaveTextContent(/reload/i);

    // The board the owner was looking at is left exactly as it was.
    expect(within(screen.getByTestId("column-backlog")).getByText("Contested")).toBeInTheDocument();
    expect(within(screen.getByTestId("column-doing")).queryByText("Contested")).toBeNull();
    expect(within(screen.getByTestId("column-done")).queryByText("Contested")).toBeNull();
  });

  it("reports a move the API refused for any other reason", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Move me" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Move me");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "card_not_found" }), { status: 404 }),
    );

    await user.click(screen.getByRole("button", { name: 'Move "Move me" to Doing' }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Move me");
    expect(within(screen.getByTestId("column-backlog")).getByText("Move me")).toBeInTheDocument();
  });

  it("keeps the stale-move guidance while a different card moves successfully", async () => {
    const user = userEvent.setup();
    const contested = makeCard({ title: "Contested" });
    const other = makeCard({ title: "Other card" });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([contested, other]), { status: 200 }),
    );

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Contested");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "card_version_conflict",
          card: { ...contested, status: "done", version: 2 },
        }),
        { status: 409 },
      ),
    );
    await user.click(screen.getByRole("button", { name: 'Move "Contested" to Doing' }));
    await screen.findByRole("alert");

    // "Contested" is still held at the version that just conflicted, so the
    // next move that can succeed is necessarily a different card.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ...other, status: "doing", version: 2 }), { status: 200 }),
    );
    await user.click(screen.getByRole("button", { name: 'Move "Other card" to Doing' }));

    const doingColumn = screen.getByTestId("column-doing");
    await waitFor(() => expect(within(doingColumn).getByText("Other card")).toBeInTheDocument());

    // "Contested" is still stale, so its recovery guidance has to survive.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Contested");
    expect(alert).toHaveTextContent(/reload/i);
  });

  it("keeps the stale-move guidance when a different card's move fails outright", async () => {
    const user = userEvent.setup();
    const contested = makeCard({ title: "Contested" });
    const other = makeCard({ title: "Other card" });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([contested, other]), { status: 200 }),
    );

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Contested");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "card_version_conflict",
          card: { ...contested, status: "done", version: 2 },
        }),
        { status: 409 },
      ),
    );
    await user.click(screen.getByRole("button", { name: 'Move "Contested" to Doing' }));
    await screen.findByRole("alert");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    );
    await user.click(screen.getByRole("button", { name: 'Move "Other card" to Doing' }));

    // A failure elsewhere says nothing about "Contested", which is still stale.
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Contested");
      expect(alert).toHaveTextContent(/reload/i);
    });
  });

  it("clears an ordinary move failure once a later move succeeds", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Move me" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Move me");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    );
    await user.click(screen.getByRole("button", { name: 'Move "Move me" to Doing' }));
    await screen.findByRole("alert");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ...card, status: "doing", version: 2 }), { status: 200 }),
    );
    await user.click(screen.getByRole("button", { name: 'Move "Move me" to Doing' }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("asks before deleting and sends nothing when the owner cancels", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Keep me" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Keep me");
    vi.mocked(fetch).mockClear();

    await user.click(screen.getByRole("button", { name: 'Delete "Keep me"' }));

    expect(confirmed).toHaveBeenCalledWith(expect.stringContaining("Keep me"));
    expect(confirmed.mock.calls[0][0]).toMatch(/delete/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("column-backlog")).getByText("Keep me")).toBeInTheDocument();
  });

  it("deletes a confirmed card and removes it from the board", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Delete me", version: 3 });
    const other = makeCard({ title: "Other card" });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([card, other]), { status: 200 }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Delete me");

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(card), { status: 200 }));

    await user.click(screen.getByRole("button", { name: 'Delete "Delete me"' }));

    await waitFor(() => expect(screen.queryByText("Delete me")).toBeNull());
    expect(screen.getByText("Other card")).toBeInTheDocument();

    expect(fetch).toHaveBeenLastCalledWith(
      `/api/cards/${card.id}`,
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "X-CSRF-Token": csrfToken }),
        body: JSON.stringify({ version: 3 }),
      }),
    );
  });

  it("keeps the board and says how to recover when a delete is stale", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Contested" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Contested");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "card_version_conflict",
          card: { ...card, status: "done", version: 2 },
        }),
        { status: 409 },
      ),
    );

    await user.click(screen.getByRole("button", { name: 'Delete "Contested"' }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Contested");
    expect(alert).toHaveTextContent("Done");
    expect(alert).toHaveTextContent(/reload/i);

    // Nothing was deleted, so the card stays exactly where the owner saw it.
    expect(within(screen.getByTestId("column-backlog")).getByText("Contested")).toBeInTheDocument();
  });

  it("explains a delete of a card the API no longer has without repainting the board", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Already gone" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Already gone");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "card_not_found" }), { status: 404 }),
    );

    await user.click(screen.getByRole("button", { name: 'Delete "Already gone"' }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Already gone");
    expect(alert).toHaveTextContent(/reload/i);

    // The rest of this board is just as old as the card that turned out to be
    // gone, so it is left alone rather than presented as current.
    expect(within(screen.getByTestId("column-backlog")).getByText("Already gone")).toBeInTheDocument();
  });

  it("reports a delete the API refused for any other reason", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Delete me" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Delete me");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    );

    await user.click(screen.getByRole("button", { name: 'Delete "Delete me"' }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Delete me");
    expect(within(screen.getByTestId("column-backlog")).getByText("Delete me")).toBeInTheDocument();
  });

  it("keeps the stale-move guidance while a different card is deleted successfully", async () => {
    const user = userEvent.setup();
    const contested = makeCard({ title: "Contested" });
    const other = makeCard({ title: "Other card" });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([contested, other]), { status: 200 }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Contested");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "card_version_conflict",
          card: { ...contested, status: "done", version: 2 },
        }),
        { status: 409 },
      ),
    );
    await user.click(screen.getByRole("button", { name: 'Move "Contested" to Doing' }));
    await screen.findByRole("alert");

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(other), { status: 200 }));
    await user.click(screen.getByRole("button", { name: 'Delete "Other card"' }));

    await waitFor(() => expect(screen.queryByText("Other card")).toBeNull());

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Contested");
    expect(alert).toHaveTextContent(/reload/i);
  });

  it("asks the gate to re-check the session when a delete returns 401", async () => {
    const user = userEvent.setup();
    const onAuthLost = vi.fn();
    const card = makeCard({ title: "Delete me" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<Board csrfToken={csrfToken} onAuthLost={onAuthLost} />);
    await screen.findByText("Delete me");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 }),
    );

    await user.click(screen.getByRole("button", { name: 'Delete "Delete me"' }));

    await waitFor(() => expect(onAuthLost).toHaveBeenCalled());
    expect(within(screen.getByTestId("column-backlog")).getByText("Delete me")).toBeInTheDocument();
  });

  it("asks the gate to re-check the session when the API returns 401", async () => {
    const onAuthLost = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 }),
    );

    render(<Board csrfToken={csrfToken} onAuthLost={onAuthLost} />);

    await waitFor(() => expect(onAuthLost).toHaveBeenCalled());
  });

  it("disables the submit button while the title is blank", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByRole("heading", { name: "Backlog" });

    expect(screen.getByRole("button", { name: "Add card" })).toBeDisabled();
  });

  it("shows an error message when card creation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByRole("heading", { name: "Backlog" });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_card_input" }), { status: 400 }),
    );

    await user.type(screen.getByLabelText("New card title"), "Bad card");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid_card_input");
  });
});
