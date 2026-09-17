import { useEffect, useState } from "react";
import type { Card } from "@pocketboard/shared";
import { AuthRequiredError, createCard, fetchCards } from "../api/client";
import { Column } from "./Column";
import { CardForm } from "./CardForm";

interface BoardProps {
  csrfToken: string;
  /** Called when the API reports the session is gone mid-session. */
  onAuthLost?: () => void;
}

export function Board({ csrfToken, onAuthLost }: BoardProps) {
  const [cards, setCards] = useState<Card[]>([]);

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

  const byStatus = {
    backlog: cards.filter((card) => card.status === "backlog"),
    doing: cards.filter((card) => card.status === "doing"),
    done: cards.filter((card) => card.status === "done"),
  };

  return (
    <main>
      <Column status="backlog" cards={byStatus.backlog}>
        <CardForm onCreate={handleCreate} />
      </Column>
      <Column status="doing" cards={byStatus.doing} />
      <Column status="done" cards={byStatus.done} />
    </main>
  );
}
