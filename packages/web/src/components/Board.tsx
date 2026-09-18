import { useCallback, useEffect, useState } from "react";
import { CardStatus, type Card } from "@pocketboard/shared";
import {
  AuthRequiredError,
  CardNotFoundError,
  CardVersionConflictError,
  createCard,
  deleteCard,
  fetchCards,
  moveCard,
} from "../api/client";
import { CardRow, cardAge, statusLabels, statusOrder } from "./CardRow";
import { CardForm } from "./CardForm";

/**
 * A message about the last change that did not go through.
 *
 * `reloadRequired` marks the guidance a stale or missing card produces. The
 * board keeps showing that card as the owner last read it, so nothing they do
 * here can bring it up to date — only a reload can. Whatever happens to some
 * other card, succeeding or failing, says nothing about the contested one, so
 * that guidance outlives both and an ordinary failure never displaces it.
 *
 * `cardId` lets the lane mark the contested card where it still sits, so the
 * message at the top of the page and the row it is about are connected even
 * when the lane holds a dozen other cards.
 */
interface CardNotice {
  text: string;
  reloadRequired: boolean;
  cardId: string;
}

/** Whether the card list has been read yet, and whether reading it worked. */
type LoadPhase = "loading" | "ready" | "failed";

/**
 * The board the API refused to change is the board the owner has been reading.
 * Rewriting it under them would hide the very change that caused the refusal,
 * so it stays and the message says what happened and how to catch up.
 */
function conflictNotice(current: Card, retry: string): CardNotice {
  return {
    text:
      `“${current.title}” was changed somewhere else and is now in ` +
      `${statusLabels[current.status]}. Reload the page to catch up with the board, ` +
      `then ${retry} it again.`,
    reloadRequired: true,
    cardId: current.id,
  };
}

/** What the owner is looking at, said in terms of the cards actually there. */
function leadLine(cards: Card[]): string {
  const oldest = cards.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
  const count = `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
  return `${count}. The oldest has been on the board ${cardAge(oldest.createdAt)}.`;
}

/** An empty status says why it is empty and what fills it. */
function emptyLine(status: CardStatus): string {
  if (status === CardStatus.Backlog) {
    return "No cards in Backlog. Add one above and it starts here.";
  }
  if (status === CardStatus.Doing) {
    return "Nothing is in Doing. Start a card in Backlog and it moves here.";
  }
  return "Nothing has reached Done. Finish a card in Doing and it lands here.";
}

interface BoardProps {
  csrfToken: string;
  /** Called when the API reports the session is gone mid-session. */
  onAuthLost?: () => void;
}

export function Board({ csrfToken, onAuthLost }: BoardProps) {
  const [cards, setCards] = useState<Card[]>([]);
  const [notice, setNotice] = useState<CardNotice | null>(null);
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [selected, setSelected] = useState<CardStatus>(CardStatus.Backlog);

  const load = useCallback(() => {
    setPhase("loading");
    fetchCards()
      .then((loaded) => {
        setCards(loaded);
        setPhase("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof AuthRequiredError) {
          // The gate is about to replace this view with the sign-in prompt, so
          // there is no board state worth deciding on here.
          onAuthLost?.();
          return;
        }
        setPhase("failed");
      });
  }, [onAuthLost]);

  useEffect(load, [load]);

  async function handleCreate(title: string) {
    try {
      const created = await createCard(title, csrfToken);
      setCards((current) => [created, ...current]);
      // A card is always created into Backlog. Staying on Doing or Done would
      // drop it into a status the owner cannot see, so the lane follows it.
      setSelected(CardStatus.Backlog);
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        onAuthLost?.();
      }
      throw error;
    }
  }

  async function handleMove(card: Card, status: CardStatus) {
    try {
      const moved = await moveCard(card.id, status, card.version, csrfToken);
      setCards((current) =>
        current.map((candidate) => (candidate.id === moved.id ? moved : candidate)),
      );
      setNotice((current) => (current?.reloadRequired ? current : null));
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        onAuthLost?.();
        return;
      }
      if (error instanceof CardVersionConflictError) {
        setNotice(conflictNotice(error.card, "move"));
        return;
      }
      setNotice((current) =>
        current?.reloadRequired
          ? current
          : {
              text: `“${card.title}” could not be moved. Try again.`,
              reloadRequired: false,
              cardId: card.id,
            },
      );
    }
  }

  async function handleDelete(card: Card) {
    // Deleting is the one card action nothing here can undo, so it goes through
    // the browser's own modal dialog: it names the card, and it cannot be
    // missed, auto-dismissed, or clicked past by accident.
    const confirmed = window.confirm(
      `Delete “${card.title}”? This removes the card from the board permanently ` +
        `and cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    try {
      await deleteCard(card.id, card.version, csrfToken);
      setCards((current) => current.filter((candidate) => candidate.id !== card.id));
      setNotice((current) => (current?.reloadRequired ? current : null));
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        onAuthLost?.();
        return;
      }
      if (error instanceof CardVersionConflictError) {
        setNotice(conflictNotice(error.card, "delete"));
        return;
      }
      if (error instanceof CardNotFoundError) {
        // The card is gone, but so is the board's claim to be current: the rest
        // of it was read at the same moment. Dropping just this one card would
        // present the remainder as fresh, so the whole board is left alone.
        setNotice({
          text:
            `“${card.title}” was already deleted somewhere else. Reload the page to ` +
            `catch up with the board.`,
          reloadRequired: true,
          cardId: card.id,
        });
        return;
      }
      setNotice((current) =>
        current?.reloadRequired
          ? current
          : {
              text: `“${card.title}” could not be deleted. Try again.`,
              reloadRequired: false,
              cardId: card.id,
            },
      );
    }
  }

  const shown = cards.filter((card) => card.status === selected);

  return (
    <>
      {phase !== "failed" && (
        // Buttons, not a tablist: nothing here is a tab panel, and claiming
        // that role would take over the arrow keys without providing what a
        // tablist promises. aria-pressed carries the selection instead.
        <nav className="lane-nav" aria-label="Board status">
          {statusOrder.map((status) => (
            <button
              key={status}
              type="button"
              className="lane-nav__item"
              aria-pressed={status === selected}
              onClick={() => setSelected(status)}
            >
              {statusLabels[status]}
              {phase === "ready" && (
                <span className="lane-nav__count">
                  {cards.filter((card) => card.status === status).length}
                </span>
              )}
            </button>
          ))}
        </nav>
      )}

      <main className="lane">
        {notice && (
          <p className="lane__notice" role="alert">
            {notice.text}
          </p>
        )}

        {phase === "failed" ? (
          <div role="alert">
            <h1 className="lane__heading">The board did not load</h1>
            <p className="lane__lead">
              The card list could not be read, so no status can be shown. Nothing on the board
              has been lost.
            </p>
            <button type="button" className="lane__retry" onClick={load}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <h1 className="lane__heading">{statusLabels[selected]}</h1>
            {phase === "loading" ? (
              <p className="lane__lead" role="status">
                Reading the board…
              </p>
            ) : (
              shown.length > 0 && <p className="lane__lead">{leadLine(shown)}</p>
            )}

            {/* Creating against a board that has not arrived yet loses the
                card from view: the list the API is still sending replaces the
                one holding it. The form waits for a board to add to. */}
            {phase === "ready" && <CardForm onCreate={handleCreate} />}

            {phase === "ready" && shown.length === 0 && (
              <p className="lane__empty">{emptyLine(selected)}</p>
            )}

            <ul className="lane__list">
              {shown.map((card) => (
                <CardRow
                  key={card.id}
                  card={card}
                  contested={Boolean(notice?.reloadRequired) && notice?.cardId === card.id}
                  onMove={handleMove}
                  onDelete={handleDelete}
                />
              ))}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
