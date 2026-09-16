import { cardListSchema, cardSchema, type Card } from "@pocketboard/shared";

const baseUrl = import.meta.env.VITE_API_URL ?? "/api";

export async function fetchCards(): Promise<Card[]> {
  const response = await fetch(`${baseUrl}/cards`);
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

export async function createCard(title: string): Promise<Card> {
  const response = await fetch(`${baseUrl}/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });

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
