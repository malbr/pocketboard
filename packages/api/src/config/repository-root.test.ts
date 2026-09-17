import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findRepositoryRoot,
  loadRepositoryEnvFile,
  repositoryRoot,
  resolveFromRepositoryRoot,
} from "./repository-root";

let fixtureRoot: string;

beforeEach(() => {
  // realpath: the macOS temporary directory is a symlink, and findRepositoryRoot
  // returns resolved paths.
  fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pocketboard-root-")));
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest), "utf8");
}

describe("findRepositoryRoot", () => {
  it("finds this repository's root from the module that asked for it", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as { name?: string; workspaces?: unknown };

    expect(manifest.name).toBe("pocketboard");
    expect(manifest.workspaces).toBeDefined();
    expect(fs.existsSync(path.join(repositoryRoot, "docker-compose.yml"))).toBe(true);
  });

  it("walks past a workspace package.json that does not declare workspaces", () => {
    writeManifest(fixtureRoot, { name: "root", workspaces: ["packages/*"] });
    const nested = path.join(fixtureRoot, "packages", "api");
    writeManifest(nested, { name: "@fixture/api" });

    expect(findRepositoryRoot(path.join(nested, "src", "config"))).toBe(fixtureRoot);
  });

  it("throws rather than falling back when no workspace root exists above the start", () => {
    // Silently returning the filesystem root would make the API read secrets
    // from wherever `/secrets` happens to point.
    expect(() => findRepositoryRoot(fixtureRoot)).toThrow(/Repository root not found/);
  });
});

describe("resolveFromRepositoryRoot", () => {
  it("anchors a relative path to the repository root, not the working directory", () => {
    expect(resolveFromRepositoryRoot("./secrets/session-secret", fixtureRoot)).toBe(
      path.join(fixtureRoot, "secrets", "session-secret"),
    );
  });

  it("returns an absolute path unchanged, so production secret paths still work", () => {
    const absolute = path.join(fixtureRoot, "etc", "pocketboard", "session-secret");

    expect(resolveFromRepositoryRoot(absolute, path.join(fixtureRoot, "elsewhere"))).toBe(absolute);
  });
});

describe("loadRepositoryEnvFile", () => {
  const OWN_KEY = "POCKETBOARD_ENV_FILE_TEST";
  const PRESET_KEY = "POCKETBOARD_ENV_FILE_TEST_PRESET";

  afterEach(() => {
    delete process.env[OWN_KEY];
    delete process.env[PRESET_KEY];
  });

  it("loads the repository-root .env so workspace scripts see the same values", () => {
    fs.writeFileSync(path.join(fixtureRoot, ".env"), `${OWN_KEY}=from_env_file\n`, "utf8");

    expect(loadRepositoryEnvFile(fixtureRoot)).toBe(true);
    expect(process.env[OWN_KEY]).toBe("from_env_file");
  });

  it("does not overwrite a variable the caller already set", () => {
    // CI and the Playwright harness pass their own database URL and secret
    // paths; a developer's local .env must not win over them.
    process.env[PRESET_KEY] = "from_caller";
    fs.writeFileSync(path.join(fixtureRoot, ".env"), `${PRESET_KEY}=from_env_file\n`, "utf8");

    loadRepositoryEnvFile(fixtureRoot);

    expect(process.env[PRESET_KEY]).toBe("from_caller");
  });

  it("is a no-op when there is no .env, because .env is optional and gitignored", () => {
    expect(loadRepositoryEnvFile(fixtureRoot)).toBe(false);
  });
});
