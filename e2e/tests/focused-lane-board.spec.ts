import { expect, test, type Page } from "@playwright/test";

/**
 * Browser coverage for the focused-lane board (#6).
 *
 * The owner journey cannot be driven through a real GitHub account here, so
 * this suite answers the session and card requests in the browser instead. The
 * API process is never reached by these routes and no credential is involved:
 * what is under test is the rendered UI at two widths, not the transport, which
 * the API integration suite and the unit suites already cover.
 */

const session = {
  authenticated: true,
  githubUserId: 325861437,
  csrfToken: "browser-qa-csrf-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: "4b2f7c1e-8d3a-4c55-9f21-6a0e1d7b3c48",
    title: "Rebuild the board from last night's snapshot",
    status: "backlog",
    createdAt: new Date(Date.now() - 72 * 3_600_000).toISOString(),
    version: 1,
    ...overrides,
  };
}

const populated = [
  card(),
  card({ id: "a17d9e30-52b4-4f0c-8e6d-11c3f9a24b57", title: "Decide whether a title may wrap" }),
  card({
    id: "7f3c85d2-4a69-4b71-9c08-2e5b1a97d4e3",
    title: "Pick the board presentation",
    status: "doing",
    version: 3,
  }),
  card({
    id: "93a7e604-2b58-41cd-b6f3-0c7d5e8a1f42",
    title: "Serialize the shared PostgreSQL suites",
    status: "done",
    version: 2,
  }),
];

async function signIn(page: Page) {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }),
  );
}

async function serveCards(page: Page, cards: unknown[]) {
  await page.route("**/api/cards", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cards) }),
  );
}

/** No part of the page may extend past the viewport at any width (R-03). */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    widest: Math.max(
      ...Array.from(document.querySelectorAll("body *")).map(
        (element) => element.getBoundingClientRect().right,
      ),
    ),
    viewport: window.innerWidth,
  }));

  expect(overflow.doc).toBeLessThanOrEqual(0);
  expect(overflow.widest).toBeLessThanOrEqual(overflow.viewport);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return Number(((light + 0.05) / (dark + 0.05)).toFixed(2));
}

/** The colors the browser actually resolved, not the ones the stylesheet asked for. */
async function computedColors(page: Page, selector: string) {
  return page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!element) {
      throw new Error(`no element matched ${target}`);
    }
    let backdrop: typeof element | null = element;
    let background = "rgba(0, 0, 0, 0)";
    while (backdrop) {
      const value = window.getComputedStyle(backdrop).backgroundColor;
      if (value !== "rgba(0, 0, 0, 0)" && value !== "transparent") {
        background = value;
        break;
      }
      backdrop = backdrop.parentElement;
    }
    const style = window.getComputedStyle(element);
    return { color: style.color, background, fontSize: style.fontSize };
  }, selector);
}

test.describe("focused lane", () => {
  test("shows one status at a time and navigates between them", async ({ page }) => {
    await signIn(page);
    await serveCards(page, populated);
    await page.setViewportSize(DESKTOP);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Backlog" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Backlog 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("button", { name: "Doing 1" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.getByText("Pick the board presentation")).toHaveCount(0);

    await page.getByRole("button", { name: "Doing 1" }).click();

    await expect(page.getByRole("heading", { name: "Doing" })).toBeVisible();
    await expect(page.getByText("Pick the board presentation")).toBeVisible();
    await expect(page.getByRole("button", { name: "Doing 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      page.getByRole("button", { name: 'Finish: move "Pick the board presentation" to Done' }),
    ).toBeVisible();
  });

  test("keeps every control inside the viewport at 390px and on desktop", async ({ page }) => {
    await signIn(page);
    await serveCards(page, populated);

    await page.setViewportSize(PHONE);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Backlog" })).toBeVisible();
    await expectNoHorizontalScroll(page);

    // The other two statuses have to hold up narrow as well.
    await page.getByRole("button", { name: "Done 1" }).click();
    await expectNoHorizontalScroll(page);

    await page.setViewportSize(DESKTOP);
    await expectNoHorizontalScroll(page);
  });

  test("gives every action a name that says which card and where", async ({ page }) => {
    await signIn(page);
    await serveCards(page, populated);
    await page.setViewportSize(PHONE);
    await page.goto("/");

    await expect(
      page.getByRole("button", {
        name: 'Start: move "Rebuild the board from last night\'s snapshot" to Doing',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: 'Skip to Done: move "Rebuild the board from last night\'s snapshot" to Done',
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: 'Delete "Rebuild the board from last night\'s snapshot"',
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Add a card to Backlog")).toBeVisible();
  });

  test("can be driven from the keyboard with the focus always visible", async ({ page }) => {
    await signIn(page);
    await serveCards(page, populated);
    await page.setViewportSize(PHONE);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Backlog" })).toBeVisible();

    // Source order is visual order: the header, then the status navigation,
    // then the lane itself.
    const order = [
      page.getByRole("button", { name: "Sign out" }),
      page.getByRole("button", { name: "Backlog 2" }),
      page.getByRole("button", { name: "Doing 1" }),
      page.getByRole("button", { name: "Done 1" }),
      page.getByLabel("Add a card to Backlog"),
      page.getByRole("button", {
        name: 'Start: move "Rebuild the board from last night\'s snapshot" to Doing',
      }),
    ];

    for (const control of order) {
      await page.keyboard.press("Tab");
      await expect(control).toBeFocused();

      // A focus ring the user can actually see, on every stop.
      const ring = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element) {
          return null;
        }
        const style = window.getComputedStyle(element);
        return { width: style.outlineWidth, style: style.outlineStyle };
      });
      expect(ring?.style).not.toBe("none");
      expect(Number.parseFloat(ring?.width ?? "0")).toBeGreaterThanOrEqual(2);
    }

    // The status navigation is operable with the keyboard, not only the mouse.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Doing" })).toBeVisible();
  });

  test("meets AA on the text the lane is made of", async ({ page }) => {
    await signIn(page);
    await serveCards(page, populated);
    await page.setViewportSize(DESKTOP);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Backlog" })).toBeVisible();
    // The heading is already there while the board loads, so wait for a card
    // the fixture actually contains before reading any colour off a row.
    await expect(page.getByText("Rebuild the board from last night's snapshot")).toBeVisible();

    const samples = [".lane__heading", ".lane__lead", ".row__title", ".row__meta", ".row__quiet"];
    for (const selector of samples) {
      const { color, background, fontSize } = await computedColors(page, selector);
      const ratio = contrastRatio(color, background);
      const large = Number.parseFloat(fontSize) >= 18;
      expect(ratio, `${selector} ${color} on ${background}`).toBeGreaterThanOrEqual(
        large ? 3 : 4.5,
      );
    }

    // White on the accent fill, which no ancestor background can stand in for.
    const primary = await computedColors(page, ".row__primary");
    expect(contrastRatio(primary.color, primary.background)).toBeGreaterThanOrEqual(4.5);
  });

  test("says the board is loading, then that it is empty and what fills it", async ({ page }) => {
    await signIn(page);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/cards", async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });

    await page.setViewportSize(PHONE);
    await page.goto("/");

    await expect(page.getByRole("status")).toHaveText(/Reading the board/);
    release();

    await expect(
      page.getByText("No cards in Backlog. Add one above and it starts here."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Backlog 0" })).toBeVisible();

    await page.getByRole("button", { name: "Doing 0" }).click();
    await expect(
      page.getByText("Nothing is in Doing. Start a card in Backlog and it moves here."),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("explains a board that did not load and retries on request", async ({ page }) => {
    await signIn(page);
    // Toggled by this test rather than counted per request, so the assertions
    // do not depend on how many times React chooses to run the load effect.
    let reachable = false;
    await page.route("**/api/cards", (route) =>
      reachable
        ? route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(populated),
          })
        : route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "internal_error" }),
          }),
    );

    await page.setViewportSize(PHONE);
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "The board did not load" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Backlog 2" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    reachable = true;
    await page.getByRole("button", { name: "Try again" }).click();

    await expect(page.getByRole("heading", { name: "Backlog" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Backlog 2" })).toBeVisible();
  });

  test("keeps the owner's view and marks the card when a move is refused as stale", async ({
    page,
  }) => {
    await signIn(page);
    await serveCards(page, populated);
    await page.route("**/api/cards/*", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "card_version_conflict",
          card: { ...populated[0], status: "done", version: 9 },
        }),
      }),
    );

    await page.setViewportSize(PHONE);
    await page.goto("/");
    await page
      .getByRole("button", {
        name: 'Start: move "Rebuild the board from last night\'s snapshot" to Doing',
      })
      .click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Rebuild the board from last night's snapshot");
    await expect(alert).toContainText("Done");
    await expect(alert).toContainText(/reload/i);
    // The stale view is preserved: the card is still in Backlog, and the row
    // says so where the owner is looking.
    await expect(page.getByRole("button", { name: "Backlog 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText(/^Changed somewhere else\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Done 1" })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
