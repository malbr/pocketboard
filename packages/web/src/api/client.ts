import {
  cardListSchema,
  cardSchema,
  cardVersionConflictSchema,
  sessionSchema,
  type Card,
  type CardStatus,
  type Session,
} from "@pocketboard/shared";

const baseUrl = import.meta.env.VITE_API_URL ?? "/api";

/** Thrown when the API says the session is gone, so the UI can re-prompt. */
export class AuthRequiredError extends Error {
  constructor() {
    super("authentication_required");
    this.name = "AuthRequiredError";
  }
}

/**
 * Thrown when the API refused a move because the browser was working from a
 * card it had already outgrown. It carries the card as the API now holds it, so
 * the UI can say what changed rather than only that something did.
 */
export class CardVersionConflictError extends Error {
  constructor(readonly card: Card) {
    super("card_version_conflict");
    this.name = "CardVersionConflictError";
  }
}

export type SessionState =
  | { status: "authenticated"; session: Session }
  | { status: "unauthenticated" }
  | { status: "denied" };

export const signInUrl = `${baseUrl}/auth/github`;

export async function fetchSession(): Promise<SessionState> {
  const response = await fetch(`${baseUrl}/auth/session`, { credentials: "same-origin" });

  if (response.status === 401) {
    return { status: "unauthenticated" };
  }
  if (response.status === 403) {
    return { status: "denied" };
  }
  if (!response.ok) {
    throw new Error("Failed to load session");
  }

  const result = sessionSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Failed to load session");
  }
  return { status: "authenticated", session: result.data };
}

export async function logout(csrfToken: string): Promise<void> {
  const response = await fetch(`${baseUrl}/auth/logout`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "X-CSRF-Token": csrfToken },
  });

  if (!response.ok) {
    throw new Error("Failed to sign out");
  }
}

export async function fetchCards(): Promise<Card[]> {
  const response = await fetch(`${baseUrl}/cards`, { credentials: "same-origin" });
  if (response.status === 401) {
    throw new AuthRequiredError();
  }
  if (!response.ok) {
    throw new Error("Failed to load cards");
  }
  const body = await response.json();
  const result = cardListSchema.safeParse(body);
  if (!result.success) {
    throw new Error("Failed to load cards");
  }
  return result.data;
}

export async function moveCard(
  cardId: string,
  status: CardStatus,
  version: number,
  csrfToken: string,
): Promise<Card> {
  const response = await fetch(`${baseUrl}/cards/${cardId}`, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ status, version }),
  });

  if (response.status === 401) {
    throw new AuthRequiredError();
  }

  if (response.status === 409) {
    const conflict = cardVersionConflictSchema.safeParse(await response.json());
    if (!conflict.success) {
      throw new Error("Failed to move card");
    }
    throw new CardVersionConflictError(conflict.data.card);
  }

  if (!response.ok) {
    throw new Error("Failed to move card");
  }

  const result = cardSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error("Failed to move card");
  }
  return result.data;
}

export async function createCard(title: string, csrfToken: string): Promise<Card> {
  const response = await fetch(`${baseUrl}/cards`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    body: JSON.stringify({ title }),
  });

  if (response.status === 401) {
    throw new AuthRequiredError();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "unknown_error" }));
    throw new Error(typeof body.error === "string" ? body.error : "Failed to create card");
  }

  const body = await response.json();
  const result = cardSchema.safeParse(body);
  if (!result.success) {
    throw new Error("Failed to create card");
  }
  return result.data;
}
