#!/usr/bin/env bash
# Exercises pocketboard-backup against fake `docker` and `restic`, so the
# verify-before-upload, quota and verify-after-upload rules are covered without
# a database, R2, or credentials.
# Assertions are single-quoted on purpose: check() evaluates them after each run.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
backup="$here/../pocketboard-backup"
sha="0123456789abcdef0123456789abcdef01234567"
failures=0

# Per-run knobs, set as prefix assignments on run() so they last one case only.
DUMP_BYTES=""
STATS_0=""
STATS_1=""
STATS_2=""
STATS_1_RAW=""
ENV_OVERRIDE=""
WARN=""
# The wording Restic 0.16.4 prints for a snapshot it cannot load (issue #39).
WARNING='Ignoring "5e1f00d1": failed to load snapshot 5e1f00d1: invalid data returned'
FAIL=""
HIDDEN=""
LIST_JUNK=""
FAIL_TOOL=""
FAIL_ARGS="*"
FAIL_PHASE=""

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

cat > "$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# The fakes use the real utilities, never a failing one staged for the script.
PATH=/usr/bin:/bin
printf 'docker %s\n' "$*" >> "$FAKE_CALLS"
case "$1" in
  ps) [[ "$FAKE_MODE" == no-db ]] || echo "pgcid" ;;
  exec)
    if [[ "$*" == *pg_dump* ]]; then
      [[ "$FAKE_MODE" == dump-fail ]] && exit 1
      [[ "$FAKE_MODE" == bad-dump ]] && { echo "not a dump"; exit 0; }
      [[ -n "${FAKE_DUMP_BYTES:-}" ]] \
        && { printf PGDMP; head -c "$((FAKE_DUMP_BYTES - 5))" /dev/zero; exit 0; }
      printf 'PGDMP fake dump body\n'
    elif [[ "$*" == *pg_restore* ]]; then
      cat > /dev/null
      [[ "$FAKE_MODE" == bad-toc ]] && exit 1
      echo "; Archive created"
    fi ;;
  *) exit 99 ;;
esac
FAKE

# `restic stats` answers from a staged file per repository state: stats.0 until
# retention has run, stats.1 once it has, stats.2 once a snapshot exists. A
# case that stages only stats.1 gets it at every stage, and the literal EXIT1
# stands for a failed stats command. Staging by state is what lets a case prove
# the quota decision reads the repository after retention rather than before.
#
# `restic list snapshots` names one snapshot file per snapshot the staged stats
# counted, as it does on a healthy repository. Three knobs take a list of
# <command>:<phase> words, the phase being pre or post the upload:
#   FAKE_WARN   the command writes a warning to stderr and still exits 0,
#               as Restic 0.16.4 does when it skips a snapshot it cannot load;
#   FAKE_FAIL   the command writes its normal output, then exits 42;
#   FAKE_HIDDEN (list only) one more snapshot file exists than stats counted.
cat > "$work/bin/restic" <<'FAKE'
#!/usr/bin/env bash
PATH=/usr/bin:/bin
printf 'restic %s\n' "$*" >> "$FAKE_CALLS"
phase=pre
grep -q '^restic backup' "$FAKE_CALLS" && phase=post
staged() { [[ " $1 " == *" $2:$phase "* ]]; }
# The warning carries the backup.env secret, so a case can prove that nothing
# Restic writes to stderr is echoed.
staged "${FAKE_WARN:-}" "$1" && printf '%s (%s)\n' "$FAKE_WARNING" "${AWS_SECRET_ACCESS_KEY:-}" >&2
fixture() {
  local stage=0 candidate
  grep -q '^restic forget' "$FAKE_CALLS" && stage=1
  grep -q '^restic backup' "$FAKE_CALLS" && stage=2
  for candidate in "$stage" 1 0; do
    [[ -f "$FAKE_STATS.$candidate" ]] && { printf '%s' "$FAKE_STATS.$candidate"; return; }
  done
}
case "$1" in
  cat) [[ "$FAKE_MODE" == no-repo ]] && exit 1; echo '{"version":2}' ;;
  stats)
    fixture="$(fixture)"
    # The fixture is written out byte for byte, so a NUL or any other byte a
    # shell would silently drop reaches the script under test.
    case "$(head -c 5 "$fixture")" in
      EMPTY) exit 0 ;;
      EXIT1) exit 1 ;;
    esac
    cat "$fixture" ;;
  list)
    [[ "$2" == snapshots ]] || exit 99
    count="$(grep -o '"snapshots_count":[0-9]*' "$(fixture)" | head -n 1 | cut -d: -f2)"
    count="$((10#${count:-0}))"
    staged "${FAKE_HIDDEN:-}" list && count=$((count + 1))
    # FAKE_LIST_JUNK, a printf format, stands in for the last id, so the number
    # of entries still matches and only their content is wrong.
    [[ -n "${FAKE_LIST_JUNK:-}" ]] && count=$((count - 1))
    for (( i = 1; i <= count; i++ )); do printf '%064x\n' "$i"; done
    # shellcheck disable=SC2059
    [[ -n "${FAKE_LIST_JUNK:-}" ]] && printf "$FAKE_LIST_JUNK"
    : ;;
  backup)
    [[ "$FAKE_MODE" == backup-fail ]] && exit 1
    cat > "$FAKE_STORE"
    [[ "$FAKE_MODE" == no-snapshot-id ]] && { echo '{"message_type":"summary"}'; exit 0; }
    echo '{"message_type":"status","percent_done":1}'
    echo '{"message_type":"summary","snapshot_id":"5e1f00d1c0ffee5e1f00d1c0ffee5e1f00d1c0ffee5e1f00d1c0ffee5e1f00d1","total_bytes_processed":21}' ;;
  dump)
    if [[ "$FAKE_MODE" == corrupt ]]; then echo "different bytes"; else cat "$FAKE_STORE"; fi
    [[ "$FAKE_MODE" == dump-exit1 ]] && exit 1
    : ;;
  forget)
    [[ "$FAKE_MODE" == forget-fail ]] && exit 1
    [[ "$FAKE_MODE" == forget-fail-after ]] && grep -q '^restic backup' "$FAKE_CALLS" && exit 1
    echo "applying policy" ;;
  *) exit 99 ;;
esac
staged "${FAKE_FAIL:-}" "$1" && exit 42
exit 0
FAKE
chmod +x "$work/bin/docker" "$work/bin/restic"

write_env() {
  cat > "$work/backup.env" <<'ENV'
RESTIC_REPOSITORY=s3:https://example.r2.cloudflarestorage.com/pocketboard-backups
RESTIC_PASSWORD=test-only-password
AWS_ACCESS_KEY_ID=test-only-id
AWS_SECRET_ACCESS_KEY=test-only-secret
AWS_DEFAULT_REGION=auto
ENV
  chmod "${1:-600}" "$work/backup.env"
}

# run <mode> [args...]; sets code, output
run() {
  local mode="$1"
  shift
  : > "$work/calls"
  rm -rf "$work/tmp" "$work/store"
  rm -f "$work"/stats.*
  printf '%s\n' "${STATS_1:-{\"total_size\":1024,\"snapshots_count\":3\}}" > "$work/stats.1"
  [[ -n "$STATS_0" ]] && printf '%s\n' "$STATS_0" > "$work/stats.0"
  [[ -n "$STATS_2" ]] && printf '%s\n' "$STATS_2" > "$work/stats.2"
  # A raw fixture is a printf format, so a case can stage bytes a shell variable
  # cannot carry, such as a NUL.
  # shellcheck disable=SC2059
  [[ -n "$STATS_1_RAW" ]] && printf "$STATS_1_RAW" > "$work/stats.1"
  # FAIL_TOOL puts a utility in front of the real one that does the real work,
  # output and all, and then exits 42 when its arguments match the FAIL_ARGS
  # glob, from the start or (FAIL_PHASE=post) only once the upload has run.
  rm -rf "$work/failbin"
  mkdir -p "$work/failbin"
  if [[ -n "$FAIL_TOOL" ]]; then
    cat > "$work/failbin/$FAIL_TOOL" <<SHIM
#!/bin/bash
/usr/bin/$FAIL_TOOL "\$@"
status=\$?
# shellcheck disable=SC2053
if [[ "\$*" == \$FAIL_TOOL_ARGS ]] \\
  && { [[ "\$FAIL_TOOL_PHASE" != post ]] || /usr/bin/grep -q '^restic backup' "\$FAKE_CALLS"; }; then
  exit 42
fi
exit \$status
SHIM
    chmod +x "$work/failbin/$FAIL_TOOL"
  fi
  code=0
  output="$(env -i PATH="$work/failbin:$work/bin:/usr/bin:/bin" ${ENV_OVERRIDE:+"$ENV_OVERRIDE"} \
    FAKE_CALLS="$work/calls" FAKE_STORE="$work/store" \
    FAKE_WARN="$WARN" FAKE_WARNING="$WARNING" FAKE_FAIL="$FAIL" FAKE_HIDDEN="$HIDDEN" \
    FAKE_LIST_JUNK="$LIST_JUNK" FAIL_TOOL_ARGS="$FAIL_ARGS" FAIL_TOOL_PHASE="$FAIL_PHASE" \
    FAKE_STATS="$work/stats" FAKE_MODE="$mode" FAKE_DUMP_BYTES="$DUMP_BYTES" \
    POCKETBOARD_BACKUP_ENV="$work/backup.env" POCKETBOARD_BACKUP_TMP="$work/tmp" \
    POCKETBOARD_EXPECTED_OWNER_UID="$(id -u)" bash "$backup" "$@" 2>&1)" || code=$?
}

check() {
  local description="$1" condition="$2"
  if eval "$condition"; then
    echo "ok: $description"
  else
    echo "FAIL: $description (exit $code, output: $output, calls: $(cat "$work/calls"))"
    failures=$((failures + 1))
  fi
}

uploaded() { grep -q '^restic backup' "$work/calls"; }
no_dump_left() { [[ -z "$(find "$work/tmp" -type f 2>/dev/null)" ]]; }
# A one-line signature of what actually ran, so ordering is asserted directly.
sequence() {
  sed -E 's/^docker ps.*/find-db/; s/^docker exec.*pg_dump.*/dump/;
    s/^docker exec.*pg_restore.*/verify-dump/; s/^restic cat.*/repo/;
    s/^restic stats.*/stats/; s/^restic list snapshots$/list/; s/^restic forget.*/retain/;
    s/^restic backup.*/upload/; s/^restic dump.*/read-back/' "$work/calls" | paste -sd, -
}

write_env
run ok "$sha"
check "a verified backup succeeds" '[[ $code == 0 && $output == *"verified backup"* && $output == *"snapshot 5e1f00d1"* ]]'
# Restic groups retention by host and paths by default, so a per-run file name
# put every snapshot in its own group and kept all of them (PR #29 review,
# finding 6). The path is stable and the release lives only in a tag.
check "the dump is streamed to restic under one stable path, tagged with the release" \
  'grep -q -- "--stdin --stdin-filename pocketboard.dump\$" "$work/calls" && grep -q -- "--tag sha-$sha" "$work/calls"'
check "the uploaded snapshot is read back from that path" 'grep -q "^restic dump 5e1f00d1[0-9a-f]* /pocketboard.dump$" "$work/calls"'
retention_line="^restic forget --host pocketboard --tag pocketboard --group-by host --keep-last 5 --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune\$"
check "the whole accepted retention policy runs both before and after the upload" \
  '(( $(grep -c -- "$retention_line" "$work/calls") == 2 ))'
check "quota evidence comes from one repository-wide raw-data report, before and after" \
  '(( $(grep -c -- "^restic stats --mode raw-data --json\$" "$work/calls") == 2 ))'
check "the run keeps its order: verified dump, quota preflight, upload, read-back, quota postflight" \
  '[[ "$(sequence)" == repo,find-db,dump,verify-dump,retain,stats,list,upload,read-back,retain,stats,list ]]'
check "retention groups every PocketBoard snapshot together, not per tag or path" \
  'grep -q -- "^restic forget --host pocketboard --tag pocketboard --group-by host " "$work/calls"'
check "the local dump is deleted" no_dump_left
check "no secret value reaches the output" '[[ $output != *test-only* ]]'

run corrupt "$sha"
check "a snapshot that reads back differently fails" '[[ $code == 1 && $output == *"does not match"* ]]'
check "the local dump is deleted after a failure" no_dump_left

run bad-dump "$sha"
check "a dump without the pg_dump header is never uploaded" '[[ $code == 1 ]] && ! uploaded'

run bad-toc "$sha"
check "a dump pg_restore cannot list is never uploaded" '[[ $code == 1 ]] && ! uploaded'

run no-repo "$sha"
check "an unreachable repository stops before dumping" '[[ $code == 1 ]] && ! grep -q pg_dump "$work/calls"'

run no-db "$sha"
check "no running database container fails" '[[ $code == 1 ]] && ! uploaded'

# --- Quota guard (issue #37) ------------------------------------------------
# The limits are source-controlled, so these cases name the same numbers the
# script does: 104857600 bytes (100 MiB) per dump, 2147483648 bytes (2 GiB) of
# projected raw data, and 20 snapshots.
DUMP_BYTES=$((100 * 1024 * 1024 + 1)) run ok "$sha"
check "a dump one byte over the 100 MiB limit is rejected before any restic backup" \
  '[[ $code == 1 && $output == *"104857601 bytes"* && $output == *"104857600"* ]] && ! uploaded'

DUMP_BYTES=$((100 * 1024 * 1024)) run ok "$sha"
check "a dump at exactly the 100 MiB limit is still backed up" \
  '[[ $code == 0 && $output == *"verified backup"* ]] && uploaded'

STATS_1='{"total_size":2147483628,"snapshots_count":3}' run ok "$sha"
check "raw data plus the whole dump one byte over 2 GiB is rejected before any upload" \
  '[[ $code == 1 && $output == *"2147483649"* && $output == *"2147483648"* ]] && ! uploaded'

STATS_1='{"total_size":2147483627,"snapshots_count":3}' run ok "$sha"
check "raw data plus the whole dump at exactly 2 GiB is still backed up" \
  '[[ $code == 0 && $output == *"verified backup"* ]] && uploaded'

STATS_1='{"total_size":1024,"snapshots_count":20}' run ok "$sha"
check "a repository already holding the 20 allowed snapshots takes no new one" \
  '[[ $code == 1 && $output == *"holds 20 snapshot"* ]] && ! uploaded'

STATS_1='{"total_size":1024,"snapshots_count":19}' run ok "$sha"
check "a repository holding 19 snapshots still takes the twentieth" \
  '[[ $code == 0 && $output == *"verified backup"* ]] && uploaded'

# Staged by repository state: 31 snapshots and nearly 2 GiB before retention, 5
# snapshots after it. Passing proves the decision reads the repository Restic
# leaves behind; an implementation that measured first would be refused here.
STATS_0='{"total_size":2147483647,"snapshots_count":31}' \
  STATS_1='{"total_size":1024,"snapshots_count":5}' run ok "$sha"
check "mandatory retention brings an over-full repository back under the limits" \
  '[[ $code == 0 && $output == *"verified backup"* && $output == *"5 snapshot"* ]] && uploaded'

run forget-fail "$sha"
check "a failed retention before the upload stops the deploy with nothing uploaded" \
  '[[ $code == 1 && $output == *"retention"* && $output == *"before the upload"* ]] && ! uploaded'

run forget-fail-after "$sha"
check "a failed retention after the verified upload still fails the deploy" \
  '[[ $code == 1 && $output == *"retention"* && $output == *"after the verified upload"* ]] && uploaded && no_dump_left'

STATS_2='{"total_size":1024,"snapshots_count":21}' run ok "$sha"
check "more than 20 snapshots after the upload fails the deploy" \
  '[[ $code == 1 && $output == *"holds 21 snapshot"* ]] && no_dump_left'

STATS_2='{"total_size":1024,"snapshots_count":20}' run ok "$sha"
check "exactly 20 snapshots after the upload is accepted" \
  '[[ $code == 0 && $output == *"verified backup"* ]]'

STATS_2='{"total_size":2147483649,"snapshots_count":3}' run ok "$sha"
check "raw data over 2 GiB after the upload fails the deploy" \
  '[[ $code == 1 && $output == *"2147483649 bytes of raw data"* ]] && no_dump_left'

# Real restic 0.16.4 output for a repository that has only been initialised.
STATS_1='{"total_size":0,"snapshots_count":0}' run ok "$sha"
check "an empty initialised repository takes its first backup" \
  '[[ $code == 0 && $output == *"verified backup"* ]] && uploaded'

# Only a single, unambiguous, plainly non-negative integer of at most 15 digits
# counts as evidence. Anything else stops the deploy with nothing uploaded
# rather than being read as a small number.
untrustworthy=(
  'a failed stats command|EXIT1'
  'no output at all|EMPTY'
  'a missing total_size|{"snapshots_count":3}'
  'a missing snapshots_count|{"total_size":1024}'
  'a non-numeric size|{"total_size":"many","snapshots_count":3}'
  'a negative size|{"total_size":-1,"snapshots_count":3}'
  'a signed size|{"total_size":+1024,"snapshots_count":3}'
  'a fractional size|{"total_size":1.5,"snapshots_count":3}'
  'a size too large to trust|{"total_size":1000000000000000000,"snapshots_count":3}'
  'a zero-padded size|{"total_size":0999,"snapshots_count":3}'
  'a repeated key|{"total_size":1024,"total_size":2147483647,"snapshots_count":3}'
  'an unterminated object|{"total_size":1024,"snapshots_count":3'
  'text that is not JSON|restic: stats unavailable'
  # PR #38 review, finding 1: ambiguous evidence must not quietly resolve to the
  # first readable number. All but the nested case uploaded before the fix.
  'a key repeated with different spacing|{"total_size":0,"total_size" :2147483649,"snapshots_count":3}'
  'a repeated snapshot count|{"total_size":0,"snapshots_count":3,"snapshots_count" :99}'
  'two objects on one line|{"total_size":0}{"snapshots_count":3}'
  'a nested object|{"total_size":{"nested":1},"snapshots_count":3}'
  # PR #38 re-review, finding 1: a duplicate key spelled as a JSON escape, and
  # malformed object contents, are still ambiguous evidence. Counting key text
  # cannot see either, so the whole payload is matched against the shape Restic
  # actually emits.
  'a duplicate key escaped as \u005f|{"total_size":0,"total\u005fsize":2147483649,"snapshots_count":3}'
  'a duplicate count escaped as \u005f|{"total_size":0,"snapshots_count":3,"snapshots\u005fcount":99}'
  'a trailing comma|{"total_size":0,"snapshots_count":3,}'
  'a string value|{"total_size":0,"snapshots_count":3,"note":"x"}'
  'a duplicated unrelated key|{"total_size":0,"total_blob_count":1,"total_blob_count":2,"snapshots_count":3}'
  'a key with a capital letter|{"Total_size":0,"snapshots_count":3}'
  # PR #38 third pass: JSON forbids a leading zero, and the field carrying it
  # need not be one the quota reads for the reply to be malformed.
  'a leading zero in another field|{"total_size":0,"total_blob_count":01,"snapshots_count":3}'
)
untrustworthy+=('two objects|{"total_size":1024,"snapshots_count":3}'$'\n''{"total_size":9,"snapshots_count":1}')
for entry in "${untrustworthy[@]}"; do
  STATS_1="${entry#*|}" run ok "$sha"
  check "${entry%%|*} is not usable quota evidence, so nothing is uploaded" \
    '[[ $code == 1 && $output == *"FAILED: restic "* ]] && ! uploaded && no_dump_left'
done

STATS_1='{"total_size":2147483628,"snapshots_count":3}' run ok "$sha"
check "a quota rejection still deletes the temporary dump and names no secret" \
  'no_dump_left && [[ $output != *test-only* ]]'

# Command failures one at a time (PR #38 review, finding 2).
run backup-fail "$sha"
check "a failed restic backup fails the deploy and reads nothing back" \
  '[[ $code != 0 ]] && ! grep -q "^restic dump" "$work/calls" && no_dump_left'

run dump-exit1 "$sha"
check "a read-back that emits the right bytes but exits non-zero still fails" \
  '[[ $code != 0 && $output != *"verified backup"* ]] && no_dump_left'

STATS_2='{"total_size":1024,"snapshots_count":"three"}' run ok "$sha"
check "untrustworthy evidence after the upload also fails the deploy" \
  '[[ $code == 1 && $output == *"FAILED: restic "* ]] && uploaded && no_dump_left'

STATS_2='{"total_size":2147483648,"snapshots_count":3}' run ok "$sha"
check "exactly 2 GiB of raw data after the upload is accepted" \
  '[[ $code == 0 && $output == *"verified backup"* ]]'

# The reply real Restic 0.16.4 writes must keep working: the grammar above is a
# whitelist, so a case has to fail if it ever narrows past the real thing
# (PR #38 third pass).
STATS_1='{"total_size":2251,"total_uncompressed_size":2344,"compression_ratio":1.0413149711239449,"compression_progress":100,"compression_space_saving":3.967576791808869,"total_blob_count":2,"snapshots_count":1}' run ok "$sha"
check "the populated reply restic 0.16.4 writes, compression fields and all, is accepted" \
  '[[ $code == 0 && $output == *"verified backup"* ]] && uploaded'

STATS_1='{"total_size":0,"compression_space_saving":1e-07,"snapshots_count":3}' run ok "$sha"
check "a float in scientific notation in another field is accepted" \
  '[[ $code == 0 && $output == *"verified backup"* ]] && uploaded'

# One constant per case, each with a scenario that crosses only that limit:
# sourcing stops at the first readonly assignment, so a combined fixture would
# leave the others unproven (PR #38 third pass, finding 2).
write_env
printf 'max_dump_bytes=999999999999\n' >> "$work/backup.env"
DUMP_BYTES=$((100 * 1024 * 1024 + 1)) run ok "$sha"
check "backup.env cannot raise the dump limit" '[[ $code != 0 ]] && ! uploaded && no_dump_left'

write_env
printf 'max_raw_bytes=999999999999\n' >> "$work/backup.env"
STATS_1='{"total_size":2147483628,"snapshots_count":3}' run ok "$sha"
check "backup.env cannot raise the raw-data limit" '[[ $code != 0 ]] && ! uploaded && no_dump_left'

write_env
printf 'max_snapshots=9999\n' >> "$work/backup.env"
STATS_1='{"total_size":1024,"snapshots_count":20}' run ok "$sha"
check "backup.env cannot raise the snapshot limit" '[[ $code != 0 ]] && ! uploaded && no_dump_left'
write_env

# The constants are assigned before anything is read, so an inherited value is
# overwritten rather than honoured, and the real limit still reports itself.
ENV_OVERRIDE="max_dump_bytes=999999999999" DUMP_BYTES=$((100 * 1024 * 1024 + 1)) run ok "$sha"
check "the host environment cannot raise a limit" \
  '[[ $code == 1 && $output == *"104857600 bytes (100 MiB)"* ]] && ! uploaded'

# Remaining single command failures (PR #38 re-review, finding 2).
run dump-fail "$sha"
check "a failed pg_dump stops the deploy before any restic write" \
  '[[ $code != 0 ]] && ! uploaded && ! grep -q "^restic forget" "$work/calls" && no_dump_left'

STATS_2=EXIT1 run ok "$sha"
check "a failed statistics command after the upload fails the deploy and cleans up" \
  '[[ $code == 1 && $output == *"FAILED: restic could not report"* ]] && uploaded && no_dump_left'

# Bash drops NUL bytes when it reads a command's output into a string, which
# would turn an unreadable reply into a plausible one (PR #38 third pass).
STATS_1_RAW='{"total_size":0,\000"snapshots_count":3}\n' run ok "$sha"
check "a reply carrying a NUL byte is not usable quota evidence" \
  '[[ $code == 1 && $output == *"FAILED: restic "* ]] && ! uploaded && no_dump_left'

# --- Complete evidence (issue #39) -----------------------------------------
# Restic 0.16.4 skips a snapshot it cannot load with a warning on stderr, exits
# 0, and reports the rest; when it can load none, the report is exactly the one
# an empty repository gives. Evidence is only usable when it is complete.
refused_before_upload='[[ $code == 1 && $output == *"FAILED: "* && $output != *test-only* ]] && ! uploaded && no_dump_left'
refused_after_upload='[[ $code == 1 && $output == *"FAILED: "* && $output != *"verified backup"* && $output != *test-only* ]] && uploaded && no_dump_left'

WARN="stats:pre" run ok "$sha"
check "statistics that warn before the upload are not usable evidence" "$refused_before_upload"
WARN="stats:post" run ok "$sha"
check "statistics that warn after the upload fail the deploy" "$refused_after_upload"
# Retention reads snapshots through the same iterator, so a skipped snapshot is
# one it neither kept nor removed.
WARN="forget:pre" run ok "$sha"
check "retention that warns before the upload stops the deploy with nothing uploaded" \
  "$refused_before_upload"' && [[ $output == *"before the upload"* ]]'
WARN="forget:post" run ok "$sha"
check "retention that warns after the upload fails the deploy" \
  "$refused_after_upload"' && [[ $output == *"after the verified upload"* ]]'
# Any warning counts, not one particular wording.
WARN="stats:pre forget:post" WARNING="avertissement: instantané illisible" run ok "$sha"
check "a warning in any wording makes statistics unusable" "$refused_before_upload"
WARN="forget:post" WARNING="?" run ok "$sha"
check "a warning in any wording makes retention fail" "$refused_after_upload"

# Nor does completeness rest on a warning being printed at all. `restic list
# snapshots` names the snapshot files without loading them, so a report that
# counts fewer snapshots than the repository holds is incomplete. This is the
# unreadable repository the review found reported as an empty one.
STATS_1='{"total_size":0,"snapshots_count":0}' HIDDEN="list:pre" run ok "$sha"
check "an empty report over a repository that holds a snapshot is not usable evidence" \
  "$refused_before_upload"' && [[ $output == *"1 snapshot file"* && $output == *"counted 0"* ]]'
STATS_1='{"total_size":1024,"snapshots_count":3}' HIDDEN="list:pre" run ok "$sha"
check "a report that counts fewer snapshots than the repository holds is refused before the upload" \
  "$refused_before_upload"
HIDDEN="list:post" run ok "$sha"
check "a report that counts fewer snapshots after the upload fails the deploy" \
  "$refused_after_upload"
STATS_1='{"total_size":0,"snapshots_count":0}' run ok "$sha"
check "a healthy empty repository, with no snapshot file at all, still takes its first backup" \
  '[[ $code == 0 && $output == *"verified backup"* && $output == *"0 snapshot(s)"* ]] && uploaded'
# The snapshot list is evidence too, and held to the same rules.
FAIL="list:pre" run ok "$sha"
check "a snapshot list that exits non-zero after a normal reply is refused before the upload" \
  "$refused_before_upload"
FAIL="list:post" run ok "$sha"
check "a snapshot list that exits non-zero after the upload fails the deploy" "$refused_after_upload"
WARN="list:pre" run ok "$sha"
check "a snapshot list that warns is not usable evidence" "$refused_before_upload"
WARN="list:post" run ok "$sha"
check "a snapshot list that warns after the upload fails the deploy" "$refused_after_upload"
id64="$(printf '%064x' 0xabcdef)"
junk_lists=(
  'a line that is not a snapshot id|not-a-snapshot-id\n'
  'a short id|abc123\n'
  'an id followed by a NUL byte|'"$id64"'\000\n'
  'an id with no final newline|'"$id64"
  'an id in capitals|'"${id64^^}"'\n'
)
for entry in "${junk_lists[@]}"; do
  LIST_JUNK="${entry#*|}" run ok "$sha"
  check "a snapshot list with ${entry%%|*} is not usable evidence" "$refused_before_upload"
done

# Every utility the checks rely on has to succeed, not just print something
# plausible (PR #38 exact-final review, finding 2): each of these does its real
# work, output and all, and then exits 42. The first four uploaded and reported
# a verified backup before issue #39.
validator_failures=(
  'tr|*|the NUL comparison (tr)'
  'wc|-c|the byte count (wc -c)'
  'sort|-u|the unique-key count (sort -u)'
  'sed|*|the number extraction (sed)'
  'wc|-l|a line count (wc -l)'
  'sort||the key listing (sort)'
  'grep|-o -- "[[]*|the key search (grep)'
  'grep|*total_size*|the number search (grep)'
  'cat|*|reading the statistics (cat)'
  'stat|-c %s */snapshots|measuring the snapshot list (stat)'
)
for entry in "${validator_failures[@]}"; do
  IFS='|' read -r tool pattern description <<< "$entry"
  FAIL_TOOL="$tool" FAIL_ARGS="$pattern" run ok "$sha"
  check "a failure in $description after normal output refuses the upload" "$refused_before_upload"
  FAIL_TOOL="$tool" FAIL_ARGS="$pattern" FAIL_PHASE=post run ok "$sha"
  check "a failure in $description after the upload fails the deploy" "$refused_after_upload"
done
# The dump is measured once, before anything is uploaded.
FAIL_TOOL=stat FAIL_ARGS='-c %s */pocketboard.dump' run ok "$sha"
check "a failure measuring the dump (stat) after normal output refuses the upload" "$refused_before_upload"

# Statistics that print a valid reply and then fail were already refused, and
# must stay refused at both stages.
FAIL="stats:pre" run ok "$sha"
check "statistics that exit non-zero after a valid reply are refused before the upload" \
  "$refused_before_upload"
FAIL="stats:post" run ok "$sha"
check "statistics that exit non-zero after a valid reply fail the deploy after the upload" \
  "$refused_after_upload"

# The strict whole-payload parser stays as it was: byte for byte, only the
# compact object Restic 0.16.4 writes, with one LF at most after it.
raw_untrustworthy=(
  'a CRLF line ending|{"total_size":0,"snapshots_count":3}\r\n'
  'a space inside the object|{"total_size": 0,"snapshots_count":3}\n'
  'a pretty-printed object|{\n  "total_size": 0,\n  "snapshots_count": 3\n}\n'
  'an embedded newline|{"total_size":0,\n"snapshots_count":3}\n'
  'a byte-order mark|\357\273\277{"total_size":0,"snapshots_count":3}\n'
  'invalid UTF-8|{"total_size":0,"snapshots_count":3}\377\n'
  'a leading NUL|\000{"total_size":0,"snapshots_count":3}\n'
  'a trailing NUL|{"total_size":0,"snapshots_count":3}\000\n'
  'an exponent in the size|{"total_size":1e3,"snapshots_count":3}\n'
  'a negative zero count|{"total_size":0,"snapshots_count":-0}\n'
  'a size of 16 digits|{"total_size":1000000000000000,"snapshots_count":3}\n'
  'a fractional count|{"total_size":0,"snapshots_count":3.0}\n'
  'an unrelated invalid number|{"total_size":0,"total_blob_count":1.,"snapshots_count":3}\n'
  'an unrelated signed number|{"total_size":0,"total_blob_count":+1,"snapshots_count":3}\n'
)
for entry in "${raw_untrustworthy[@]}"; do
  STATS_1_RAW="${entry#*|}" run ok "$sha"
  check "${entry%%|*} is not usable quota evidence" "$refused_before_upload"
done
STATS_1_RAW='{"total_size":0,"snapshots_count":3}\n' run ok "$sha"
check "the compact reply with its single trailing LF is accepted" \
  '[[ $code == 0 && $output == *"verified backup"* ]] && uploaded'

# Inherited values cannot raise the other two limits either.
ENV_OVERRIDE="max_raw_bytes=999999999999" STATS_1='{"total_size":2147483628,"snapshots_count":3}' run ok "$sha"
check "the host environment cannot raise the raw-data limit" \
  '[[ $code == 1 && $output == *"2147483648 bytes (2 GiB)"* ]] && ! uploaded'
ENV_OVERRIDE="max_snapshots=9999" STATS_1='{"total_size":1024,"snapshots_count":20}' run ok "$sha"
check "the host environment cannot raise the snapshot limit" \
  '[[ $code == 1 && $output == *"limit is 20"* ]] && ! uploaded'

run no-snapshot-id "$sha"
check "an upload that reports no snapshot id fails the deploy and reads nothing back" \
  '[[ $code != 0 && $output != *"verified backup"* ]] && uploaded && ! grep -q "^restic dump" "$work/calls" && no_dump_left'
# --- end quota cases -------------------------------------------------------

write_env 644
run ok "$sha"
check "a group- or world-readable backup.env is refused" \
  '[[ $code == 1 && $output == *"must be owned by uid"* && ! -s "$work/calls" ]]'
write_env

sed -i '/^RESTIC_PASSWORD=/d' "$work/backup.env"
run ok "$sha"
check "a missing required setting is refused" '[[ $code == 1 && $output == *"RESTIC_PASSWORD"* && ! -s "$work/calls" ]]'
write_env

run ok
check "a missing release SHA is refused" '[[ $code == 2 ]]'
run ok "${sha:0:12}"
check "a short release SHA is refused" '[[ $code == 2 ]]'

if (( failures > 0 )); then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
