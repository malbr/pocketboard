import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 5 narrowed its default `exclude` to just node_modules/.git,
    // dropping the old **/dist/** entry. Without this, a leftover local
    // `npm run build` output under `dist/` gets picked up and run as tests.
    exclude: [...configDefaults.exclude, "**/dist/**"],
    /**
     * API test files run one at a time.
     *
     * Three suites — `routes/auth.test.ts`, `routes/cards.test.ts`, and
     * `auth/session-store.test.ts` — talk to the same PostgreSQL database and
     * each calls `truncate table sessions` / `truncate table cards` in
     * `beforeEach`. Vitest's default is to run test files in parallel, so one
     * file's truncate lands in the middle of another file's test: sessions
     * vanish under a signed-in helper, and row counts pick up the other file's
     * rows. That is a shared-fixture problem, not a flaky-timing one, so it
     * cannot be waited out.
     *
     * A POC has one ephemeral database and a suite that finishes in seconds, so
     * serializing is the honest fix. Per-suite schemas or a database per worker
     * would buy parallelism this project has no use for.
     */
    fileParallelism: false,
  },
});
