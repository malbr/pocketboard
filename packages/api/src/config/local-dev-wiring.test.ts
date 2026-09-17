import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { repositoryRoot, resolveFromRepositoryRoot } from "./repository-root";

const rootScripts = (
  JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

const composeFile = fs.readFileSync(path.join(repositoryRoot, "docker-compose.yml"), "utf8");
const envExample = fs.readFileSync(path.join(repositoryRoot, ".env.example"), "utf8");

const healthcheckBlock = composeFile.slice(composeFile.indexOf("healthcheck:"));
const healthcheckCommand = /^\s*test:\s*(.+)$/m.exec(healthcheckBlock)?.[1] ?? "";

/** The endpoint migrations actually connect to, as documented for developers. */
const migrationTarget = new URL(
  /^DATABASE_URL=(.+)$/m.exec(envExample)?.[1].trim() ?? "postgres://invalid",
);

describe("npm run dev database startup", () => {
  it("waits for the container instead of returning as soon as it is created", () => {
    // `docker compose up -d` returns while PostgreSQL is still starting, so the
    // very next step — migrations — hit a refused connection on a cold start.
    expect(rootScripts["db:up"]).toMatch(/--wait\b/);
  });

  it("keeps the healthcheck that makes --wait mean 'ready to accept queries'", () => {
    // Without a healthcheck, --wait only waits for "running", which is exactly
    // the state that was already too early.
    expect(composeFile).toContain("healthcheck:");
    expect(healthcheckCommand).toContain("pg_isready");
  });

  it("probes TCP, not the Unix socket the first-run init server also answers on", () => {
    // While it initializes a fresh volume, the postgres entrypoint runs a
    // temporary server with listen_addresses='' — reachable over the Unix
    // socket, unreachable over TCP. A bare `pg_isready -U pocketboard` passes
    // against that temporary server, so --wait returns and migrations still
    // race a port that is not listening. Naming a host forces a TCP probe.
    expect(healthcheckCommand).toMatch(/-h\s+127\.0\.0\.1\b/);
  });

  it("probes the same endpoint and database the migration connects to", () => {
    expect(healthcheckCommand).toMatch(new RegExp(`-p\\s+${migrationTarget.port}\\b`));
    expect(healthcheckCommand).toMatch(
      new RegExp(`-d\\s+${migrationTarget.pathname.replace("/", "")}\\b`),
    );
    // The probe runs on the container's loopback, so it only stands in for the
    // developer's 127.0.0.1 while the published port matches the internal one.
    expect(composeFile).toContain(`"${migrationTarget.port}:${migrationTarget.port}"`);
  });

  it("gives a fresh volume time to initialize before counting probe failures", () => {
    // A TCP probe legitimately fails throughout initdb. Without a start period
    // those failures burn the retry budget and --wait aborts with "unhealthy"
    // on exactly the cold start this is meant to survive.
    expect(healthcheckBlock).toMatch(/start_period:\s*\S+/);
  });

  it("brings the database up before applying migrations", () => {
    const dev = rootScripts.dev;

    expect(dev).toContain("db:up");
    expect(dev.indexOf("db:up")).toBeLessThan(dev.indexOf("db:migrate"));
  });
});

describe("documented secret file paths", () => {
  it("resolve inside the repository, whichever workspace runs the script", () => {
    const example = fs.readFileSync(path.join(repositoryRoot, ".env.example"), "utf8");
    const secretsDir = path.join(repositoryRoot, "secrets");

    const configured = [...example.matchAll(/^([A-Z0-9_]+_FILE)=(.+)$/gm)];
    expect(configured.length).toBe(4);

    for (const [, variable, value] of configured) {
      expect(resolveFromRepositoryRoot(value.trim()), variable).toBe(
        path.join(secretsDir, path.basename(value.trim())),
      );
    }
  });
});
