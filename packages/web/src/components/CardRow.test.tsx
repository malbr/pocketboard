import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Card, CardStatus } from "@pocketboard/shared";
import { CardRow, cardAge } from "./CardRow";

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

const NOW = new Date("2026-09-18T12:00:00.000Z").getTime();

function agoByHours(hours: number): string {
  return new Date(NOW - hours * 3_600_000).toISOString();
}

describe("cardAge", () => {
  it("says under an hour rather than rounding a fresh card to zero", () => {
    expect(cardAge(agoByHours(0.4), NOW)).toBe("under an hour");
  });

  it("uses the singular for one hour", () => {
    expect(cardAge(agoByHours(1), NOW)).toBe("1 hour");
  });

  it("counts in hours up to two days", () => {
    expect(cardAge(agoByHours(30), NOW)).toBe("30 hours");
  });

  it("switches to days rather than reporting 48 hours", () => {
    expect(cardAge(agoByHours(47.8), NOW)).toBe("2 days");
    expect(cardAge(agoByHours(144), NOW)).toBe("6 days");
  });

  it("treats a card dated in the future as brand new instead of negative", () => {
    expect(cardAge(agoByHours(-5), NOW)).toBe("under an hour");
  });
});

describe("CardRow", () => {
  const noop = () => {};

  it.each<[CardStatus, string, string, string, string]>([
    ["backlog", "Start", "Doing", "Skip to Done", "Done"],
    ["doing", "Finish", "Done", "Back to Backlog", "Backlog"],
    ["done", "Reopen", "Doing", "Back to Backlog", "Backlog"],
  ])(
    "offers %s the step forward first and names both destinations",
    (status, primary, forward, secondary, sideways) => {
      const card = makeCard({ title: "Named card", status });

      render(
        <ul>
          <CardRow card={card} contested={false} onMove={noop} onDelete={noop} />
        </ul>,
      );

      const buttons = screen.getAllByRole("button");
      // The step forward is the first control in the row, so it is both the
      // first thing read and the first thing reached by Tab.
      expect(buttons[0]).toHaveAccessibleName(`${primary}: move "Named card" to ${forward}`);
      expect(buttons[0]).toHaveTextContent(primary);
      expect(buttons[1]).toHaveAccessibleName(`${secondary}: move "Named card" to ${sideways}`);
      expect(buttons[1]).toHaveTextContent(secondary);
      expect(buttons[2]).toHaveAccessibleName('Delete "Named card"');
    },
  );

  it("sends the card and the destination the button names", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    const card = makeCard({ title: "Move me", status: "doing" });

    render(
      <ul>
        <CardRow card={card} contested={false} onMove={onMove} onDelete={noop} />
      </ul>,
    );

    await user.click(screen.getByRole("button", { name: 'Finish: move "Move me" to Done' }));

    expect(onMove).toHaveBeenCalledWith(card, "done");
  });

  it("shows the card's real age and revision", () => {
    // The row reads the wall clock, so this age is measured from it too.
    const threeDaysAgo = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const card = makeCard({ title: "Old card", createdAt: threeDaysAgo, version: 4 });

    render(
      <ul>
        <CardRow card={card} contested={false} onMove={noop} onDelete={noop} />
      </ul>,
    );

    expect(screen.getByText(/revision 4/)).toHaveTextContent("On the board 3 days");
  });

  it("marks a contested card in words, not only in colour", () => {
    const card = makeCard({ title: "Contested" });

    render(
      <ul>
        <CardRow card={card} contested onMove={noop} onDelete={noop} />
      </ul>,
    );

    expect(screen.getByText(/changed somewhere else/i)).toBeInTheDocument();
  });
});
