import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleApi, runtimeExternals } from "./bundle";

const apiManifest = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
) as { dependencies: Record<string, string> };

/** Every bare module specifier a bundled file still imports at runtime. */
function bareImports(source: string): string[] {
  const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"'./][^"']*)["']/g)].map(
    (match) => match[1],
  );
  return [...new Set(specifiers)];
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

describe("API production bundle", () => {
  let outdir: string;

  beforeAll(async () => {
    outdir = fs.mkdtempSync(path.join(os.tmpdir(), "api-bundle-"));
    await bundleApi(outdir);
  }, 60_000);

  afterAll(() => {
    fs.rmSync(outdir, { recursive: true, force: true });
  });

  it("emits the server and the migration runner at their source-relative paths", () => {
    // migrate.js resolves ../../migrations from its own location, so it has to
    // stay one directory below the bundle root, exactly as in src/.
    expect(fs.existsSync(path.join(outdir, "server.js"))).toBe(true);
    expect(fs.existsSync(path.join(outdir, "db", "migrate.js"))).toBe(true);
  });

  it("inlines the shared contracts, which ship as TypeScript source", () => {
    const server = fs.readFileSync(path.join(outdir, "server.js"), "utf8");
    expect(bareImports(server)).not.toContain("@pocketboard/shared");
  });

  it("imports only node built-ins and declared runtime dependencies", () => {
    const declared = new Set(Object.keys(apiManifest.dependencies));
    for (const file of ["server.js", path.join("db", "migrate.js")]) {
      const source = fs.readFileSync(path.join(outdir, file), "utf8");
      for (const specifier of bareImports(source)) {
        if (specifier.startsWith("node:")) continue;
        expect(declared, `${file} imports ${specifier}`).toContain(packageName(specifier));
      }
    }
  });

  it("never externalises the workspace package or a dev dependency", () => {
    expect(runtimeExternals()).not.toContain("@pocketboard/shared");
    expect(runtimeExternals()).not.toContain("esbuild");
    expect(runtimeExternals()).toContain("fastify");
  });
});
