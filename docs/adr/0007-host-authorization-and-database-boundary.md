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
  a real UTC time, in the future and at most 7 days away. A rollback's digests must equal
  those in the release's ledger line. Each line is consumed under the deploy
  lock before the first side effect, so it works once. `status` needs no
  authorization.
- Nothing may change the database before a verified backup of the database
  as it is. A running database is backed up first. An existing but stopped
  database is refused. Only a host with no database gets a fresh database from
  the new release before its backup: no PostgreSQL container or volume with
  the Compose labels, no volume with the Compose name, and no successful
  release in the ledger. A Docker lookup that fails refuses the deploy rather
  than counting as "no database".
- Rollback restarts only `api` and `web` (`--no-deps`, no orphan removal). It
  never recreates, reconfigures or downgrades PostgreSQL.
- `status` only reads, and the unit has no dependency on `docker.service`, so
  a status request cannot start Docker.

## Consequences

- A copied deploy key alone cannot choose what production runs: any other
  action, SHA or digest, and any second use of a line, still needs root on
  the VPS, which already implies full control.
- A copied key can still use a line the owner has added but that has not been
  used yet. Between the owner adding the line and the approved workflow run,
  the key holder can send that exact request over SSH first. It runs before,
  and without, the Environment approval, consuming the line, so the approved
  run is then refused as already used. The damage is limited to running the
  approved action early. The owner narrows this window by adding the line
  just before approving the Environment, with a short expiry.
- Each deploy or rollback now needs one owner action as root on the VPS, in
  addition to the GitHub gate and the Environment approval. The owner already
  holds that access. Agents still hold none.
- Rollback cannot undo a PostgreSQL image or configuration change. That needs
  a restore or a new forward deploy, each separately approved.
- The earlier alternative, signed expiring authorizations sent with the
  request, was not chosen. The signature cannot fit in a systemd instance
  name, and it would need a spool path and more parsing on the root side.
