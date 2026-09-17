// THROWAWAY PROTOTYPE — the contract every variant is handed.
// Delete with the rest of src/prototype/.

import type { Card, CardStatus } from "@pocketboard/shared";
import type { BoardSnapshot } from "./fixtures";

/**
 * Data and stubs are shared; layout is not. Each variant is free to throw the
 * whole structure away, which is the only reason the comparison is worth
 * anything.
 */
export interface VariantProps {
  snapshot: BoardSnapshot;
  onMove: (card: Card, status: CardStatus) => void;
  onDelete: (card: Card) => void;
  onCreate: (title: string) => void;
  onRetry: () => void;
}
