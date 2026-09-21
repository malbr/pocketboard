# ADR 0007: Host-side deploy authorization and the database boundary

## Status

Accepted

## Date

2026-09-21

## Superseded records

Amends [ADR 0006](0006-forced-command-deploy-with-systemd-bridge.md). ADR
0006's first consequence, that a stolen key still waits for Environment
approval, was false. Its rollback decision is narrowed to the application
containers.

## Context

The independent review of PR #29
(https://github.com/malbr/pocketboard/pull/29#issuecomment-5733203079)
found two design gaps:

- The `production` Environment gates only the workflow's access to the stored
  key. Anyone holding a copy of the key can send `deploy` or `rollback` over
  SSH, and the host checked syntax, image labels and its ledger, never the
  owner's approval.
- Deploy started the new release's PostgreSQL definition before the backup.
  Rollback ran `compose up --remove-orphans` over every service with the old
  definition. Either could replace or downgrade the database container
  outside the backup boundary.

## Decision

- `deploy` and `rollback` need a matching line in
  `/etc/pocketboard/authorized-requests`, a root-owned file that only the
  owner edits, as root on the VPS, after approving the GitHub gate. The line
  is `<expiry> <action> <sha> <api digest> <web digest>`. The expiry must be
  in the future and at most 7 days away. A rollback's digests must equal
  those in the release's ledger line. Each line is consumed under the deploy
  lock before the first side effect, so it works once. `status` needs no
  authorization.
- Nothing may change the database before a verified backup of the database
  as it is. A running database is backed up first. Only a host with no
  database volume gets a fresh database from the new release before its
  backup. An existing but stopped database is refused.
- Rollback restarts only `api` and `web` (`--no-deps`, no orphan removal). It
  never recreates, reconfigures or downgrades PostgreSQL.
- `status` only reads, and the unit has no dependency on `docker.service`, so
  a status request cannot start Docker.

## Consequences

- A copied deploy key alone can no longer change production. An attacker
  also needs root on the VPS, which already implies full control.
- Each deploy or rollback now needs one owner action as root on the VPS, in
  addition to the GitHub gate and the Environment approval. The owner already
  holds that access. Agents still hold none.
- Rollback cannot undo a PostgreSQL image or configuration change. That needs
  a restore or a new forward deploy, each separately approved.
- The earlier alternative, signed expiring authorizations sent with the
  request, was not chosen. The signature cannot fit in a systemd instance
  name, and it would need a spool path and more parsing on the root side.
