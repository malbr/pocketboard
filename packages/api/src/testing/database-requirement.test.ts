import { describe, expect, it } from "vitest";
import { DatabaseUnavailableError, resolveDatabaseAvailability } from "./database-requirement";

// Deliberately independent of `test-database.ts`, which probes a real database
// the moment it is imported. This is the rule, not the probe.
describe("resolveDatabaseAvailability", () => {
  it("reports the database available when the probe succeeded", () => {
    expect(resolveDatabaseAvailability({}, true)).toBe(true);
    expect(resolveDatabaseAvailability({ CI: "true" }, true)).toBe(true);
  });

  it("lets a developer without Docker skip the PostgreSQL suites", () => {
    expect(resolveDatabaseAvailability({}, false)).toBe(false);
  });

  it.each(["true", "1", "TRUE"])(
    "fails loudly rather than silently skipping when CI=%s",
    (value) => {
      expect(() => resolveDatabaseAvailability({ CI: value }, false)).toThrow(
        DatabaseUnavailableError,
      );
    },
  );

  it("names the variable to fix, without quoting the credentials in it", () => {
    let thrown: unknown;
    try {
      resolveDatabaseAvailability(
        { CI: "true", DATABASE_URL: "postgres://user:hunter2@db:5432/pocketboard" },
        false,
      );
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain("DATABASE_URL");
    expect(String(thrown)).not.toContain("hunter2");
  });

  it.each(["", "false", "0"])("treats CI=%s as a local run, not a pipeline", (value) => {
    expect(resolveDatabaseAvailability({ CI: value }, false)).toBe(false);
  });
});
