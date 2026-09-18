import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  authErrorSchema,
  cardIdParamsSchema,
  cardListSchema,
  cardNotFoundSchema,
  cardSchema,
  cardVersionConflictSchema,
  CardErrorCode,
  createCardInputSchema,
  deleteCardInputSchema,
  internalErrorSchema,
  moveCardInputSchema,
  sessionSchema,
} from "@pocketboard/shared";

/**
 * The API's published contract, generated from the shared Zod schemas the
 * routes validate with. `openapi.test.ts` proves this route table matches what
 * Fastify registers, and `npm run openapi:check` fails CI when the committed
 * `openapi.json` differs from this output.
 *
 * Only the generator and its tests import this module; the running API never
 * does, so the Zod extension below never touches production code paths.
 */
extendZodWithOpenApi(z);

/** Mirrors `invalidCardInput` in routes/cards.ts. */
const invalidCardInputSchema = z
  .object({
    error: z.literal(CardErrorCode.InvalidCardInput),
    issues: z.array(
      z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }).strict(),
    ),
  })
  .strict();

const healthSchema = z.object({ status: z.literal("ok") }).strict();

const csrfHeader = z.object({
  "x-csrf-token": z.string().openapi({ description: "Token from GET /auth/session" }),
});

function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  const session = registry.registerComponent("securitySchemes", "ownerSession", {
    type: "apiKey",
    in: "cookie",
    name: "pocketboard.sid",
    description: "Session cookie issued after the owner signs in with GitHub.",
  });
  const owner = [{ [session.name]: [] }];

  const Card = registry.register("Card", cardSchema);
  const CardList = registry.register("CardList", cardListSchema);
  const Session = registry.register("Session", sessionSchema);
  const AuthError = registry.register("AuthError", authErrorSchema);
  const InternalError = registry.register("InternalError", internalErrorSchema);
  const InvalidCardInput = registry.register("InvalidCardInput", invalidCardInputSchema);
  const CardNotFound = registry.register("CardNotFound", cardNotFoundSchema);
  const CardVersionConflict = registry.register("CardVersionConflict", cardVersionConflictSchema);
  const Health = registry.register("Health", healthSchema);

  const json = (schema: z.ZodTypeAny, description: string) => ({
    description,
    content: { "application/json": { schema } },
  });
  const internal = { 500: json(InternalError, "Unexpected failure; no internal detail is returned") };
  const ownerOnly = {
    401: json(AuthError, "Not signed in"),
    403: json(AuthError, "Signed in as someone other than the owner, or CSRF token invalid"),
  };
  const versionedCardResponses = (success: string) => ({
    200: json(Card, success),
    400: json(InvalidCardInput, "Invalid identifier or input"),
    ...ownerOnly,
    404: json(CardNotFound, "No such card"),
    409: json(CardVersionConflict, "Stale version; the current card is returned"),
    ...internal,
  });

  const routes: RouteConfig[] = [
    {
      method: "get",
      path: "/health",
      summary: "Liveness check",
      responses: { 200: json(Health, "API is up"), ...internal },
    },
    {
      method: "get",
      path: "/auth/github",
      summary: "Start GitHub sign-in",
      responses: { 302: { description: "Redirect to GitHub authorization" }, ...internal },
    },
    {
      method: "get",
      path: "/auth/github/callback",
      summary: "Complete GitHub sign-in",
      responses: {
        302: { description: "Signed in; redirect to the app" },
        400: json(AuthError, "OAuth state did not match"),
        403: json(AuthError, "The GitHub account is not the owner"),
        502: json(AuthError, "GitHub code exchange failed"),
        ...internal,
      },
    },
    {
      method: "get",
      path: "/auth/session",
      summary: "Current owner session and CSRF token",
      security: owner,
      responses: { 200: json(Session, "Signed in as the owner"), ...ownerOnly, ...internal },
    },
    {
      method: "post",
      path: "/auth/logout",
      summary: "Sign out",
      security: owner,
      request: { headers: csrfHeader },
      responses: { 204: { description: "Session destroyed" }, ...ownerOnly, ...internal },
    },
    {
      method: "get",
      path: "/cards",
      summary: "List cards, newest first",
      security: owner,
      responses: { 200: json(CardList, "All cards"), ...ownerOnly, ...internal },
    },
    {
      method: "post",
      path: "/cards",
      summary: "Create a card",
      security: owner,
      request: {
        headers: csrfHeader,
        body: { required: true, content: { "application/json": { schema: createCardInputSchema } } },
      },
      responses: {
        201: json(Card, "Created"),
        400: json(InvalidCardInput, "Invalid input"),
        ...ownerOnly,
        ...internal,
      },
    },
    {
      method: "patch",
      path: "/cards/{cardId}",
      summary: "Move a card, guarded by its version",
      security: owner,
      request: {
        params: cardIdParamsSchema,
        headers: csrfHeader,
        body: { required: true, content: { "application/json": { schema: moveCardInputSchema } } },
      },
      responses: versionedCardResponses("Moved"),
    },
    {
      method: "delete",
      path: "/cards/{cardId}",
      summary: "Delete a card, guarded by its version",
      security: owner,
      request: {
        params: cardIdParamsSchema,
        headers: csrfHeader,
        body: { required: true, content: { "application/json": { schema: deleteCardInputSchema } } },
      },
      responses: versionedCardResponses("Deleted; the card as it stood when removed"),
    },
  ];

  for (const route of routes) registry.registerPath(route);
  return registry;
}

export function generateOpenApiDocument() {
  return new OpenApiGeneratorV3(buildRegistry().definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "PocketBoard API",
      version: "0.0.0",
      description: "Owner-only REST API. The web app reaches it under /api.",
    },
    servers: [{ url: "/api" }],
  });
}

/** Fastify-style `METHOD /path/:param` keys, for comparison with registered routes. */
export function documentedRoutes(): string[] {
  return buildRegistry()
    .definitions.flatMap((definition) => (definition.type === "route" ? [definition.route] : []))
    .map((route) => `${route.method.toUpperCase()} ${route.path.replace(/\{(\w+)\}/g, ":$1")}`);
}

export function renderOpenApiDocument(): string {
  return `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;
}
