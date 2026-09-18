# ADR 0004: Task-based AI writer routing

## Status

Accepted

## Date

2026-09-18

## Superseded records

None. This refines the platform-role summary in `CONTEXT.md`.

## Context

PocketBoard originally assigned implementation primarily by CLI platform. Kiro
is currently unavailable, Pi has been connected to several model providers,
and public coding benchmarks suggest that model suitability varies materially
by task. Silent fallback would weaken reproducibility, cost control, context
integrity, and the one-writer rule.

## Decision

Orca assigns exactly one writer per GitHub issue and records the platform,
provider, model, relevant settings, attempt limit, tools, and budget. Pi may be
the initial writer for an eligible issue, not only a quota fallback. KiosAPI is
an approved provider for the public, non-critical POC; other configured routes
remain explicit alternatives.

There is no automatic provider or model failover. A provider or model change
ends the current writer session, produces a compact handoff, and starts a fresh
session under a new writer lease. Public benchmarks guide candidate selection,
but PocketBoard bake-offs and review evidence determine local routing policy.

Pi receives no secrets, production data, persistent VPS credentials, or
unrestricted shell. Critical auth, migration, security, release, deployment,
and incident work retains stronger human gates and independent review.

## Consequences

- Strong or economical Pi models can perform eligible implementation work
  without waiting for another platform's quota exhaustion.
- Every run is attributable to a specific route and can be compared by
  correctness, scope, maintainability, safety, cost, and latency.
- Model switches cost an additional fresh session and handoff, but avoid mixed
  reasoning histories and unreliable attribution.
- Provider aliases and benchmark claims remain untrusted until conformance and
  project-specific evaluation confirm them.
