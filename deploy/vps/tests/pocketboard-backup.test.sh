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

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

cat > "$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$FAKE_CALLS"
case "$1" in
  ps) [[ "$FAKE_MODE" == no-db ]] || echo "pgcid" ;;
  exec)
    if [[ "$*" == *pg_dump* ]]; then
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
cat > "$work/bin/restic" <<'FAKE'
#!/usr/bin/env bash
printf 'restic %s\n' "$*" >> "$FAKE_CALLS"
case "$1" in
  cat) [[ "$FAKE_MODE" == no-repo ]] && exit 1; echo '{"version":2}' ;;
  stats)
    stage=0
    grep -q '^restic forget' "$FAKE_CALLS" && stage=1
    grep -q '^restic backup' "$FAKE_CALLS" && stage=2
    for candidate in "$stage" 1 0; do
      [[ -f "$FAKE_STATS.$candidate" ]] && { body="$(cat "$FAKE_STATS.$candidate")"; break; }
    done
    [[ "$body" == EMPTY ]] && { printf ""; exit 0; }
    [[ "$body" == EXIT1 ]] && exit 1
    printf '%s\n' "$body" ;;
  backup)
    [[ "$FAKE_MODE" == backup-fail ]] && exit 1
    cat > "$FAKE_STORE"
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
  code=0
  output="$(env -i PATH="$work/bin:/usr/bin:/bin" FAKE_CALLS="$work/calls" FAKE_STORE="$work/store" \
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
    s/^restic stats.*/stats/; s/^restic forget.*/retain/;
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
  '[[ "$(sequence)" == repo,find-db,dump,verify-dump,retain,stats,upload,read-back,retain,stats ]]'
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
  '[[ $code == 1 && $output == *"retention"* && $output == *"after the verified upload"* ]] && uploaded'

STATS_2='{"total_size":1024,"snapshots_count":21}' run ok "$sha"
check "more than 20 snapshots after the upload fails the deploy" \
  '[[ $code == 1 && $output == *"holds 21 snapshot"* ]]'

STATS_2='{"total_size":1024,"snapshots_count":20}' run ok "$sha"
check "exactly 20 snapshots after the upload is accepted" \
  '[[ $code == 0 && $output == *"verified backup"* ]]'

STATS_2='{"total_size":2147483649,"snapshots_count":3}' run ok "$sha"
check "raw data over 2 GiB after the upload fails the deploy" \
  '[[ $code == 1 && $output == *"2147483649 bytes of raw data"* ]]'

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
)
untrustworthy+=('two objects|{"total_size":1024,"snapshots_count":3}'$'\n''{"total_size":9,"snapshots_count":1}')
for entry in "${untrustworthy[@]}"; do
  STATS_1="${entry#*|}" run ok "$sha"
  check "${entry%%|*} is not usable quota evidence, so nothing is uploaded" \
    '[[ $code == 1 && $output == *"FAILED: restic "* ]] && ! uploaded'
done

STATS_1='{"total_size":2147483628,"snapshots_count":3}' run ok "$sha"
check "a quota rejection still deletes the temporary dump and names no secret" \
  'no_dump_left && [[ $output != *test-only* ]]'

# Command failures one at a time (PR #38 review, finding 2).
run backup-fail "$sha"
check "a failed restic backup fails the deploy and reads nothing back" \
  '[[ $code != 0 ]] && ! grep -q "^restic dump" "$work/calls"'

run dump-exit1 "$sha"
check "a read-back that emits the right bytes but exits non-zero still fails" \
  '[[ $code != 0 && $output != *"verified backup"* ]]'

STATS_2='{"total_size":1024,"snapshots_count":"three"}' run ok "$sha"
check "untrustworthy evidence after the upload also fails the deploy" \
  '[[ $code == 1 && $output == *"FAILED: restic "* ]] && uploaded'

STATS_2='{"total_size":2147483648,"snapshots_count":3}' run ok "$sha"
check "exactly 2 GiB of raw data after the upload is accepted" \
  '[[ $code == 0 && $output == *"verified backup"* ]]'
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
