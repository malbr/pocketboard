---
name: lean-implementation
description: Implements a scoped low- or standard-risk issue with the smallest maintainable change that satisfies its acceptance criteria. Use when a PocketBoard issue or orchestrator explicitly requests lean implementation; do not use for architecture, auth, migrations, security-sensitive changes, incidents, or difficult debugging.
---

# Lean implementation

## Preconditions

- Confirm one GitHub issue, one writer, acceptance criteria, risk level, and
  permitted files.
- Read `AGENTS.md`, `CONTEXT.md`, the issue, and only relevant code or ADRs.
- Stop using this skill if the task enters an excluded critical category.

## Decision ladder

After tracing the affected flow, stop at the first correct option:

1. Do nothing if the requested behavior already exists.
2. Reuse an established repository pattern or component.
3. Use the language or platform standard library.
4. Use a native browser, Node.js, PostgreSQL, or framework capability.
5. Use a dependency already approved and installed.
6. Add the smallest clear implementation that meets all acceptance criteria.

Do not add a dependency, abstraction, configuration option, fallback, generic
framework, or speculative extension unless the issue demonstrates its need.
Minimum means maintainable and correct, never code-golfed.

## Verification

- Follow the risk-based TDD rules in `AGENTS.md`; this skill never reduces the
  required test scope.
- Preserve trust-boundary validation, error handling that prevents data loss,
  security, accessibility, documentation, monitoring, and rollback behavior.
- Run the smallest relevant checks first, then every check required by the
  issue and CI contract.

## Handoff

Report only: acceptance criteria satisfied, changed files, checks with results,
remaining risks, and next owner/action. Do not claim completion without
evidence.
