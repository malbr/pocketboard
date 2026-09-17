import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webBaseUrl = process.env.E2E_WEB_URL ?? "http://127.0.0.1:5173";
const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(e2eDir, "..");

/**
 * The API refuses to start without its owner-auth configuration, so end-to-end
 * runs get throwaway placeholder files. These are not credentials: the browser
 * suite only covers the unauthenticated path and never completes an OAuth
 * exchange. The directory is generated at config load and gitignored.
 */
const secretsDir = path.join(e2eDir, ".tmp-secrets");
fs.mkdirSync(secretsDir, { recursive: true });

function placeholder(name: string, contents: string): string {
  const filePath = path.join(secretsDir, name);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

const authEnv = {
  GITHUB_OAUTH_CLIENT_ID_FILE: placeholder("client-id", "e2e-placeholder-client-id"),
  GITHUB_OAUTH_CLIENT_SECRET_FILE: placeholder("client-secret", "e2e-placeholder-client-secret"),
  SESSION_SECRET_FILE: placeholder("session-secret", "e2e-placeholder-session-secret-32-chars"),
  OWNER_GITHUB_USER_ID_FILE: placeholder("owner-id", "325861437"),
  APP_BASE_URL: webBaseUrl,
};

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
      cwd: repoRoot,
      env: authEnv,
      url: "http://127.0.0.1:3000/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npm run dev --workspace=packages/web",
      cwd: repoRoot,
      url: webBaseUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
