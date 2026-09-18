# PocketBoard

See `CONTEXT.md` for product and architecture context, and `AGENTS.md` for
agent operating rules.

For the current access status, local usage, and the small set of Orca/GitHub
signals the human owner should monitor, see `docs/operator-guide.md`.

## Local development

Requirements: Node.js 24+, npm 11+, Docker (for local PostgreSQL only).

Copy `.env.example` to `.env` if you need to override defaults (the API and
web app already default to the values below).

`.env` lives at the repository root and is read from there by the API and by
the migration runner, both of which npm starts inside `packages/api`. Relative
paths in it — including the four secret-file paths — resolve from the
repository root too, so `./secrets/session-secret` means the same file whether
you run `npm run dev` at the root or `npm run db:migrate --workspace=packages/api`
from anywhere. Variables already set in your shell win over `.env`.

### Owner authentication

The API is owner-only and **will not start without its auth configuration**.
`.env.example` documents the four required variables; each one holds a *file
path*, not a value, so secrets stay out of the environment and this repository.
Follow the commands in `.env.example` to create throwaway local files, then
register a GitHub OAuth app with homepage `http://127.0.0.1:5173` and callback
URL `http://127.0.0.1:5173/api/auth/github/callback`.

Use `127.0.0.1`, not `localhost`. GitHub matches the callback URL exactly, so
the two spellings are not interchangeable even though they resolve to the same
address. Every local default in this repository uses `127.0.0.1` for that
reason.

Requesting no scopes is deliberate — PocketBoard uses GitHub for identity only.
See `docs/adr/0001-owner-only-github-oauth-sessions.md` for the full design and
threat boundary.

### Behind a reverse proxy

In production the session cookie is `Secure`, so it is only issued over a
connection the API can see as TLS. When a reverse proxy terminates TLS, set
`TRUSTED_PROXY_IPS` to that proxy's address or network (or to `none` if the API
terminates TLS itself). The API refuses to start in production until this is
stated, because the alternative failure is silent: login would redirect
successfully and set no cookie.

Only the listed peers' `X-Forwarded-*` headers are believed. Blanket values —
`true`, `*`, a hop count, a hostname, any `/0` network — are rejected at
startup.

### Rate limits

Each client gets 10 requests a minute on `/auth/github` and
`/auth/github/callback`, and 300 a minute on every other route. `/health` is
never limited. A client over budget receives `429` with
`{"error":"rate_limited"}` and a `Retry-After` header. The values live in
`packages/api/src/rate-limit.ts`, and counters are in memory, so they reset
when the API restarts.

The client is identified by the address Fastify resolves, so the limits rely on
`TRUSTED_PROXY_IPS`. If it does not name the proxy in front of the API, every
visitor appears as the proxy and shares one budget.

Start everything with one command:

```sh
npm install
npm run dev
```

`npm run dev` starts a local PostgreSQL container, waits for it to report
healthy, applies Drizzle migrations, then runs the API (http://127.0.0.1:3000)
and the web app (http://127.0.0.1:5173) together.

The wait is the point: `docker compose up -d` returns while PostgreSQL is still
starting, so on a cold start the migration step used to fail with a refused
connection. `npm run db:up` passes `--wait`, which blocks on the container's
healthcheck and gives up after 60 seconds with a clear error. That healthcheck
probes PostgreSQL over TCP at the same host, port, and database the migration
uses — not over the Unix socket, which the entrypoint's temporary
initialization server answers on while the published port is still closed.

## Checks

```sh
npm run lint
npm run typecheck
npm run test        # unit tests always run; PostgreSQL-backed API tests
                     # auto-skip if DATABASE_URL is unreachable
npm run build
npm run e2e          # requires Playwright's Chromium browser:
                     # npx playwright install --with-deps chromium
```

`npm run test` runs real-PostgreSQL integration tests for the API when a
database is reachable at `DATABASE_URL` (default:
`postgres://pocketboard:pocketboard@127.0.0.1:5432/pocketboard`); otherwise
those tests are skipped and reported as such. That skip is a local convenience
only: when `CI` is set, an unreachable database fails those suites instead, so a
pipeline can never report green after quietly running none of the
authorization, expiry, and CSRF cases. GitHub Actions runs them against an
ephemeral PostgreSQL service, alongside one Chromium end-to-end test.

## The board

The board shows **one status at a time**. A row of buttons above the heading
names Backlog, Doing, and Done with their current counts; the selected one
carries `aria-pressed` and fills with the accent colour, and choosing another
replaces the page below it. Nothing about the board is hidden behind a hover.

Each card leads with the step that follows from where it already is: **Start**
in Backlog, **Finish** in Doing, **Reopen** in Done. The other destination and
**Delete** stay quiet but keep names that say which card moves and where, so
rows that all read "Start" stay distinguishable to a screen reader or to voice
control. New cards always go into Backlog, whichever status is on screen, and
the board switches to Backlog so the new card is visible.

Everything is reachable with the keyboard alone, in the order the page reads:
sign out, the three status buttons, the title field, **Add card**, then each
row's actions. Every stop draws a 3px focus ring. Deleting still asks for
confirmation by name in the browser's own dialog.

The board states each say what happened and what to do next: reading the board,
a load failure with **Try again**, an empty status naming what fills it, a
failed change, and a change refused as stale. A refused change never repaints
the board: the card stays where the owner last read it, the row says it was
changed somewhere else, and the message names the reload that catches up.

See `docs/adr/0003-focused-lane-board-ui.md` for the decision and the human
selection it came from.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/auth/github` | Starts the GitHub authorization-code flow (state + PKCE S256) |
| `GET /api/auth/github/callback` | Completes the exchange, checks the owner id, starts a session |
| `GET /api/auth/session` | Returns the current owner session and a CSRF token |
| `POST /api/auth/logout` | Destroys the session (requires a CSRF token) |
| `GET /api/cards`, `POST /api/cards` | Owner-only; `POST` requires a CSRF token |
| `PATCH /api/cards/:cardId` | Owner-only; moves a card between columns (requires a CSRF token) |
| `DELETE /api/cards/:cardId` | Owner-only; deletes a card (requires a CSRF token) |

Protected routes answer `401 authentication_required` without a usable session
and `403 access_denied` for a session that is not the owner's. Mutations send
the CSRF token from `GET /api/auth/session` in an `X-CSRF-Token` header; a
missing or mismatched token is `403 csrf_token_invalid`.

### Moving a card

Every card carries an integer `version` — its concurrency token. A move sends
the column it should end up in and the version it is based on:

```http
PATCH /api/cards/3fa85f64-5717-4562-b3fc-2c963f66afa6
Content-Type: application/json
X-CSRF-Token: <token from GET /api/auth/session>

{ "status": "doing", "version": 1 }
```

| Response | Meaning |
| --- | --- |
| `200` + the card | Moved; the card comes back with its incremented `version` |
| `400 invalid_card_input` | Malformed id, unknown column, or a missing/invalid token |
| `404 card_not_found` | No such card |
| `409 card_version_conflict` | The card changed since `version`; the body carries the card as it now stands |

The version check happens inside the `UPDATE`, so a stale move never overwrites
a newer one. The browser keeps the board it was showing and explains that a
reload is needed. See
`docs/adr/0002-card-move-optimistic-concurrency.md`.

### Deleting a card

A delete carries the same concurrency token and nothing else, so a card that
changed since the browser read it cannot be removed by a request that never saw
the change:

```http
DELETE /api/cards/3fa85f64-5717-4562-b3fc-2c963f66afa6
Content-Type: application/json
X-CSRF-Token: <token from GET /api/auth/session>

{ "version": 1 }
```

| Response | Meaning |
| --- | --- |
| `200` + the card | Deleted; the body is the card as it stood at the version that was removed |
| `400 invalid_card_input` | Malformed id, or a missing/invalid token |
| `404 card_not_found` | No such card — including a card already deleted |
| `409 card_version_conflict` | The card changed since `version`; the body carries the card as it now stands |

The version check is part of the `DELETE ... RETURNING`, so the row is removed
only if it is still the row the caller saw, and the returned row is the only
record of the card left — every card mutation answers with the version it acted
on, as `docs/adr/0002-card-move-optimistic-concurrency.md` requires. In the
browser, deleting asks for
confirmation by name first; a refused delete leaves the board untouched and says
that a reload is needed, because the rest of the board is exactly as old as the
card that turned out to be stale or already gone.

The shared Zod schemas in `packages/shared` are the authoritative transport
contract; this table documents the same shapes by hand. There is no generated
OpenAPI artifact in the repository yet — #7 owns generating one and enforcing
drift against it.

Any failure the API did not anticipate answers `500 {"error":"internal_error"}`.
The underlying message goes to the server log, never to the caller.

`GET /health` stays unauthenticated so deployment health checks keep working.

## Scope of this slice

Create cards, list them, move them among Backlog, Doing, and Done, and delete
them deliberately — all without losing a concurrent change, and all restricted
to the owner's GitHub account. There is no production deployment in this slice.
