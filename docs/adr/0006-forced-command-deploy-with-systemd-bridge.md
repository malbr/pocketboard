# ADR 0006: Forced-command deploy through a polkit-limited systemd unit

## Status

Accepted

## Date

2026-09-18

## Superseded records

None. Amended by [ADR 0007](0007-host-authorization-and-database-boundary.md):
host-side authorization, the backup-before-database-change boundary, and
application-only rollback.

## Context

Issue #8 requires deploying approved commit-SHA releases to one VPS through an
SSH account that has no shell freedom, no sudo, and no Docker-group
membership. The GitHub Environment may hold only that account's key, and
agents may hold no VPS credential. Docker needs root, so the account needs one
narrow route to a root-owned script. The design was approved in
https://github.com/malbr/pocketboard/issues/8#issuecomment-5730058862
(`issue8-access-design`). The owner confirmed an amd64 host with `polkitd`
running.

## Decision

- The `pocketboard-deploy` account's only command is a forced command
  (`ssh-gate`). It accepts `deploy <sha> <api digest> <web digest>`,
  `rollback <sha>`, or `status` as whole-string matches and nothing else.
- The gate turns a valid request into the instance name of
  `pocketboard-deploy@.service`, a root oneshot unit, and runs
  `systemctl start`. A polkit rule lets this account `start` only units with
  that name pattern. The root script validates the name again.
- Deploys fetch `compose.production.yml` from GitHub by commit SHA and keep it
  per release on the host. Images are pulled by `tag@digest`, and their
  revision label must equal the SHA.
- Every deploy takes a verified Restic backup to R2 before running migrations
  once. A failed step stops the deploy; there is no automatic rollback.
- Rollback restarts a release recorded `ok` in a root-owned ledger, with its
  recorded digests and compose file. It never changes the database. CI
  therefore rejects destructive or rollback-incompatible migrations, with no
  bypass.
- A dispatch-only workflow gated by the `production` Environment sends the
  single SSH request. It holds `contents: read` and `actions: read` and takes
  digests from the commit's own successful CI release record.

## Consequences

- The deploy account has no sudo and no Docker group, and cannot choose what
  runs as root. Correction (PR #29 review): the Environment gates only the
  workflow's use of the key. A copied key could send a valid request over SSH
  directly, without that approval. ADR 0007 adds the host-side authorization
  that closes this gap.
- GitHub-hosted runner addresses vary, so the key cannot be restricted by
  source address.
- A deploy depends on GitHub (compose file) and R2 (backup). A rollback
  depends on neither.
- Destructive schema changes need a separate issue that designs their own
  approval path.
- Output returns to the workflow through a per-request log file that other
  local users can read. It holds SHAs, digests, health, migration output and
  snapshot ids, and no secrets.
