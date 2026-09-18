# Claude Code adapter

Read and follow `AGENTS.md` as the canonical rules and `CONTEXT.md` for project
domain context. Do not duplicate their contents here.

Claude Code may perform product analysis, requirements, issue shaping,
documentation, or implementation. Writing code requires an explicit issue
assignment and an active single-writer lease recorded on GitHub. When acting as
a writer it must not also be the read-only reviewer for that issue.

## Agent skills

### Issue tracker

Issues and PRDs live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels as mutually exclusive lifecycle states. See
`docs/agents/triage-labels.md`.

### Domain docs

This repository uses one root context and root ADR directory. See
`docs/agents/domain.md`.
