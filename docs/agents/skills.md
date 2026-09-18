# Agent skills catalog

Skills are selected per task. Loading every skill into every session wastes
tokens and creates conflicting instructions.

## Shared operating skills

These workflows are available to Claude and Codex and may be passed explicitly
to Pi when relevant:

| Skill | Use |
| --- | --- |
| `to-prd` / `to-issues` / `triage` | Shape work in GitHub, the system of record |
| `tdd` | Logic, authorization, persistence, migrations, and regressions |
| `diagnose` | Reproduce and isolate difficult defects before fixing |
| `handoff` | Compact transfer between writers or into review |
| `zoom-out` / `improve-codebase-architecture` | Explicit architecture work only |

The Matt Pocock setup is recorded in `CLAUDE.md` and `docs/agents/`. These
skills read the existing GitHub, lifecycle-label, and single-context choices;
they do not create a second task store.

## Role-specific skills

| Role or task | Skill |
| --- | --- |
| Eligible low/standard-risk writer | `.agents/skills/lean-implementation` |
| Pi writer | `.agents/skills/pi-issue-writer` |
| Model evaluator | `.agents/skills/model-bakeoff` |
| UI reviewer after human selection | `.agents/skills/anti-slop-review` |
| Complexity reviewer after other gates | `.agents/skills/lean-review` |

Watermark/provenance cleanup remains a separately installed on-demand utility.
It is never loaded during normal implementation and no background file service
is started.

## Project-specific context

Load `AGENTS.md`, the assigned issue, root `CONTEXT.md`, relevant ADRs, and only
the affected files. `docs/agents/issue-tracker.md`, `triage-labels.md`, and
`domain.md` configure the shared engineering skills.

## Temporary task context

Issue comments contain writer leases, scope clarifications, approvals, and
compact handoffs. Model transcripts, scratch journals, repository inventories,
and full conversation dumps are not committed. A new writer receives only the
issue plus the compact handoff and starts a fresh session.
