---
name: lean-review
description: Reviews a completed diff for unnecessary code, dependencies, abstractions, duplication, and configuration while preserving required behavior. Use on demand only after correctness, test, security, accessibility, and documentation gates have passed; it is not a substitute for those reviews.
---

# Lean review

## Scope

Read `AGENTS.md`, `CONTEXT.md`, the issue acceptance criteria, and the diff.
Review only avoidable complexity. Do not approve correctness, security,
performance, accessibility, migrations, or deployment safety.

## Review order

1. Code or files unrelated to an acceptance criterion.
2. New code duplicating an existing repository capability.
3. A dependency where an approved native or installed capability suffices.
4. Premature abstraction, indirection, configuration, fallback, or extension.
5. Tests that duplicate coverage without adding a distinct behavior or risk.
6. Documentation that repeats canonical context instead of linking to it.

## Output

For each finding provide file and line, evidence, safe deletion or
simplification, and expected effect. Rank findings by maintenance cost. If
nothing material can be removed, say so.

Never recommend removing acceptance criteria, risk-required tests, validation,
data-loss protection, security, accessibility, documentation obligations,
monitoring, backups, health checks, or rollback paths.
