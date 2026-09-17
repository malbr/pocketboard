import { useEffect, useState } from "react";
import type { Card, CardStatus } from "@pocketboard/shared";
import {
  AuthRequiredError,
  CardNotFoundError,
  CardVersionConflictError,
  createCard,
  deleteCard,
  fetchCards,
  moveCard,
} from "../api/client";
import { Column, columnLabels } from "./Column";
import { CardForm } from "./CardForm";

/**
 * A message about the last change that did not go through.
 *
 * `reloadRequired` marks the guidance a stale or missing card produces. The
 * board keeps showing that card as the owner last read it, so nothing they do
 * here can bring it up to date — only a reload can. Whatever happens to some
 * other card, succeeding or failing, says nothing about the contested one, so
 * that guidance outlives both and an ordinary failure never displaces it.
 */
interface CardNotice {
  text: string;
  reloadRequired: boolean;
}

/**
 * The board the API refused to change is the board the owner has been reading.
 * Rewriting it under them would hide the very change that caused the refusal,
 * so it stays and the message says what happened and how to catch up.
 */
function conflictNotice(current: Card, retry: string): CardNotice {
  return {
    text:
      `“${current.title}” was changed somewhere else and is now in ` +
      `${columnLabels[current.status]}. Reload the page to catch up with the board, ` +
      `then ${retry} it again.`,
    reloadRequired: true,
  };
}

interface BoardProps {
  csrfToken: string;
  /** Called when the API reports the session is gone mid-session. */
  onAuthLost?: () => void;
}

export function Board({ csrfToken, onAuthLost }: BoardProps) {
  const [cards, setCards] = useState<Card[]>([]);
  const [notice, setNotice] = useState<CardNotice | null>(null);

  useEffect(() => {
    fetchCards()
      .then(setCards)
      .catch((error: unknown) => {
        if (error instanceof AuthRequiredError) {
          onAuthLost?.();
          return;
        }
        setCards([]);
      });
  }, [onAuthLost]);

  async function handleCreate(title: string) {
    try {
      const created = await createCard(title, csrfToken);
      setCards((current) => [created, ...current]);
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
          : { text: `“${card.title}” could not be moved. Try again.`, reloadRequired: false },
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
        });
        return;
      }
      setNotice((current) =>
        current?.reloadRequired
          ? current
          : { text: `“${card.title}” could not be deleted. Try again.`, reloadRequired: false },
      );
    }
  }

  const byStatus = {
    backlog: cards.filter((card) => card.status === "backlog"),
    doing: cards.filter((card) => card.status === "doing"),
    done: cards.filter((card) => card.status === "done"),
  };

  return (
    <main>
      {notice && <p role="alert">{notice.text}</p>}
      <Column
        status="backlog"
        cards={byStatus.backlog}
        onMove={handleMove}
        onDelete={handleDelete}
      >
        <CardForm onCreate={handleCreate} />
      </Column>
      <Column status="doing" cards={byStatus.doing} onMove={handleMove} onDelete={handleDelete} />
      <Column status="done" cards={byStatus.done} onMove={handleMove} onDelete={handleDelete} />
    </main>
  );
}
