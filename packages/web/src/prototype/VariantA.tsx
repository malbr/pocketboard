// THROWAWAY PROTOTYPE — Variant A. Delete with the rest of src/prototype/.
//
// Three-lane workbench: the whole board is on screen at once and a card's
// position is the primary signal. Moving is a lane-named button on the card.

import { useState, type FormEvent } from "react";
import type { Card, CardStatus } from "@pocketboard/shared";
import { statusLabels, statusOrder, waitedFor } from "./fixtures";
import type { VariantProps } from "./variant";

export const variantAName = "Three-lane workbench";

function LaneCard({
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
    <li className="wb-card">
      <p className="wb-card__title">{card.title}</p>
      <p className="wb-card__meta">
        Waiting {waitedFor(card.createdAt)} · revision {card.version}
      </p>
      {contested && (
        <p className="wb-card__contested">Changed elsewhere — reload to catch up.</p>
      )}
      <div className="wb-card__actions">
        {statusOrder
          .filter((target) => target !== card.status)
          .map((target) => (
            <button
              key={target}
              type="button"
              className="wb-card__move"
              aria-label={`Move “${card.title}” to ${statusLabels[target]}`}
              onClick={() => onMove(card, target)}
            >
              {statusLabels[target]}
            </button>
          ))}
        <button
          type="button"
          className="wb-card__delete"
          aria-label={`Delete “${card.title}”`}
          onClick={() => onDelete(card)}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function LaneCompose({ onCreate }: { onCreate: VariantProps["onCreate"] }) {
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

  return (
    <form className="wb-compose" onSubmit={handleSubmit}>
      <label className="wb-compose__label" htmlFor="wb-new-card">
        New card
      </label>
      <div className="wb-compose__row">
        <input
          id="wb-new-card"
          className="wb-compose__input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button type="submit" className="wb-compose__submit" disabled={!trimmed}>
          Add
        </button>
      </div>
    </form>
  );
}

export function VariantA({ snapshot, onMove, onDelete, onCreate, onRetry }: VariantProps) {
  const { phase, cards, notice, contestedCardId } = snapshot;

  if (phase === "error") {
    return (
      <div className="wb">
        <header className="wb__bar">
          <h1 className="wb__title">PocketBoard</h1>
        </header>
        <div className="wb__message" role="alert">
          <p className="wb__message-head">The board did not load.</p>
          <p className="wb__message-body">
            The card list request failed. Nothing has been lost — try reading the board again.
          </p>
          <button type="button" className="wb-compose__submit" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const byStatus = (status: CardStatus) => cards.filter((card) => card.status === status);

  return (
    <div className="wb">
      <header className="wb__bar">
        <h1 className="wb__title">PocketBoard</h1>
        {phase === "ready" && (
          <p className="wb__count">
            {cards.length === 0
              ? "No cards on the board"
              : `${cards.length} ${cards.length === 1 ? "card" : "cards"} on the board`}
          </p>
        )}
      </header>

      {phase === "loading" && (
        <p className="wb__message-body wb__loading" role="status">
          Reading the board…
        </p>
      )}

      {notice && (
        <p className="wb__notice" role="alert">
          {notice.text}
        </p>
      )}

      <div className="wb__lanes">
        {statusOrder.map((status) => {
          const laneCards = byStatus(status);
          return (
            <section
              key={status}
              className="wb__lane"
              aria-labelledby={`wb-lane-${status}`}
              data-testid={`prototype-lane-${status}`}
            >
              <h2 className="wb__lane-head" id={`wb-lane-${status}`}>
                {statusLabels[status]}
                <span className="wb__lane-count">{laneCards.length}</span>
              </h2>

              {status === "backlog" && <LaneCompose onCreate={onCreate} />}

              {phase === "ready" && laneCards.length === 0 && (
                <p className="wb__lane-empty">
                  {status === "backlog"
                    ? "Nothing queued. Add the first card above."
                    : `Nothing in ${statusLabels[status]} yet.`}
                </p>
              )}

              <ul className="wb__lane-list">
                {laneCards.map((card) => (
                  <LaneCard
                    key={card.id}
                    card={card}
                    contested={card.id === contestedCardId}
                    onMove={onMove}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
