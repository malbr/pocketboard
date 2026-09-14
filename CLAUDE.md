# Claude Code adapter

Read and follow `AGENTS.md` as the canonical rules and `CONTEXT.md` for project
domain context. Do not duplicate their contents here.

Claude Code's primary role is product analysis, requirements, issue shaping,
and documentation. Writing code requires an explicit issue assignment.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels as mutually exclusive lifecycle states. See
`docs/agents/triage-labels.md`.

### Domain docs

This repository uses one root context and root ADR directory. See
`docs/agents/domain.md`.
