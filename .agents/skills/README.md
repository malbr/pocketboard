# Local agent skills

These are project-owned adaptations, not an installed Ponytail plugin.

Source reviewed: `DietrichGebert/ponytail` at commit
`356918eba965ee1eac64bd3a7f0dd02108350de5` (MIT). The local wording is adapted
to PocketBoard's risk-based TDD, security, documentation, and approval gates.

No upstream hook, MCP server, executable script, global configuration, or
always-on Ponytail steering is included. Updating from upstream requires a new
static audit, an explicit human decision, and an update to the pinned commit in
this file.

## Project-owned skills

- `lean-implementation`: smallest maintainable change for explicitly eligible
  low- or standard-risk issues.
- `lean-review`: optional complexity review after all required quality gates.
- `pi-issue-writer`: constrained Pi implementation role and launcher.
- `model-bakeoff`: comparable, evidence-based evaluation of writer candidates.
- `anti-slop-review`: read-only UI quality gate after correctness and
  accessibility checks.

All are loaded on demand. None grants permission beyond `AGENTS.md` or the
assigned GitHub issue.
