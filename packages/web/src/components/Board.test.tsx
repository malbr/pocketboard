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

/**
 * The status buttons are named "Backlog 2" once the counts are known, and the
 * row buttons start with their own verb ("Back to Backlog: move …"), so
 * anchoring on the word boundary keeps this to the navigation.
 */
function statusButton(label: string) {
  return screen.getByRole("button", { name: new RegExp(`^${label}\\b`) });
}

function lane() {
  return screen.getByRole("list");
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

  it("opens on Backlog and offers the other two statuses with their counts", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          makeCard({ title: "Queued" }),
          makeCard({ title: "In progress", status: "doing" }),
          makeCard({ title: "Also queued" }),
        ]),
        { status: 200 },
      ),
    );

    render(<Board csrfToken={csrfToken} />);

    expect(await screen.findByRole("heading", { name: "Backlog" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Board status" })).toBeInTheDocument();
    expect(statusButton("Backlog")).toHaveAccessibleName("Backlog 2");
    expect(statusButton("Doing")).toHaveAccessibleName("Doing 1");
    expect(statusButton("Done")).toHaveAccessibleName("Done 0");
    expect(statusButton("Backlog")).toHaveAttribute("aria-pressed", "true");
    expect(statusButton("Doing")).toHaveAttribute("aria-pressed", "false");
    // Only the selected status is on the page.
    expect(screen.queryByRole("heading", { name: "Doing" })).toBeNull();
    expect(screen.queryByText("In progress")).toBeNull();
  });

  it("shows one status at a time and moves the pressed state with the selection", async () => {
    const user = userEvent.setup();
    const existing = makeCard({ title: "From the API", status: "doing" });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([existing]), { status: 200 }),
    );

    render(<Board csrfToken={csrfToken} />);
    await screen.findByRole("heading", { name: "Backlog" });

    await user.click(statusButton("Doing"));

    expect(screen.getByRole("heading", { name: "Doing" })).toBeInTheDocument();
    expect(within(lane()).getByText("From the API")).toBeInTheDocument();
    expect(statusButton("Doing")).toHaveAttribute("aria-pressed", "true");
    expect(statusButton("Backlog")).toHaveAttribute("aria-pressed", "false");
  });

  it("says the board is being read before the cards arrive", async () => {
    let release: (value: Response) => void = () => {};
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    render(<Board csrfToken={csrfToken} />);

    expect(await screen.findByRole("status")).toHaveTextContent("Reading the board");
    // Counts are not invented while they are unknown.
    expect(statusButton("Backlog")).toHaveAccessibleName("Backlog");

    release(new Response(JSON.stringify([]), { status: 200 }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("offers no way to create a card until the board has actually been read", async () => {
    let release: (value: Response) => void = () => {};
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    render(<Board csrfToken={csrfToken} />);
    await screen.findByRole("status");

    // A card created against a board that has not arrived yet is dropped the
    // moment it does: the list the API is still sending replaces the one
    // holding it. So there is nothing here to create with, by pointer or by
    // keyboard, and the card list request stays the only one made.
    expect(screen.queryByLabelText("Add a card to Backlog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add card" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/cards", expect.anything());

    release(new Response(JSON.stringify([]), { status: 200 }));

    expect(await screen.findByLabelText("Add a card to Backlog")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("explains a board that did not load and reloads it on request", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    );

    render(<Board csrfToken={csrfToken} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The board did not load");
    expect(alert).toHaveTextContent(/nothing on the board has been lost/i);
    // Nothing invites a status choice while there are no statuses to show.
    expect(screen.queryByRole("navigation", { name: "Board status" })).toBeNull();

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([makeCard({ title: "Back again" })]), { status: 200 }),
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Back again")).toBeInTheDocument();
    expect(screen.queryByText("The board did not load")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Board status" })).toBeInTheDocument();
  });

  it.each([
    ["Backlog", "No cards in Backlog. Add one above and it starts here."],
    ["Doing", "Nothing is in Doing. Start a card in Backlog and it moves here."],
    ["Done", "Nothing has reached Done. Finish a card in Doing and it lands here."],
  ])("says why %s is empty and what fills it", async (status, message) => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByRole("heading", { name: "Backlog" });

    await user.click(statusButton(status));

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("counts the cards in the selected status and how long the oldest has waited", async () => {
    const threeDaysAgo = new Date(Date.now() - 72 * 3_600_000).toISOString();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          makeCard({ title: "Newer" }),
          makeCard({ title: "Oldest", createdAt: threeDaysAgo }),
        ]),
        { status: 200 },
      ),
    );

    render(<Board csrfToken={csrfToken} />);

    expect(await screen.findByText(/2 cards\./)).toHaveTextContent(
      "The oldest has been on the board 3 days.",
    );
  });

  it("creates into Backlog and shows the new card there even from another status", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByRole("heading", { name: "Backlog" });

    await user.click(statusButton("Done"));
    expect(screen.getByRole("heading", { name: "Done" })).toBeInTheDocument();

    const created = makeCard({ title: "New task" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 201 }));

    await user.type(screen.getByLabelText("Add a card to Backlog"), "New task");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    // The lane follows the card rather than leaving it in a status that is off
    // screen.
    expect(await screen.findByRole("heading", { name: "Backlog" })).toBeInTheDocument();
    await waitFor(() => expect(within(lane()).getByText("New task")).toBeInTheDocument());

    expect(fetch).toHaveBeenLastCalledWith(
      "/api/cards",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": csrfToken }),
      }),
    );
  });

  it("starts a card in Backlog and shows it under Doing", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Move me" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Move me");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ...card, status: "doing", version: 2 }), { status: 200 }),
    );

    await user.click(screen.getByRole("button", { name: 'Start: move "Move me" to Doing' }));

    await waitFor(() => expect(statusButton("Doing")).toHaveAccessibleName("Doing 1"));
    expect(within(lane()).queryByText("Move me")).toBeNull();

    await user.click(statusButton("Doing"));
    expect(within(lane()).getByText("Move me")).toBeInTheDocument();

    expect(fetch).toHaveBeenLastCalledWith(
      `/api/cards/${card.id}`,
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "X-CSRF-Token": csrfToken }),
        body: JSON.stringify({ status: "doing", version: 1 }),
      }),
    );
  });

  it("reaches the second destination without leaving the status", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Skip me" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Skip me");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ...card, status: "done", version: 2 }), { status: 200 }),
    );

    await user.click(
      screen.getByRole("button", { name: 'Skip to Done: move "Skip me" to Done' }),
    );

    await waitFor(() => expect(statusButton("Done")).toHaveAccessibleName("Done 1"));
    expect(fetch).toHaveBeenLastCalledWith(
      `/api/cards/${card.id}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "done", version: 1 }),
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

    await user.click(screen.getByRole("button", { name: 'Start: move "Contested" to Doing' }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Contested");
    expect(alert).toHaveTextContent("Done");
    expect(alert).toHaveTextContent(/reload/i);

    // The board the owner was looking at is left exactly as it was, and the row
    // itself says the card is no longer what the API holds.
    expect(within(lane()).getByText("Contested")).toBeInTheDocument();
    expect(within(lane()).getByText(/changed somewhere else/i)).toBeInTheDocument();
    expect(statusButton("Doing")).toHaveAccessibleName("Doing 0");
    expect(statusButton("Done")).toHaveAccessibleName("Done 0");
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

    await user.click(screen.getByRole("button", { name: 'Start: move "Move me" to Doing' }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Move me");
    expect(within(lane()).getByText("Move me")).toBeInTheDocument();
    // An ordinary failure is not a concurrent change, so the row is not marked.
    expect(within(lane()).queryByText(/changed somewhere else/i)).toBeNull();
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
    await user.click(screen.getByRole("button", { name: 'Start: move "Contested" to Doing' }));
    await screen.findByRole("alert");

    // "Contested" is still held at the version that just conflicted, so the
    // next move that can succeed is necessarily a different card.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ...other, status: "doing", version: 2 }), { status: 200 }),
    );
    await user.click(screen.getByRole("button", { name: 'Start: move "Other card" to Doing' }));

    await waitFor(() => expect(statusButton("Doing")).toHaveAccessibleName("Doing 1"));

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
    await user.click(screen.getByRole("button", { name: 'Start: move "Contested" to Doing' }));
    await screen.findByRole("alert");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    );
    await user.click(screen.getByRole("button", { name: 'Start: move "Other card" to Doing' }));

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
    await user.click(screen.getByRole("button", { name: 'Start: move "Move me" to Doing' }));
    await screen.findByRole("alert");

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ...card, status: "doing", version: 2 }), { status: 200 }),
    );
    await user.click(screen.getByRole("button", { name: 'Start: move "Move me" to Doing' }));

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
    expect(within(lane()).getByText("Keep me")).toBeInTheDocument();
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
    expect(statusButton("Backlog")).toHaveAccessibleName("Backlog 1");

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
    expect(within(lane()).getByText("Contested")).toBeInTheDocument();
    expect(within(lane()).getByText(/changed somewhere else/i)).toBeInTheDocument();
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
    expect(within(lane()).getByText("Already gone")).toBeInTheDocument();
    expect(within(lane()).getByText(/changed somewhere else/i)).toBeInTheDocument();
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
    expect(within(lane()).getByText("Delete me")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: 'Start: move "Contested" to Doing' }));
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
    expect(within(lane()).getByText("Delete me")).toBeInTheDocument();
  });

  it("asks the gate to re-check the session when the API returns 401", async () => {
    const onAuthLost = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 }),
    );

    render(<Board csrfToken={csrfToken} onAuthLost={onAuthLost} />);

    await waitFor(() => expect(onAuthLost).toHaveBeenCalled());
    // A lost session is not a failed board: the gate replaces this view, so the
    // owner is never told to retry something a retry cannot fix.
    expect(screen.queryByText("The board did not load")).toBeNull();
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

    await user.type(screen.getByLabelText("Add a card to Backlog"), "Bad card");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid_card_input");
  });

  it("can be operated from the keyboard alone, in the order the page reads", async () => {
    const user = userEvent.setup();
    const card = makeCard({ title: "Reachable" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([card]), { status: 200 }));

    render(<Board csrfToken={csrfToken} />);
    await screen.findByText("Reachable");

    await user.tab();
    expect(statusButton("Backlog")).toHaveFocus();
    await user.tab();
    expect(statusButton("Doing")).toHaveFocus();
    await user.tab();
    expect(statusButton("Done")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Add a card to Backlog")).toHaveFocus();

    // Submitting is disabled, and so unreachable, until there is a title to
    // send; typing one puts the button back in the tab order where it reads.
    await user.keyboard("A title");
    await user.tab();
    expect(screen.getByRole("button", { name: "Add card" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: 'Start: move "Reachable" to Doing' })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: 'Skip to Done: move "Reachable" to Done' }),
    ).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: 'Delete "Reachable"' })).toHaveFocus();

    // Space activates the focused status button, as it must for a native button.
    statusButton("Done").focus();
    await user.keyboard(" ");
    expect(screen.getByRole("heading", { name: "Done" })).toBeInTheDocument();
    expect(statusButton("Done")).toHaveAttribute("aria-pressed", "true");
  });
});
