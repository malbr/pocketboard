import { CardStatus, type Card } from "@pocketboard/shared";

export const columnLabels: Record<CardStatus, string> = {
  backlog: "Backlog",
  doing: "Doing",
  done: "Done",
};

const columnOrder: CardStatus[] = [CardStatus.Backlog, CardStatus.Doing, CardStatus.Done];

interface ColumnProps {
  status: CardStatus;
  cards: Card[];
  onMove: (card: Card, status: CardStatus) => void;
  children?: React.ReactNode;
}

export function Column({ status, cards, onMove, children }: ColumnProps) {
  return (
    <section data-testid={`column-${status}`}>
      <h2>{columnLabels[status]}</h2>
      {children}
      <ul>
        {cards.map((card) => (
          <li key={card.id}>
            {card.title}
            {columnOrder
              .filter((target) => target !== status)
              .map((target) => (
                <button
                  key={target}
                  type="button"
                  // Several cards can offer "Doing"; the title is what tells
                  // a screen-reader user which card this button moves.
                  aria-label={`Move "${card.title}" to ${columnLabels[target]}`}
                  onClick={() => onMove(card, target)}
                >
                  {columnLabels[target]}
                </button>
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
