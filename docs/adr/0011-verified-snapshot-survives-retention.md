# ADR 0011: the verified snapshot must survive postflight retention

## Status

Accepted

## Date

2026-09-28

## Superseded records

Amends ADR 0009 and ADR 0010 in part. Their limits, retention policy, evidence
rules and ordering stay in force. This record supersedes three statements:

- ADR 0009, Decision: after the upload, "the verified snapshot stays and only
  the deploy stops";
- ADR 0009, consequence **A full repository stops deployment**: after the
  upload, "the new snapshot was uploaded and verified and stays";
- ADR 0010, Decision: postflight rejection fails the backup "after the verified
  snapshot exists, without undoing it".

## Context

The exact-head review of PR #40 (issue #39) found that postflight retention can
delete the snapshot the backup just uploaded and verified. Restic chooses what
to keep by each snapshot's recorded time, not by upload order. If seven earlier
snapshots in the same group carry later times, for example after a host clock
that ran ahead was corrected, `keep-last 5`, `keep-daily 7`, `keep-weekly 4` and
`keep-monthly 3` can all be satisfied without the new snapshot, so `forget`
removes it. The size and count stay within the limits, so the helper reported a
verified backup and the deploy would have migrated without one. This was
reproduced with Restic 0.16.4 against a disposable local repository.

The same review found that the one-trailing-LF shape of the `restic stats`
reply was not enforced: Bash command substitution strips every trailing LF.

## Decision

- After postflight retention, the ID of the uploaded snapshot, as `restic backup
  --json` reports it, must appear in the validated `restic list snapshots`
  reply. Otherwise the backup fails before it reports success, so the deploy
  stops before migrations.
- Retention is not changed to protect the snapshot. It stays mandatory, with the
  same policy and limits, and a skewed history is left for the operator to
  inspect instead of being worked around.
- The `restic stats` reply may end in at most one LF. It is read without
  command substitution's stripping, and any further LF fails the grammar.

## Consequences

- **A postflight failure can leave no new snapshot.** If retention removed it,
  the deploy has no pre-deploy backup and stops. The operator checks the host
  clock and the snapshot times before retrying, because a retry fails the same
  way while the future-dated snapshots remain.
- **The coupling to Restic 0.16.4 grows again.** A Restic upgrade must also
  re-verify that `backup --json` reports the full 64-character snapshot ID that
  `list snapshots` prints. A shorter ID would never match, so every backup would
  fail closed after the upload.
