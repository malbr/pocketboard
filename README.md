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

## API

| Route | Purpose |
| --- | --- |
| `GET /api/auth/github` | Starts the GitHub authorization-code flow (state + PKCE S256) |
| `GET /api/auth/github/callback` | Completes the exchange, checks the owner id, starts a session |
| `GET /api/auth/session` | Returns the current owner session and a CSRF token |
| `POST /api/auth/logout` | Destroys the session (requires a CSRF token) |
| `GET /api/cards`, `POST /api/cards` | Owner-only; `POST` requires a CSRF token |

Protected routes answer `401 authentication_required` without a usable session
and `403 access_denied` for a session that is not the owner's. Mutations send
the CSRF token from `GET /api/auth/session` in an `X-CSRF-Token` header; a
missing or mismatched token is `403 csrf_token_invalid`.

Any failure the API did not anticipate answers `500 {"error":"internal_error"}`.
The underlying message goes to the server log, never to the caller.

`GET /health` stays unauthenticated so deployment health checks keep working.

## Scope of this slice

Create and list Backlog cards, restricted to the owner's GitHub account. There
is no production deployment in this slice.
