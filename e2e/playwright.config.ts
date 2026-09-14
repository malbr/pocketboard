import { defineConfig, devices } from "@playwright/test";

const webBaseUrl = process.env.E2E_WEB_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: webBaseUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "npm run start --workspace=packages/api",
      url: "http://localhost:3000/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npm run dev --workspace=packages/web",
      url: webBaseUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
