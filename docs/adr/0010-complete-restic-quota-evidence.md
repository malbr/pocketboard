# ADR 0010: complete Restic evidence for the backup quota

## Status

Accepted

## Date

2026-09-28

## Superseded records

Amends ADR 0009 in part. Its limits, retention policy, parser rules, ordering and
the rest of its decision stay in force. This record supersedes two statements in
it:

- the decision that quota decisions rest on `restic stats` alone, which it
  extends with a completeness rule;
- the consequence **Two prunes per deploy**, which is inaccurate.

## Context

The exact-final review of PR #38 (issue #39) found that ADR 0009's evidence can
be incomplete while still passing every rule ADR 0009 sets. Restic 0.16.4 skips a
snapshot it cannot load with a warning on stderr, exits 0, and reports only the
snapshots it could read. When it can read none, it prints
`{"total_size":0,"snapshots_count":0}`, exactly what an empty repository gives.
`forget` reads snapshots the same way, so it neither keeps nor removes one it
skipped. This was reproduced against a disposable local repository with real
Restic 0.16.4: the unchanged helper uploaded and reported a verified backup over
a repository whose every snapshot was unreadable.

The same review found that validator utilities could print plausible output and
then fail without stopping the backup. It also found two overstated claims.
`restic cat config` takes a lock, so an oversized dump is refused after one lock
object has been written and removed, not before any write. And `forget --prune`
only prunes when it selects a snapshot for removal.

## Decision

- Quota evidence must be complete as well as well-formed. `restic stats`,
  `restic list snapshots` and both retention runs must exit 0 **and** write
  nothing to stderr. Any warning fails the backup, whatever its wording, because
  a healthy Restic 0.16.4 run writes none. Warnings are not copied into the
  Deploy log.
- `snapshots_count` must equal the number of snapshot files that
  `restic list snapshots` names. That command lists the files without loading
  them, so the rule holds even if Restic skips a snapshot silently. Its reply
  must be exactly one 64-character lowercase hex id per line. A healthy empty
  repository has no snapshot files and passes.
- Every utility the checks use must succeed; its output is not trusted
  otherwise.
- Preflight rejection still prevents the upload. Postflight rejection still
  fails the backup after the verified snapshot exists, without undoing it.

## Consequences

- **Unreadable snapshots stop deployment.** So does a transient backend error
  that Restic retried and recovered from, because it also writes a warning. The
  operator reruns the command by hand to tell the two apart (`docs/deployment.md`).
- **Retention is not two prunes per deploy.** `forget` runs twice. `prune` runs
  only when a `forget` removes a snapshot, so zero, one or two prunes happen.
- **Refusals still write to R2.** Every Restic command the backup runs takes a
  lock, which writes and removes an object. This includes the reachability
  check before the dump-size refusal and the added snapshot listing. The
  limits guard storage and do not guarantee zero charges.
- **The coupling to Restic 0.16.4 grows.** A Restic upgrade must also re-verify
  that healthy runs stay silent on stderr and that `list snapshots` keeps its
  one-id-per-line output, using `deploy/vps/tests/pocketboard-backup.test.sh`
  and the disposable-host integration test.
