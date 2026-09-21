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
  script. The account is not a member of the Docker group and has no sudo; it
  reaches root only by starting one polkit-allowed systemd unit (ADR 0006).
- The host refuses any deploy or rollback without the owner's single-use,
  expiring authorization line naming its SHA and digests, so the SSH key alone
  cannot choose what production runs. It can only use an unused line early,
  before the Environment approval (ADR 0007).
- Every deploy backs up the database before anything changes it. Rollback
  restarts only the earlier api and web images and never changes the
  database, so CI rejects destructive or rollback-incompatible migrations.
- GitHub Environment stores only the restricted deployment key. Application and
  backup secrets stay in root-owned VPS files.
- PostgreSQL runs in a dedicated private container with persistent storage.
  Restic encrypts off-VPS backups to Cloudflare R2 after a local temporary dump.
- Reuse the existing Uptime Kuma; add no other observability stack for the POC.
- Use a free deSEC `*.dedyn.io` hostname until an owned domain is justified.
- Production access is default-deny. Agent diagnostics must be explicit,
  supervised, temporary, and read-only; agents hold no persistent VPS credentials.

## AI team

- Orca coordinates work but never owns product or approval decisions.
- Claude Code is a primary issue writer and may also perform product analysis,
  requirements, issue shaping, and documentation when assigned.
- Pi is a controlled issue writer. Orca selects its provider and model
  explicitly per issue; there is no automatic provider or model failover.
- Codex owns architecture, UI direction, difficult debugging, security, and
  final read-only review unless explicitly assigned as the sole writer.
- Kiro is paused because its account is unavailable. It receives no work until
  the human owner restores it.
- Writer selection is task-based rather than platform-first. Public benchmark
  results are hypotheses until the candidate passes a PocketBoard bake-off.
- KiosAPI is quarantined because its documented endpoint does not resolve.
  It is absent from the active Pi catalogue and writer launcher. Re-enable it
  only after endpoint, quota, model-identity, max-reasoning, and tool-call
  conformance checks pass. Its stored key remains unused.
- Orca coordinates at most two worktrees, one writer per issue, read-only
  reviewers, and no permission bypass.
- Native CLI subscriptions remain preferred. Any Pi API route is explicit and
  budget-capped; there is no dedicated routing or context service in the POC.

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
