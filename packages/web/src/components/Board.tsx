import { useEffect, useState } from "react";
import type { Card } from "@pocketboard/shared";
import { createCard, fetchCards } from "../api/client";
import { Column } from "./Column";
import { CardForm } from "./CardForm";

export function Board() {
  const [cards, setCards] = useState<Card[]>([]);

  useEffect(() => {
    fetchCards().then(setCards).catch(() => setCards([]));
  }, []);

  async function handleCreate(title: string) {
    const created = await createCard(title);
    setCards((current) => [created, ...current]);
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
