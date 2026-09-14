# Domain documentation

This is a single-context repository.

## Required context

Before working, read root `AGENTS.md`, the assigned GitHub issue, and root
`CONTEXT.md`. Read only ADRs in `docs/adr/` relevant to the affected decision.
Do not repeatedly scan the full repository.

Use terminology from `CONTEXT.md` in issues, tests, code, and documentation. If
a necessary concept is undefined, flag the gap instead of inventing competing
language.

If proposed work contradicts an accepted ADR, identify the ADR and escalate the
conflict. Do not silently override it. A changed durable decision requires a new
ADR that explicitly supersedes the prior record.

Add `CONTEXT-MAP.md` and component contexts only when repository growth makes
the single root context materially difficult to navigate.
