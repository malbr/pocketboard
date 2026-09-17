import { useEffect, useState } from "react";
import type { Card, CardStatus } from "@pocketboard/shared";
import {
  AuthRequiredError,
  CardVersionConflictError,
  createCard,
  fetchCards,
  moveCard,
} from "../api/client";
import { Column, columnLabels } from "./Column";
import { CardForm } from "./CardForm";

/**
 * A message about the last move that did not go through.
 *
 * `reloadRequired` marks the guidance a conflict produces. The board keeps
 * showing the contested card at the version that just lost, so nothing the
 * owner does here can bring it up to date — only a reload can. Whatever
 * happens to some other card, succeeding or failing, says nothing about the
 * contested one, so that guidance outlives both and an ordinary failure never
 * displaces it.
 */
interface MoveNotice {
  text: string;
  reloadRequired: boolean;
}

interface BoardProps {
  csrfToken: string;
  /** Called when the API reports the session is gone mid-session. */
  onAuthLost?: () => void;
}

export function Board({ csrfToken, onAuthLost }: BoardProps) {
  const [cards, setCards] = useState<Card[]>([]);
  const [moveNotice, setMoveNotice] = useState<MoveNotice | null>(null);

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
      setMoveNotice((current) => (current?.reloadRequired ? current : null));
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        onAuthLost?.();
        return;
      }
      if (error instanceof CardVersionConflictError) {
        // The board on screen is the one the owner has been reading. Rewriting
        // it under them would hide the very change that caused the conflict, so
        // it stays and the message says what happened and how to catch up.
        setMoveNotice({
          text:
            `“${error.card.title}” was changed somewhere else and is now in ` +
            `${columnLabels[error.card.status]}. Reload the page to catch up with the board, ` +
            `then move it again.`,
          reloadRequired: true,
        });
        return;
      }
      setMoveNotice((current) =>
        current?.reloadRequired
          ? current
          : { text: `“${card.title}” could not be moved. Try again.`, reloadRequired: false },
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
      {moveNotice && <p role="alert">{moveNotice.text}</p>}
      <Column status="backlog" cards={byStatus.backlog} onMove={handleMove}>
        <CardForm onCreate={handleCreate} />
      </Column>
      <Column status="doing" cards={byStatus.doing} onMove={handleMove} />
      <Column status="done" cards={byStatus.done} onMove={handleMove} />
    </main>
  );
}
