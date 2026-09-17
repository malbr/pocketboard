// THROWAWAY PROTOTYPE — Variant C. Delete with the rest of src/prototype/.
//
// Command ledger: deliberately not a card grid. Every card is one row in a
// single register, ordered by status then by age, so the whole board is read
// top to bottom and the deciding fields (where it sits, how long it has sat)
// come first. The primary affordance is a row command, not a spatial move.

import { useState, type FormEvent } from "react";
import type { Card } from "@pocketboard/shared";
import { statusLabels, statusOrder, waitedForCompact } from "./fixtures";
import { ARROW_KEY_OWNER } from "./PrototypeSwitcher";
import type { VariantProps } from "./variant";

export const variantCName = "Command ledger";

function ledgerOrder(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => {
    const byStatus = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
    return byStatus !== 0 ? byStatus : a.createdAt.localeCompare(b.createdAt);
  });
}

function LedgerRow({
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
  return (
    <tr className="lg__row">
      <td className="lg__cell lg__cell--where">{statusLabels[card.status]}</td>
      <td className="lg__cell lg__cell--card">
        {card.title}
        {contested && (
          <span className="lg__flag"> — changed elsewhere, reload to catch up</span>
        )}
      </td>
      <td className="lg__cell lg__cell--num">{waitedForCompact(card.createdAt)}</td>
      <td className="lg__cell lg__cell--num lg__cell--rev">{card.version}</td>
      <td className="lg__cell lg__cell--move">
        {statusOrder
          .filter((target) => target !== card.status)
          .map((target) => (
            <button
              key={target}
              type="button"
              className="lg__command"
              aria-label={`Move “${card.title}” to ${statusLabels[target]}`}
              onClick={() => onMove(card, target)}
            >
              {statusLabels[target]}
            </button>
          ))}
      </td>
      <td className="lg__cell lg__cell--remove">
        <button
          type="button"
          className="lg__command lg__command--remove"
          aria-label={`Delete “${card.title}”`}
          onClick={() => onDelete(card)}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

export function VariantC({ snapshot, onMove, onDelete, onCreate, onRetry }: VariantProps) {
  const { phase, cards, notice, contestedCardId } = snapshot;
  const [title, setTitle] = useState("");
  const trimmed = title.trim();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed) {
      return;
    }
    onCreate(trimmed);
    setTitle("");
  }

  if (phase === "error") {
    return (
      <div className="lg">
        <header className="lg__head">
          <h1 className="lg__title">Board ledger</h1>
        </header>
        <div className="lg__message" role="alert">
          <p className="lg__message-head">The board did not load.</p>
          <p className="lg__message-body">
            The card list request failed, so the ledger has no rows to show. Nothing has been
            lost.
          </p>
          <button type="button" className="lg__add" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const rows = ledgerOrder(cards);

  return (
    <div className="lg">
      <header className="lg__head">
        <h1 className="lg__title">Board ledger</h1>
        {phase === "ready" && (
          <p className="lg__summary">
            {rows.length === 0
              ? "No entries."
              : `${rows.length} entries · ${cards.filter((card) => card.status !== "done").length} still open`}
          </p>
        )}
      </header>

      {phase === "loading" && (
        <p className="lg__loading" role="status">
          Reading the board…
        </p>
      )}

      {notice && (
        <p className="lg__notice" role="alert">
          {notice.text}
        </p>
      )}

      {/* Labelled and focusable so the ledger can be scrolled sideways by
          keyboard on a narrow screen, which is where a wide register hurts.
          ARROW_KEY_OWNER keeps the switcher's ← / → shortcut off those keys
          while this region has focus, or the columns to the right would be
          unreachable without a mouse. */}
      <div
        className="lg__scroll"
        role="region"
        aria-label="Board ledger"
        tabIndex={0}
        {...ARROW_KEY_OWNER}
      >
        <table className="lg__table">
          <caption className="lg__caption">
            All cards, grouped by status in board order, oldest first.
          </caption>
          <thead>
            <tr>
              <th className="lg__th" scope="col">
                Where
              </th>
              <th className="lg__th" scope="col">
                Card
              </th>
              <th className="lg__th lg__cell--num" scope="col">
                Waiting
              </th>
              <th className="lg__th lg__cell--num" scope="col">
                Rev
              </th>
              <th className="lg__th" scope="col">
                Move to
              </th>
              <th className="lg__th" scope="col">
                Remove
              </th>
            </tr>
          </thead>
          <tbody data-testid="prototype-ledger-body">
            {phase === "ready" && rows.length === 0 && (
              <tr>
                <td className="lg__cell lg__cell--blank" colSpan={6}>
                  No cards yet. Write the first entry in the row below.
                </td>
              </tr>
            )}
            {rows.map((card) => (
              <LedgerRow
                key={card.id}
                card={card}
                contested={card.id === contestedCardId}
                onMove={onMove}
                onDelete={onDelete}
              />
            ))}
          </tbody>
        </table>
      </div>

      <form className="lg__entry" onSubmit={handleSubmit}>
        <label className="lg__entry-label" htmlFor="lg-new-card">
          New entry, filed under Backlog
        </label>
        <div className="lg__entry-row">
          <input
            id="lg-new-card"
            className="lg__input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button type="submit" className="lg__add" disabled={!trimmed}>
            Add
          </button>
        </div>
      </form>
    </div>
  );
}
