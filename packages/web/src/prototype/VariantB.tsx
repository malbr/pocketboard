// THROWAWAY PROTOTYPE — Variant B. Delete with the rest of src/prototype/.
//
// Focused lane: one status fills the page, reached through a status navigation.
// The hierarchy is inverted against Variant A — the status is the subject and
// the cards are its contents — and the primary affordance is the single step
// forward ("Start", "Finish", "Reopen") rather than a choice of destination.

import { useState, type FormEvent } from "react";
import { CardStatus, type Card } from "@pocketboard/shared";
import { statusLabels, statusOrder, waitedFor } from "./fixtures";
import type { VariantProps } from "./variant";

export const variantBName = "Focused lane";

interface Step {
  label: string;
  target: CardStatus;
}

/** The one move that follows from standing in this status, and the way back. */
const forwardStep: Record<CardStatus, Step> = {
  backlog: { label: "Start", target: CardStatus.Doing },
  doing: { label: "Finish", target: CardStatus.Done },
  done: { label: "Reopen", target: CardStatus.Doing },
};

const sideStep: Record<CardStatus, Step> = {
  backlog: { label: "Skip to Done", target: CardStatus.Done },
  doing: { label: "Back to Backlog", target: CardStatus.Backlog },
  done: { label: "Back to Backlog", target: CardStatus.Backlog },
};

function leadLine(status: CardStatus, cards: Card[]): string {
  if (cards.length === 0) {
    return status === "backlog"
      ? "Nothing queued."
      : `Nothing has reached ${statusLabels[status]}.`;
  }
  const oldest = cards.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
  const count = `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
  return `${count}. The oldest has been on the board ${waitedFor(oldest.createdAt)}.`;
}

function WorkspaceRow({
  card,
  contested,
  onMove,
  onDelete,
}: {
  card: Card;
  contested: boolean;
  onMove: VariantProps["onMove"];
  onDelete: VariantProps["onDelete"];
}) {
  const forward = forwardStep[card.status];
  const side = sideStep[card.status];

  return (
    <li className="fw-row">
      <div className="fw-row__text">
        <p className="fw-row__title">{card.title}</p>
        <p className="fw-row__meta">
          On the board {waitedFor(card.createdAt)} · revision {card.version}
        </p>
        {contested && (
          <p className="fw-row__contested">
            Changed elsewhere — this is the card as you last read it. Reload to catch up.
          </p>
        )}
      </div>
      <div className="fw-row__actions">
        <button
          type="button"
          className="fw-row__primary"
          aria-label={`${forward.label} “${card.title}” — move to ${statusLabels[forward.target]}`}
          onClick={() => onMove(card, forward.target)}
        >
          {forward.label}
        </button>
        <button
          type="button"
          className="fw-row__secondary"
          aria-label={`Move “${card.title}” to ${statusLabels[side.target]}`}
          onClick={() => onMove(card, side.target)}
        >
          {side.label}
        </button>
        <button
          type="button"
          className="fw-row__secondary"
          aria-label={`Delete “${card.title}”`}
          onClick={() => onDelete(card)}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

export function VariantB({ snapshot, onMove, onDelete, onCreate, onRetry }: VariantProps) {
  const { phase, cards, notice, contestedCardId } = snapshot;
  const [selected, setSelected] = useState<CardStatus>(CardStatus.Backlog);
  const [title, setTitle] = useState("");
  const trimmed = title.trim();

  const shown = cards.filter((card) => card.status === selected);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed) {
      return;
    }
    onCreate(trimmed);
    setTitle("");
    setSelected(CardStatus.Backlog);
  }

  return (
    <div className="fw">
      <header className="fw__bar">
        <p className="fw__product">PocketBoard</p>
        {/* Buttons, not a tablist: a tablist would claim the arrow keys, and in
            this prototype those belong to the variant switcher. */}
        <nav className="fw__nav" aria-label="Board status">
          {statusOrder.map((status) => (
            <button
              key={status}
              type="button"
              className="fw__nav-item"
              aria-pressed={status === selected}
              onClick={() => setSelected(status)}
            >
              {statusLabels[status]}
              <span className="fw__nav-count">
                {phase === "ready" ? cards.filter((card) => card.status === status).length : "—"}
              </span>
            </button>
          ))}
        </nav>
      </header>

      <main className="fw__stage">
        {notice && (
          <p className="fw__notice" role="alert">
            {notice.text}
          </p>
        )}

        {phase === "error" ? (
          <div role="alert">
            <h1 className="fw__heading">The board did not load</h1>
            <p className="fw__lead">
              The card list request failed, so none of the three statuses can be shown. Nothing
              has been lost.
            </p>
            <button type="button" className="fw__submit fw__retry" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <h1 className="fw__heading">{statusLabels[selected]}</h1>
            {phase === "loading" ? (
              <p className="fw__lead" role="status">
                Reading the board…
              </p>
            ) : (
              <p className="fw__lead">{leadLine(selected, shown)}</p>
            )}

            <form className="fw__compose" onSubmit={handleSubmit}>
              <label className="fw__compose-label" htmlFor="fw-new-card">
                Add a card to Backlog
              </label>
              <div className="fw__compose-row">
                <input
                  id="fw-new-card"
                  className="fw__input"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <button type="submit" className="fw__submit" disabled={!trimmed}>
                  Add
                </button>
              </div>
            </form>

            {phase === "ready" && shown.length === 0 && (
              <p className="fw__empty">
                {selected === "backlog"
                  ? "Add the first card above to start the board."
                  : `Move a card out of ${statusLabels[selected === "doing" ? "backlog" : "doing"]} and it lands here.`}
              </p>
            )}

            <ul className="fw__list" data-testid={`prototype-lane-${selected}`}>
              {shown.map((card) => (
                <WorkspaceRow
                  key={card.id}
                  card={card}
                  contested={card.id === contestedCardId}
                  onMove={onMove}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}
