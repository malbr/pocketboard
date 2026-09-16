import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { registerErrorHandler, serializeErrorForLog } from "./errors";

const LEAK_CANARY = 'insert into "sessions" failed: relation "sessions" does not exist';

/** The shape `@fastify/error` produces: a message plus a `code` and `statusCode`. */
function taggedError(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

interface LogLine {
  level: number;
  msg?: string;
  err?: { message?: string };
}

/**
 * Builds an app whose routes fail the way real ones do — a driver rejection, a
 * plugin's typed error — and captures what the logger actually recorded.
 */
function buildFailingApp(): { app: FastifyInstance; logLines: () => LogLine[] } {
  const lines: string[] = [];
  const app = Fastify({
    logger: {
      level: "error",
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    },
  });

  registerErrorHandler(app);

  app.get("/boom", async () => {
    throw new Error(LEAK_CANARY);
  });

  app.get("/rejected-promise", async () => {
    await Promise.reject(new TypeError(LEAK_CANARY));
  });

  app.get("/gateway", async () => {
    throw taggedError("SOME_UPSTREAM_CODE", LEAK_CANARY, 503);
  });

  app.get("/bad-request", async () => {
    throw taggedError(
      "FST_ERR_CTP_INVALID_JSON_BODY",
      "Body is not valid JSON but content-type is set to 'application/json'",
      400,
    );
  });

  app.get("/handled-domain-failure", async (_request, reply) => {
    return reply.status(400).send({ error: "invalid_card_input" });
  });

  app.get("/csrf-missing-secret", async () => {
    throw taggedError("FST_CSRF_MISSING_SECRET", "Missing csrf secret", 403);
  });

  app.get("/csrf-invalid-token", async () => {
    throw taggedError("FST_CSRF_INVALID_TOKEN", "Invalid csrf token", 403);
  });

  return {
    app,
    logLines: () => lines.map((line) => JSON.parse(line) as LogLine),
  };
}

describe("centralized error handling", () => {
  it.each(["/boom", "/rejected-promise"])(
    "answers %s with a stable generic internal_error",
    async (url) => {
      const { app } = buildFailingApp();

      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "internal_error" });
    },
  );

  it("never echoes the underlying database or framework message to the caller", async () => {
    const { app } = buildFailingApp();

    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.body).not.toContain("sessions");
    expect(response.body).not.toContain("relation");
    expect(JSON.stringify(response.headers)).not.toContain(LEAK_CANARY);
  });

  it("collapses an unexpected 5xx to the same generic body", async () => {
    const { app } = buildFailingApp();

    const response = await app.inject({ method: "GET", url: "/gateway" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_error" });
  });

  it("logs the server error so the detail survives where only the owner can read it", async () => {
    const { app, logLines } = buildFailingApp();

    await app.inject({ method: "GET", url: "/boom" });

    const logged = logLines().filter((line) => line.level >= 50);
    expect(logged).toHaveLength(1);
    expect(logged[0].err?.message).toBe(LEAK_CANARY);
  });

  it("preserves an intended 4xx rather than laundering it into a 500", async () => {
    const { app } = buildFailingApp();

    const response = await app.inject({ method: "GET", url: "/bad-request" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: "Body is not valid JSON but content-type is set to 'application/json'",
    });
  });

  it("does not log a client error as a server failure", async () => {
    const { app, logLines } = buildFailingApp();

    await app.inject({ method: "GET", url: "/bad-request" });

    expect(logLines().filter((line) => line.level >= 50)).toEqual([]);
  });

  it("leaves a domain response the route sent itself untouched", async () => {
    const { app } = buildFailingApp();

    const response = await app.inject({ method: "GET", url: "/handled-domain-failure" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_card_input" });
  });

  it.each(["/csrf-missing-secret", "/csrf-invalid-token"])(
    "maps %s to 403 csrf_token_invalid",
    async (url) => {
      const { app } = buildFailingApp();

      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "csrf_token_invalid" });
    },
  );
});

describe("error log serialization", () => {
  /** What a postgres-js rejection carries when a session write fails. */
  function driverError() {
    return Object.assign(new Error('relation "sessions" does not exist'), {
      name: "PostgresError",
      code: "42P01",
      query: 'insert into "sessions" ("sid", "data", "expires_at") values ($1, $2, $3)',
      parameters: ["sid-1", '{"githubUserId":325861437,"_csrf":"the-csrf-secret"}'],
    });
  }

  it("keeps what identifies the failure", () => {
    const serialized = serializeErrorForLog(driverError());

    expect(serialized).toMatchObject({
      type: "PostgresError",
      message: 'relation "sessions" does not exist',
      code: "42P01",
    });
    expect(serialized.stack).toBeTypeOf("string");
  });

  it("drops the failing statement and the session payload bound to it", () => {
    // The bound parameters of a session write are the session itself: the
    // owner's GitHub id and the CSRF secret. Neither belongs in a log line,
    // even one only the owner can read.
    const serialized = JSON.stringify(serializeErrorForLog(driverError()));

    expect(serialized).not.toContain("the-csrf-secret");
    expect(serialized).not.toContain("325861437");
    expect(serialized).not.toContain("insert into");
  });

  it("survives a thrown value that is not an Error at all", () => {
    expect(serializeErrorForLog("just a string" as unknown as Error)).toMatchObject({
      message: "just a string",
    });
  });
});
