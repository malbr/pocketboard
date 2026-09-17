import { expect, test } from "@playwright/test";

/**
 * The create-and-list journey is now owner-only. A browser without a session
 * cannot reach it, which is all this suite can assert without a real GitHub
 * account; the authenticated journey is covered by the API integration suite
 * with the injected fake OAuth adapter.
 */

test("listing cards requires a session", async ({ page }) => {
  const response = await page.request.get("/api/cards", { failOnStatusCode: false });

  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "authentication_required" });
});

test("creating a card requires a session", async ({ page }) => {
  const response = await page.request.post("/api/cards", {
    data: { title: `E2E card ${Date.now()}` },
    failOnStatusCode: false,
  });

  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "authentication_required" });
});

test("moving a card requires a session", async ({ page }) => {
  const response = await page.request.patch("/api/cards/3fa85f64-5717-4562-b3fc-2c963f66afa6", {
    data: { status: "doing", version: 1 },
    failOnStatusCode: false,
  });

  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "authentication_required" });
});

test("a signed-out visitor is never shown the card form", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  await expect(page.getByLabel("New card title")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add card" })).toHaveCount(0);
});
