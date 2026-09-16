import { ApiErrorCode, AuthErrorCode } from "@pocketboard/shared";
import type { FastifyError, FastifyInstance } from "fastify";

/**
 * The typed errors `@fastify/csrf-protection` throws. Left to Fastify's default
 * serialization they answer `{"error":"Forbidden","message":"Invalid csrf
 * token"}`, which names the plugin and gives the frontend nothing stable to
 * branch on.
 */
const CSRF_ERROR_CODES = new Set(["FST_CSRF_MISSING_SECRET", "FST_CSRF_INVALID_TOKEN"]);

/** Matches the shape pino's `err` serializer slot expects. */
export interface LoggedError {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
  code?: string;
}

/**
 * The pino `err` serializer for this API.
 *
 * pino's default serializer copies an error's own enumerable properties, and
 * postgres-js hangs the failing statement and its bound parameters off the
 * error. For a session write those parameters are the session payload — the
 * owner's GitHub id and the CSRF secret — so the default would write them into
 * the log. This keeps only what identifies the failure.
 */
export function serializeErrorForLog(error: Error): LoggedError {
  if (!(error instanceof Error)) {
    return { type: "NonError", message: String(error), stack: "" };
  }

  const code = (error as { code?: unknown }).code;
  return {
    type: error.name,
    message: error.message,
    code: typeof code === "string" ? code : undefined,
    stack: error.stack ?? "",
  };
}

/**
 * One place decides what a thrown error becomes on the wire.
 *
 * A failure the application did not anticipate — a driver rejection, a bug —
 * carries the database's own words in its message. Those belong in the server
 * log, which only the owner can read, never in a response body where they
 * describe the schema to whoever provoked the error.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.code && CSRF_ERROR_CODES.has(error.code)) {
      return reply.status(403).send({ error: AuthErrorCode.CsrfTokenInvalid });
    }

    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      // A deliberate client error: malformed JSON, a failed schema check. Its
      // message describes the caller's own request, so it stays as Fastify
      // wrote it.
      return reply.status(statusCode).send(error);
    }

    request.log.error({ err: error }, "unhandled server error");
    return reply.status(500).send({ error: ApiErrorCode.InternalError });
  });
}
