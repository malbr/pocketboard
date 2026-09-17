import { CardStatus, type Card } from "@pocketboard/shared";

export const statusLabels: Record<CardStatus, string> = {
  backlog: "Backlog",
  doing: "Doing",
  done: "Done",
};

export const statusOrder: CardStatus[] = [CardStatus.Backlog, CardStatus.Doing, CardStatus.Done];

interface Step {
  label: string;
  target: CardStatus;
}

/**
 * The step that follows from standing in this status. A card in Backlog is
 * started, a card in Doing is finished, a card in Done is reopened: naming the
 * step rather than the destination is what makes one move the obvious one.
 */
const nextStep: Record<CardStatus, Step> = {
  backlog: { label: "Start", target: CardStatus.Doing },
  doing: { label: "Finish", target: CardStatus.Done },
  done: { label: "Reopen", target: CardStatus.Doing },
};

/** The other destination, kept reachable but never presented as the next move. */
const otherStep: Record<CardStatus, Step> = {
  backlog: { label: "Skip to Done", target: CardStatus.Done },
  doing: { label: "Back to Backlog", target: CardStatus.Backlog },
  done: { label: "Back to Backlog", target: CardStatus.Backlog },
};

/**
 * Several rows offer "Start", so the visible word alone cannot say which card
 * moves or where. The accessible name opens with that visible word — voice
 * control matches on it — then names the card and the destination.
 */
function moveLabel(step: Step, card: Card): string {
  return `${step.label}: move "${card.title}" to ${statusLabels[step.target]}`;
}

const HOUR_MS = 3_600_000;

/**
 * How long the card has been on the board, in the coarsest unit that is still
 * true. `now` is injectable so the rounding boundaries can be tested without
 * waiting for the clock.
 */
export function cardAge(createdAt: string, now: number = Date.now()): string {
  const hours = (now - new Date(createdAt).getTime()) / HOUR_MS;
  if (hours < 1) {
    return "under an hour";
  }
  const whole = Math.round(hours);
  if (whole < 48) {
    return `${whole} ${whole === 1 ? "hour" : "hours"}`;
  }
  return `${Math.round(hours / 24)} days`;
}

interface CardRowProps {
  card: Card;
  /** True when this is the card the API refused, so the row can say so in place. */
  contested: boolean;
  onMove: (card: Card, status: CardStatus) => void;
  onDelete: (card: Card) => void;
}

export function CardRow({ card, contested, onMove, onDelete }: CardRowProps) {
  const next = nextStep[card.status];
  const other = otherStep[card.status];

  return (
    <li className="row">
      <div className="row__text">
        <p className="row__title">{card.title}</p>
        <p className="row__meta">
          On the board {cardAge(card.createdAt)} · revision {card.version}
        </p>
        {contested && (
          <p className="row__contested">
            Changed somewhere else. This is the card as you last read it; reload to catch up.
          </p>
        )}
      </div>
      <div className="row__actions">
        <button
          type="button"
          className="row__primary"
          aria-label={moveLabel(next, card)}
          onClick={() => onMove(card, next.target)}
        >
          {next.label}
        </button>
        <button
          type="button"
          className="row__quiet"
          aria-label={moveLabel(other, card)}
          onClick={() => onMove(card, other.target)}
        >
          {other.label}
        </button>
        <button
          type="button"
          className="row__quiet"
          aria-label={`Delete "${card.title}"`}
          onClick={() => onDelete(card)}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
