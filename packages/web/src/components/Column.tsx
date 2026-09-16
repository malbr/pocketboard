import type { Card, CardStatus } from "@pocketboard/shared";

const columnLabels: Record<CardStatus, string> = {
  backlog: "Backlog",
  doing: "Doing",
  done: "Done",
};

interface ColumnProps {
  status: CardStatus;
  cards: Card[];
  children?: React.ReactNode;
}

export function Column({ status, cards, children }: ColumnProps) {
  return (
    <section data-testid={`column-${status}`}>
      <h2>{columnLabels[status]}</h2>
      {children}
      <ul>
        {cards.map((card) => (
          <li key={card.id}>{card.title}</li>
        ))}
      </ul>
    </section>
  );
}
