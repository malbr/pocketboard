# ADR 0009: source-controlled POC backup quota limits

## Status

Accepted

## Date

2026-09-27

## Superseded records

None. This record adds quota limits to the backup path accepted in ADR 0006 and
bounded by ADR 0007; neither is superseded.

## Context

Every deploy takes a verified Restic backup to Cloudflare R2 before anything
changes the database (ADR 0006, ADR 0007). Issue #37 is the last gate before R2
is switched on.

R2 offers no hard spend limit a script can rely on, and PocketBoard is a
non-critical POC with no customer data, so unbounded backup storage buys nothing
and risks real money. Retention already existed but was advisory: a failed
`restic forget --prune` only logged a warning, so nothing actually bounded the
repository's growth, and nothing stopped a deploy from uploading a dump of any
size.

## Decision

- `deploy/vps/pocketboard-backup` enforces three limits: one verified dump of at
  most 100 MiB, at most 2 GiB of Restic raw data, and at most 20 snapshots in
  the repository.
- The limits are constants in that script, declared read-only before
  `backup.env` is sourced. No environment variable, flag or settings entry can
  raise or bypass them. Changing one takes a reviewed repository change and a
  release.
- Retention (`keep-last 5`, `keep-daily 7`, `keep-weekly 4`, `keep-monthly 3`,
  with `--prune`) is mandatory and runs twice: before the upload, so a
  repository sitting at the snapshot limit can come back under it, and again
  after the snapshot is verified. A retention failure fails the backup, and
  therefore the deploy.
- Quota decisions rest on one machine-readable source, `restic stats --mode
  raw-data --json` from Restic 0.16.4, which reports `total_size` and
  `snapshots_count` for the whole repository. They are taken on the repository
  retention leaves behind, not on the one it found.
- The pre-upload projection charges the whole dump size against the raw-data
  limit, even though Restic deduplicates and compresses it. Equality passes; any
  larger projection fails.
- Evidence fails closed. A `restic stats` that fails, output that is not one
  JSON object, and a field that is missing, repeated, non-numeric, negative,
  fractional, zero-padded or longer than 15 digits all stop the backup with
  nothing uploaded, rather than being read as a small number.
- The limits are re-checked after the verified snapshot, so an upload that took
  the repository past a limit stops this deploy instead of surfacing on the next
  one.

## Consequences

- **A full repository stops deployment.** That is the intent: the backup runs
  before anything changes the database, so a rejection leaves production exactly
  as it was. The operator diagnoses it from the `backup: FAILED: …` line
  documented in `docs/deployment.md`.
- **Growth needs a decision, not a setting.** A PocketBoard that legitimately
  outgrows 100 MiB, 2 GiB or 20 snapshots needs a new ADR superseding this one
  and a released change, which is deliberately harder than editing a file on the
  VPS.
- **Not a billing cap.** The limits bound what PocketBoard stores. R2 also bills
  for operations and for overhead the guard cannot see, so this reduces cost
  risk rather than removing it. Cloudflare's own billing notifications remain
  the backstop.
- **Coupled to Restic 0.16.4's JSON.** The guard reads two fields by name and
  refuses anything it cannot read unambiguously, so a Restic upgrade changing
  `stats --json` blocks deploys until it is re-verified against
  `deploy/vps/tests/pocketboard-backup.test.sh`. Treat a Restic upgrade on the
  VPS as a change that needs that check first.
- **Two prunes per deploy.** Retention runs twice, which costs extra R2
  operations per deploy in exchange for the pre-upload headroom.
- **Restore is unchanged.** Snapshot host, tags, path and the read-back
  SHA-256 comparison are untouched, so `pocketboard-restore` and the documented
  restore procedure keep working against existing snapshots.
