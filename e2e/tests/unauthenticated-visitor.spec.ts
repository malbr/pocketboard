import { expect, test } from "@playwright/test";

/**
 * Browser coverage is deliberately limited to the unauthenticated path: it is
 * the only journey that can be driven end to end without a real GitHub
 * account. Owner, wrong-user, rotation, expiry, and CSRF behaviour are covered
 * by the API integration suite with the injected fake OAuth adapter.
 */

test("an unauthenticated visitor is asked to sign in and sees no board", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Backlog" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Doing" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Done" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Board status" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("the sign-in link points at the API's GitHub authorization route", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
    "href",
    "/api/auth/github",
  );
});

test("the session endpoint reports no session for a fresh browser", async ({ page }) => {
  const response = await page.request.get("/api/auth/session", { failOnStatusCode: false });

  expect(response.status()).toBe(401);
  expect(await response.json()).toEqual({ error: "authentication_required" });
});
