# PocketBoard agent operating rules

This file is the canonical instruction source for every AI CLI used in this
repository. Platform-specific files must stay thin and point here rather than
copying these rules.

## Authority and records

- The human owner is the final decision maker and the only GitHub contributor.
- GitHub issues, pull requests, checks, releases, and immutable commit history
  are the system of record.
- Agents must not add themselves, bot identities, or AI tools as authors,
  co-authors, reviewers, or contributors.
- One issue has one writer. Reviewers are read-only. Orca may coordinate at
  most two independent worktrees. Permission bypass is prohibited.

## Context loading

1. Read this file, the assigned GitHub issue, and root `CONTEXT.md`.
2. Load only files named by the issue or discovered through targeted search.
3. Read relevant ADRs only when a decision affects the task.
4. Do not inventory or repeatedly reread the whole repository.
5. Finish with a compact evidence-based handoff: scope, files changed,
   commands/checks and results, risks, and next owner/action.

## Delivery rules

- Implement a REST vertical slice in the modular monolith; do not introduce
  distributed-system infrastructure.
- Use risk-based TDD for business logic, authorization, persistence,
  migrations, and regressions. Test-after is allowed only for low-risk visual
  presentation or wiring.
- Keep transport contracts shared and validated with Zod.
- Update curated documentation in the same pull request. Record durable,
  consequential decisions as concise immutable ADRs.
- Never weaken validation, security, accessibility, observability, backup, or
  rollback requirements merely to reduce code or token usage.

## Lean implementation skills

- `.agents/skills/lean-implementation/SKILL.md` is opt-in for simple and
  standard implementation tasks. The issue or orchestrator must request it.
- `.agents/skills/lean-review/SKILL.md` is an additional complexity review run
  only after correctness, tests, security, and documentation checks.
- Neither skill applies automatically to architecture, authentication,
  authorization, migrations, security-sensitive work, incident response, or
  difficult debugging.
- These local skills take precedence over upstream Ponytail defaults where the
  rules differ. Do not install Ponytail hooks, MCP servers, or always-on rules.

## Human approval gates

Human approval is required before merging, production deployment, destructive
migrations, secrets or permission changes, external service creation or spend,
security exceptions, dependency updates, rollback, or production data access.
Agents never hold persistent VPS credentials.

## GitHub approval protocol

- Request every human decision on the relevant GitHub issue or pull request;
  Orca and agent terminals are not approval records.
- The request must name a unique gate id, the exact proposed action and target
  (including commit SHA or dependency version when applicable), evidence,
  material risks, rollback, and the exact approval command.
- The human owner approves by commenting `APPROVE <gate-id>` from GitHub user
  id `325861437`. A rejection uses `REJECT <gate-id>: <reason>`.
- Reactions, approvals in chat or Orca, and vague comments such as “continue”,
  “okay”, or “LGTM” do not satisfy a high-impact gate.
- Approval is scoped to the stated target and expires if its commit SHA,
  versions, permissions, migration plan, deployment target, or risk statement
  changes materially.
- Before acting, the coordinator verifies the approving comment's immutable
  GitHub user id, records its URL, and resolves the matching Orca decision gate.
