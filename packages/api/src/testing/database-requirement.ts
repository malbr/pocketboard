/**
 * Decides whether an unreachable database is a local convenience or a broken
 * pipeline.
 *
 * Skipping locally keeps `npm test` useful without Docker. Skipping in CI is a
 * different thing entirely: the owner-only authorization, session expiry, and
 * CSRF suites are exactly the ones that need real PostgreSQL, and a green run
 * that quietly ran none of them is worse than a red one.
 */
export class DatabaseUnavailableError extends Error {
  constructor() {
    // The connection string carries a password, so the message names the
    // variable to fix rather than echoing its value.
    super(
      "No PostgreSQL reachable at DATABASE_URL, but CI is set. " +
        "The PostgreSQL-backed suites must not be skipped in a pipeline.",
    );
    this.name = "DatabaseUnavailableError";
  }
}

type Env = Record<string, string | undefined>;

function isPipeline(env: Env): boolean {
  const ci = env.CI?.trim().toLowerCase();
  return ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";
}

export function resolveDatabaseAvailability(env: Env, probeSucceeded: boolean): boolean {
  if (probeSucceeded) {
    return true;
  }
  if (isPipeline(env)) {
    throw new DatabaseUnavailableError();
  }
  return false;
}
