# PocketBoard

See `CONTEXT.md` for product and architecture context, and `AGENTS.md` for
agent operating rules.

## Local development

Requirements: Node.js 24+, npm 11+, Docker (for local PostgreSQL only).

Copy `.env.example` to `.env` if you need to override defaults (the API and
web app already default to the values below).

Start everything with one command:

```sh
npm install
npm run dev
```

`npm run dev` starts a local PostgreSQL container (`docker compose up -d
postgres`), applies Drizzle migrations, then runs the API (http://localhost:3000)
and the web app (http://localhost:5173) together.

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
`postgres://pocketboard:pocketboard@localhost:5432/pocketboard`); otherwise
those tests are skipped and reported as such. GitHub Actions always runs them
against an ephemeral PostgreSQL service, alongside one Chromium end-to-end
test.

## Scope of this slice

This is the first runnable tracer bullet: create and list Backlog cards only.
There is no authentication and no production deployment in this slice.
