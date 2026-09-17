import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The same API code is started from at least three working directories: the
 * repository root (`npm run dev`), `packages/api` (every `--workspace` script,
 * including migrations), and wherever a developer happens to be standing.
 * Anything named relatively — the `.env` file and the secret files it points
 * at — therefore has to resolve against the repository, not the caller's cwd.
 * Otherwise the documented `./secrets/session-secret` becomes
 * `packages/api/secrets/session-secret` and the API refuses to start.
 */

/** The root manifest is the only one in the tree that declares workspaces. */
function declaresWorkspaces(dir: string): boolean {
  let manifest: { workspaces?: unknown };
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      workspaces?: unknown;
    };
  } catch {
    return false;
  }
  return manifest.workspaces !== undefined;
}

export function findRepositoryRoot(startDir: string): string {
  let current = path.resolve(startDir);

  for (;;) {
    if (declaresWorkspaces(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      // Falling back to cwd or to the filesystem root would send the secret
      // reader somewhere arbitrary, so this fails loudly instead.
      throw new Error(`Repository root not found above ${startDir}`);
    }
    current = parent;
  }
}

/** Resolved once from this module's own location, so it never depends on cwd. */
export const repositoryRoot = findRepositoryRoot(path.dirname(fileURLToPath(import.meta.url)));

export function resolveFromRepositoryRoot(filePath: string, root = repositoryRoot): string {
  // Absolute paths pass through untouched: production names root-owned files
  // outside the repository.
  return path.resolve(root, filePath);
}

/**
 * Loads the repository-root `.env`, which is optional and gitignored. Node
 * lets an already-set environment variable win over the file, so CI and the
 * Playwright harness keep the values they pass in.
 *
 * Returns whether a file was found, for callers that want to say so.
 */
export function loadRepositoryEnvFile(root = repositoryRoot): boolean {
  const envFile = path.join(root, ".env");
  if (!fs.existsSync(envFile)) {
    return false;
  }

  process.loadEnvFile(envFile);
  return true;
}
