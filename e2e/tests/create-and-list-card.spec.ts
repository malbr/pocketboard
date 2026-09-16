import { expect, test } from "@playwright/test";

test("a user creates a Backlog card and sees it immediately", async ({ page }) => {
  const title = `E2E card ${Date.now()}`;

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Backlog" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Doing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Done" })).toBeVisible();

  await page.getByLabel("New card title").fill(title);
  await page.getByRole("button", { name: "Add card" }).click();

  const backlogColumn = page.getByTestId("column-backlog");
  await expect(backlogColumn.getByText(title)).toBeVisible();
});
