import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthConfigError } from "./config/auth-config";
import { createProductionApp } from "./composition-root";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function productionSourceFiles(dir: string, collected: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // `testing/` holds deliberately test-only doubles.
      if (entry.name === "testing") continue;
      productionSourceFiles(full, collected);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      collected.push(full);
    }
  }
  return collected;
}

describe("production wiring", () => {
  it("never imports a test double from a production module", () => {
    const offenders = productionSourceFiles(srcDir).filter((file) => {
      const contents = fs.readFileSync(file, "utf8");
      return /from\s+["'][^"']*(testing\/|fake-)/.test(contents);
    });

    expect(offenders).toEqual([]);
  });

  it("wires the real GitHub adapter, with no bypass switch", () => {
    const contents = fs.readFileSync(path.join(srcDir, "composition-root.ts"), "utf8");

    expect(contents).toContain("createGitHubOAuthProvider");
    // Guards against a future "skip auth in dev" shortcut being added here.
    expect(contents).not.toMatch(/DISABLE_AUTH|SKIP_AUTH|AUTH_BYPASS|NODE_ENV\s*===\s*["']test/);
  });

  it("refuses to build an app when the auth configuration is missing", async () => {
    await expect(createProductionApp({ DATABASE_URL: "postgres://unused" })).rejects.toBeInstanceOf(
      AuthConfigError,
    );
  });

  it("refuses to build an app when a secret file is unreadable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pocketboard-composition-"));
    try {
      await expect(
        createProductionApp({
          DATABASE_URL: "postgres://unused",
          GITHUB_OAUTH_CLIENT_ID_FILE: path.join(dir, "missing-client-id"),
          GITHUB_OAUTH_CLIENT_SECRET_FILE: path.join(dir, "missing-client-secret"),
          SESSION_SECRET_FILE: path.join(dir, "missing-session-secret"),
          OWNER_GITHUB_USER_ID_FILE: path.join(dir, "missing-owner-id"),
        }),
      ).rejects.toMatchObject({ code: "unreadable_secret_file" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
