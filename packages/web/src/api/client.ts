import type { Card } from "@pocketboard/shared";

const baseUrl = import.meta.env.VITE_API_URL ?? "/api";

export async function fetchCards(): Promise<Card[]> {
  const response = await fetch(`${baseUrl}/cards`);
  if (!response.ok) {
    throw new Error("Failed to load cards");
  }
  return response.json();
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

  return response.json();
}
