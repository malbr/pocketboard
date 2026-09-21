#!/usr/bin/env bash
# Exercises pocketboard-backup against fake `docker` and `restic`, so the
# verify-before-upload and verify-after-upload rules are covered without a
# database, R2, or credentials.
# Assertions are single-quoted on purpose: check() evaluates them after each run.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
backup="$here/../pocketboard-backup"
sha="0123456789abcdef0123456789abcdef01234567"
failures=0

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
      printf 'PGDMP fake dump body\n'
    elif [[ "$*" == *pg_restore* ]]; then
      cat > /dev/null
      [[ "$FAKE_MODE" == bad-toc ]] && exit 1
      echo "; Archive created"
    fi ;;
  *) exit 99 ;;
esac
FAKE

cat > "$work/bin/restic" <<'FAKE'
#!/usr/bin/env bash
printf 'restic %s\n' "$*" >> "$FAKE_CALLS"
case "$1" in
  cat) [[ "$FAKE_MODE" == no-repo ]] && exit 1; echo '{"version":2}' ;;
  backup)
    cat > "$FAKE_STORE"
    echo '{"message_type":"status","percent_done":1}'
    echo '{"message_type":"summary","snapshot_id":"5e1f00d1c0ffee5e1f00d1c0ffee5e1f00d1c0ffee5e1f00d1c0ffee5e1f00d1","total_bytes_processed":21}' ;;
  dump)
    if [[ "$FAKE_MODE" == corrupt ]]; then echo "different bytes"; else cat "$FAKE_STORE"; fi ;;
  forget) echo "applying policy" ;;
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
  code=0
  output="$(env -i PATH="$work/bin:/usr/bin:/bin" FAKE_CALLS="$work/calls" FAKE_STORE="$work/store" \
    FAKE_MODE="$mode" POCKETBOARD_BACKUP_ENV="$work/backup.env" POCKETBOARD_BACKUP_TMP="$work/tmp" \
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

write_env
run ok "$sha"
check "a verified backup succeeds" '[[ $code == 0 && $output == *"verified backup"* && $output == *"snapshot 5e1f00d1"* ]]'
# Restic groups retention by host and paths by default, so a per-run file name
# put every snapshot in its own group and kept all of them (PR #29 review,
# finding 6). The path is stable and the release lives only in a tag.
check "the dump is streamed to restic under one stable path, tagged with the release" \
  'grep -q -- "--stdin --stdin-filename pocketboard.dump\$" "$work/calls" && grep -q -- "--tag sha-$sha" "$work/calls"'
check "the uploaded snapshot is read back from that path" 'grep -q "^restic dump 5e1f00d1[0-9a-f]* /pocketboard.dump$" "$work/calls"'
check "retention runs after the verified upload" 'grep -q -- "^restic forget .*--keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune" "$work/calls"'
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
