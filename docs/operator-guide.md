# PocketBoard operator guide

PocketBoard is a small, non-critical board used to prove the AI-assisted
delivery workflow end to end. The product is intentionally narrow: after the
owner signs in with GitHub, they can create cards, move them among Backlog,
Doing, and Done, and delete them. It contains no customer data or payment flow.

GitHub is the system of record. Orca coordinates work; it is not where final
requirements, approvals, code review evidence, or release history live.

## Current availability

| Target | Address | Current state |
| --- | --- | --- |
| Local web app | `http://127.0.0.1:5173` | Available while `npm run dev` is running |
| Local API health | `http://127.0.0.1:3000/health` | Available while the API is running |
| Production VPS | `https://pocketboard.43-156-84-63.sslip.io` (POC-only, [ADR 0008](adr/0008-sslip-io-poc-hostname.md)) | TLS reverse proxy live; PocketBoard not yet deployed, so `/api/health` answers `502` for now. The deploy path is in [production deployment](deployment.md); the first deploy needs its own approval on #8 |
| Release images | `ghcr.io/malbr/pocketboard-{api,web}:<commit SHA>` | Published by CI for each commit on `main`; never deployed automatically. See [release artifacts](release.md) |

`main` contains owner-only GitHub authentication (PR #11, merged 2026-09-17), so
every card route on `main` already requires the owner's GitHub session, moving
cards between columns (#4, PR #13, merged 2026-09-17), and deleting a card
(#5, PR #14, merged 2026-09-17).

The focused-lane board UI (#6) is **not** on `main`. It is pending review and
the human owner's merge approval. Nothing is active on a VPS until the owner
also approves a production release.

## Run PocketBoard locally

Requirements: Node.js 24+, npm 11+, Docker, and the local GitHub OAuth App whose
homepage is `http://127.0.0.1:5173` and callback is
`http://127.0.0.1:5173/api/auth/github/callback`.

1. In your worktree, install dependencies and copy `.env.example` to `.env`.
2. Create these ignored local files under `secrets/`:
   `github-client-id`, `github-client-secret`, `session-secret`, and
   `owner-github-user-id`.
3. Keep only file paths in `.env`; never paste secret values into `.env`, Git,
   GitHub issues, Orca prompts, or agent chat. Keep `.env` and `secrets/` at the
   repository root: the paths in `.env` resolve from there, not from whichever
   directory a script runs in.
4. Run `npm run dev`. It waits for PostgreSQL to report healthy before applying
   migrations, so the first run on a cold Docker daemon takes a few extra
   seconds instead of failing with a refused connection. If it stops after 60
   seconds, the container never became healthy — check `docker compose ps` and
   `docker compose logs postgres`.
5. Open `http://127.0.0.1:5173`, choose **Sign in with GitHub**, and authorize
   using the owner account.
6. The board opens on **Backlog**. The buttons above the heading switch between
   Backlog, Doing, and Done and show how many cards are in each; only the
   selected status is on screen.
7. Create a card and refresh the page to verify PostgreSQL persistence. New
   cards always land in Backlog, whichever status was showing. Choose **Start**
   on it, then the **Doing** button, and refresh again.
8. Check the keyboard path without touching the mouse: `Tab` reaches Sign out,
   the three status buttons, the title field, **Add card**, then each row's
   Start, second destination, and Delete, in that order. `Enter` or `Space`
   activates whatever is focused, and every stop draws a visible focus ring.
   Narrow the window to a phone width and repeat; nothing should scroll
   sideways.
9. To see the stale-write guard: open the board in two tabs, move the same card
   in one, then move it in the other. The second tab keeps the board it was
   showing, marks that card as changed somewhere else, and explains that a
   reload is needed; it does not silently undo the first move.
10. Choose **Delete** on a card. The browser asks for confirmation by name;
    **Cancel** changes nothing. Confirming removes the card from the board, and
    it stays gone after a refresh. Deleting the same card from a second, stale
    tab is refused the same way a stale move is.
11. To see the load-failure path, stop the API with the web app still running
    and reload. The board says it did not load and offers **Try again**, which
    works once the API is back.
12. Stop the processes with `Ctrl+C`. Run `npm run db:down` when the local
    PostgreSQL container is no longer needed.

Use `127.0.0.1`, not `localhost`; the OAuth callback must exactly match the URL
registered at GitHub.

## Normal work loop

1. Pick one GitHub issue with the `ready-for-agent` lifecycle label.
2. Give Orca that issue URL and assign exactly one writer. Use one worktree by
   default; a second is only for genuinely independent work.
3. Require the writer to create a PR linked to the issue and post a compact
   evidence handoff: scope, files changed, checks, risks, and next action.
4. Run a separate read-only review. Do not let the reviewer edit the writer's
   worktree.
5. In GitHub, inspect the diff and confirm required checks are green.
6. The human owner explicitly approves high-impact gates. An agent must never
   infer merge or deployment approval from a general “continue”.
7. Merge only after approval. Close Orca terminals and remove obsolete
   worktrees after the result is safely recorded in GitHub.

## Starting development through Orca

1. In GitHub, select one issue labelled `ready-for-agent`.
2. In Orca, create a worktree linked to that issue from `main`. Name it after
   the issue, for example `issue-4-move-cards`.
3. Start one writer terminal in that worktree. Kiro is the preferred
   implementation writer; Claude Code is the controlled fallback while Kiro is
   unavailable. Never start both as writers for the same issue.
4. Give the writer only the issue URL and this instruction: read `AGENTS.md`,
   the issue, `CONTEXT.md`, and relevant ADRs; load files selectively; implement
   and test the vertical slice; create a PR; then post a compact handoff.
5. After the writer stops, start Codex as a read-only reviewer. It may report
   findings but must not edit the writer's worktree.
6. If work reaches a human gate, create an Orca decision gate and post the same
   request on the linked GitHub issue or PR. Work remains blocked until the
   GitHub approval is verified.

The CLI equivalents for the first two steps are:

```powershell
orca open
orca worktree create --repo "name:Team Of AI" `
  --name "issue-4-move-cards" --issue 4 --base-branch main --setup run --json
```

Start a writer terminal after the worktree exists:

```powershell
orca terminal create --worktree issue:4 --title "issue-4-writer" `
  --command "kiro-cli" --focus --json
```

Use `--command "claude"` only for the approved fallback. Do not add
`--trust-all-tools`; permission bypass is prohibited.

## GitHub approval workflow

The coordinator posts this structure on the relevant issue or pull request and
mentions `@malbr`:

```text
## Human approval required
Gate: <unique-gate-id>
Action: <one exact action>
Target: <commit SHA, versions, environment, or migration>
Evidence: <checks and review result>
Risk: <material failure modes>
Rollback: <specific recovery action>

Approve by commenting exactly: APPROVE <unique-gate-id>
Reject by commenting: REJECT <unique-gate-id>: <reason>
```

An approval is valid only when the comment author has immutable GitHub user id
`325861437` and the target has not changed. The coordinator records the comment
URL in its handoff and resolves the corresponding Orca decision gate. General
chat approval, emoji reactions, and approval of a different SHA are invalid.
The human must type the approval directly in GitHub web or mobile; agents are
forbidden from submitting either approval command. For merge, production
deployment, and secret or permission changes, use GitHub's native human control
or perform the action manually rather than delegating the final click.

To receive these requests, open the PocketBoard repository, choose **Watch →
Custom**, and enable Issues and Pull requests. In GitHub notification settings,
enable web or email delivery for participating/watching conversations and set
Actions to notify at least on failed workflow runs.

## What to monitor in Orca

- **Issue identity:** every task names exactly one GitHub issue and expected
  output.
- **Writer ownership:** one writer per issue; no second agent changes the same
  files.
- **Worktree count:** normally one, never more than two independent worktrees.
- **Task state:** investigate `waiting`, `needs input`, `failed`, or a task that
  keeps running after its PR exists. Completed writers and reviewers should be
  stopped.
- **Permission boundary:** permission bypass remains disabled. Agents do not
  receive persistent VPS credentials or production secrets.
- **Handoff quality:** completion includes concrete command results and a PR or
  issue link, not only “done”.

Orca progress is useful while work is running, but do not treat its terminal
history as durable documentation.

## What to monitor in GitHub

- **Issues:** exactly one lifecycle label. `ready-for-agent` means sufficiently
  specified for work; `ready-for-human` means a human decision or action is
  required.
- **Pull requests:** linked issue, expected scope only, no unexplained files,
  no AI/bot author or co-author, and no unresolved review findings.
- **Actions:** `build-and-test` must be green. It runs lint, type checks,
  migrations, tests against ephemeral PostgreSQL, builds, a production
  dependency audit, and Chromium end-to-end coverage.
- **Security:** never accept automatic security exceptions or dependency
  merges. Review the affected runtime, exploitability, and upgrade risk.
- **Deployments:** the **Deploy** workflow runs only when dispatched from
  `main` and waits for your approval on the `production` Environment. Approve
  it only for the SHA named in an approved issue gate. Its log shows the
  backup, migration, health, and running SHA.
- **Production health:** after deployment, monitor the public `/health` URL in
  the existing Uptime Kuma and verify encrypted off-VPS backups separately.

## Human-only decisions

Only the human owner may approve merges, production deployments, destructive
migrations, dependency updates, security exceptions, secrets or permission
changes, rollback, spending, and production-data access.

## Context and token discipline

Start a fresh Codex/Claude/Kiro task for each GitHub issue and end it after the
handoff is recorded. Each task loads only `AGENTS.md`, its issue,
`CONTEXT.md`, relevant ADRs, and targeted files. Do not continue one permanent
project chat, paste entire command logs, or ask every agent to rediscover the
repository. A new reviewer should receive the PR URL plus the compact handoff,
then inspect only the changed files and required context.
