# PocketBoard project context

## Purpose

PocketBoard is a small, non-critical proof-of-concept web application used to
exercise an AI-assisted SDLC safely. It contains no customer data or payments.
The repository will be public, owned by GitHub user `malbr`, with no license in
the initial POC.

## Product and architecture

- npm-workspaces monorepo: React/Vite frontend, Fastify API, PostgreSQL,
  Drizzle migrations, and shared Zod transport contracts.
- REST vertical slices in a modular monolith; no distributed-system
  infrastructure.
- GitHub OAuth provides identity only. Access is restricted to the human
  owner's immutable GitHub user ID.
- One root context file is canonical. Add `CONTEXT-MAP.md` or component context
  files only if repository size makes targeted discovery materially difficult.

## Delivery

- GitHub is the system of record. Work is represented by vertical-slice issues
  and compact evidence-based handoffs; no committed task journal.
- Pull requests use GitHub-hosted runners, ephemeral PostgreSQL, balanced
  full-stack CI, and one-browser end-to-end tests. Heavy tests are risk-triggered.
- Release images are immutable commit-SHA tags stored in GHCR.
- Production uses an approved in-place Docker Compose deployment to the VPS,
  with health checks and application-image rollback. There is no permanent
  staging environment and no self-hosted runner.
- Version-controlled Drizzle migrations run once after a verified backup.
  Automatic releases require backward-compatible schemas; destructive
  migrations require separate human approval.

## Production operations

- Deployment uses a forced-command SSH account and one root-owned allow-listed
  script. The account is not a member of the Docker group.
- GitHub Environment stores only the restricted deployment key. Application and
  backup secrets stay in root-owned VPS files.
- PostgreSQL runs in a dedicated private container with persistent storage.
  Restic encrypts off-VPS backups to Cloudflare R2 after a local temporary dump.
- Reuse the existing Uptime Kuma; add no other observability stack for the POC.
- Use a free deSEC `*.dedyn.io` hostname until an owned domain is justified.
- Production access is default-deny. Agent diagnostics must be explicit,
  supervised, temporary, and read-only; agents hold no persistent VPS credentials.

## AI team

- Claude Code: product analysis, requirements, issue shaping, documentation.
- Kiro: implementation, testing, and CI/CD.
- Codex: architecture, UI direction, difficult debugging, security, and final
  review.
- Controlled substitution is allowed only for platform outage or quota
  exhaustion. Model tier is selected separately for simple, standard, and
  critical work.
- Orca coordinates at most two worktrees, one writer per issue, read-only
  reviewers, and no permission bypass.
- Native CLI subscriptions only: no 9Router, extra API budget, or dedicated
  context service during the POC.

## Quality policy

- Risk-based TDD is mandatory for logic, authorization, persistence,
  migrations, and regressions.
- Security checks align with OWASP. Security-sensitive changes receive Codex
  critical review; exceptions and dependency merges are never automatic.
- UI options are implemented as isolated code-first variants, selected by the
  human, accessibility-tested, and Anti-Slop-reviewed before merge.
- OpenAPI drift checks and same-PR documentation updates are required.

Durable decisions live in `docs/adr/`; this file summarizes current state and
must not silently override an accepted ADR.
