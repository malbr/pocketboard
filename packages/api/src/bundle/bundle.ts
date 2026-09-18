import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

/**
 * The API cannot run from `tsc` output: it uses extensionless relative imports
 * (Bundler resolution) and `@pocketboard/shared` ships TypeScript source. The
 * production image therefore runs this bundle with plain `node`.
 *
 * Only the workspace package is inlined. Third-party runtime dependencies stay
 * external and come from `npm ci --omit=dev`, so the image's node_modules is
 * what `npm audit` and Trivy see, and nothing is vendored out of view.
 */
const apiRoot = path.join(import.meta.dirname, "..", "..");

export function runtimeExternals(): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(apiRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  return Object.keys(manifest.dependencies).filter((name) => !name.startsWith("@pocketboard/"));
}

export async function bundleApi(outdir: string): Promise<void> {
  await build({
    absWorkingDir: apiRoot,
    entryPoints: ["src/server.ts", "src/db/migrate.ts"],
    // Keeps db/migrate.js one level down, so its ../../migrations path holds.
    outbase: "src",
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: runtimeExternals().flatMap((name) => [name, `${name}/*`]),
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
}
