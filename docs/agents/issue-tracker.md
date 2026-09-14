# Issue tracker: GitHub

Issues and PRDs for this repository live in GitHub Issues. GitHub is the system
of record; do not create a parallel committed task journal.

## Conventions

- Infer the repository from its GitHub remote and use `gh` for issue operations.
- Create one independently deliverable vertical-slice issue per implementation
  unit. Assign exactly one writer.
- Include goal, user-visible outcome, scope, exclusions, risk, acceptance
  criteria, permitted files, required tests, human gates, and handoff evidence.
- Use issue comments for compact handoffs and material scope clarifications.
- Link each pull request to its issue and include test and review evidence.
- Never list an AI platform or bot as author, co-author, contributor, assignee,
  or reviewer. The human owner remains the only contributor.

## Common operations

- Create: `gh issue create --title "..." --body-file <file>`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels`
- Comment: `gh issue comment <number> --body-file <file>`
- Change lifecycle: remove the prior triage label, then add the new one.
- Close: `gh issue close <number> --comment "..."`

When a skill says to publish a PRD, create a GitHub issue. When it says to fetch
the relevant ticket, read the issue body, labels, and comments.
