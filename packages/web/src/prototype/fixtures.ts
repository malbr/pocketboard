// THROWAWAY PROTOTYPE — delete with the rest of src/prototype/ once the owner
// has picked a board presentation. See NOTES.md in this folder.
//
// In-memory sample board. Nothing here touches the API: the prototype never
// calls the backend and never saves.

import { CardStatus, type Card } from "@pocketboard/shared";

/**
 * Every "waiting" figure the variants show is measured from this instant rather
 * than the wall clock, so two people opening the same URL a week apart compare
 * the same board instead of drifting sample data.
 */
export const FIXTURE_NOW = new Date("2026-09-17T09:30:00.000Z");

const cards: Card[] = [
  {
    id: "4b2f7c1e-8d3a-4c55-9f21-6a0e1d7b3c48",
    title: "Restore drill: rebuild the board from last night's Restic snapshot",
    status: CardStatus.Backlog,
    createdAt: "2026-09-09T11:05:00.000Z",
    version: 1,
  },
  {
    id: "a17d9e30-52b4-4f0c-8e6d-11c3f9a24b57",
    title: "Decide whether a card title may contain line breaks",
    status: CardStatus.Backlog,
    createdAt: "2026-09-12T15:42:00.000Z",
    version: 2,
  },
  {
    id: "c9e41b8a-7f26-4d13-b0a5-3e8d6c25f190",
    title: "Alert through Uptime Kuma when /health stops answering",
    status: CardStatus.Backlog,
    createdAt: "2026-09-15T08:18:00.000Z",
    version: 1,
  },
  {
    id: "2d6a0f53-91c7-4e82-a4b9-58f7e3d0c216",
    title: "Trim the session cookie to the fields the gate actually reads",
    status: CardStatus.Backlog,
    createdAt: "2026-09-16T19:55:00.000Z",
    version: 1,
  },
  {
    id: "7f3c85d2-4a69-4b71-9c08-2e5b1a97d4e3",
    title: "Pick the board presentation the owner will live with",
    status: CardStatus.Doing,
    createdAt: "2026-09-11T07:20:00.000Z",
    version: 3,
  },
  {
    id: "e5b12a47-6c30-4f98-81d7-9a4e0b63c25f",
    title: "Rate-limit the card endpoints per session",
    status: CardStatus.Doing,
    createdAt: "2026-09-14T13:02:00.000Z",
    version: 2,
  },
  {
    id: "93a7e604-2b58-41cd-b6f3-0c7d5e8a1f42",
    title: "Delete a card behind a confirmation the owner cannot miss",
    status: CardStatus.Done,
    createdAt: "2026-09-08T16:30:00.000Z",
    version: 4,
  },
  {
    id: "1c48f7b9-3e02-4a6d-95e8-7b2c6d04a83f",
    title: "Refuse a move that carries a stale version token",
    status: CardStatus.Done,
    createdAt: "2026-09-05T10:11:00.000Z",
    version: 5,
  },
  {
    id: "6e20d9c3-8b47-4152-a0f6-4d3e9c71b58a",
    title: "Restrict sign-in to the owner's GitHub user id",
    status: CardStatus.Done,
    createdAt: "2026-09-02T09:47:00.000Z",
    version: 6,
  },
];

/** The card the conflict state pretends the API refused to change. */
const contestedCard = cards[5];

export type PrototypeStateKey = "populated" | "empty" | "loading" | "error" | "conflict";

export const prototypeStateKeys: PrototypeStateKey[] = [
  "populated",
  "empty",
  "loading",
  "error",
  "conflict",
];

export const prototypeStateLabels: Record<PrototypeStateKey, string> = {
  populated: "Populated board",
  empty: "Empty board",
  loading: "Loading the board",
  error: "Board failed to load",
  conflict: "Move refused as stale",
};

export interface BoardNotice {
  text: string;
  /** Matches Board.tsx: a stale or missing card can only be resolved by a reload. */
  reloadRequired: boolean;
}

export interface BoardSnapshot {
  phase: "ready" | "loading" | "error";
  cards: Card[];
  notice: BoardNotice | null;
  /** The card the API refused, so a variant can mark it where it already sits. */
  contestedCardId: string | null;
}

export function snapshotFor(state: PrototypeStateKey): BoardSnapshot {
  if (state === "loading") {
    return { phase: "loading", cards: [], notice: null, contestedCardId: null };
  }
  if (state === "error") {
    return { phase: "error", cards: [], notice: null, contestedCardId: null };
  }
  if (state === "empty") {
    return { phase: "ready", cards: [], notice: null, contestedCardId: null };
  }
  if (state === "conflict") {
    return {
      phase: "ready",
      cards: cards.map((card) => ({ ...card })),
      notice: {
        text:
          `“${contestedCard.title}” was changed somewhere else and is now in Done. ` +
          `Reload the page to catch up with the board, then move it again.`,
        reloadRequired: true,
      },
      contestedCardId: contestedCard.id,
    };
  }
  return {
    phase: "ready",
    cards: cards.map((card) => ({ ...card })),
    notice: null,
    contestedCardId: null,
  };
}

export const statusOrder: CardStatus[] = [CardStatus.Backlog, CardStatus.Doing, CardStatus.Done];

export const statusLabels: Record<CardStatus, string> = {
  backlog: "Backlog",
  doing: "Doing",
  done: "Done",
};

function hoursSince(createdAt: string): number {
  return (FIXTURE_NOW.getTime() - new Date(createdAt).getTime()) / 3_600_000;
}

/** "6 days" — reads inside a sentence or under a title. */
export function waitedFor(createdAt: string): string {
  const hours = hoursSince(createdAt);
  if (hours < 1) {
    return "under an hour";
  }
  if (hours < 48) {
    const whole = Math.round(hours);
    return `${whole} ${whole === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/** "6d" — for a table column that has to stay narrow. */
export function waitedForCompact(createdAt: string): string {
  const hours = hoursSince(createdAt);
  if (hours < 48) {
    return `${Math.max(1, Math.round(hours))}h`;
  }
  return `${Math.round(hours / 24)}d`;
}
