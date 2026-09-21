#!/usr/bin/env bash
# Exercises pocketboard-restore against fake `docker` and `restic`. The PR #33
# re-review found that the copy-and-paste runbook reached both database
# renames and exited zero after a failed restore or verification. Every
# failure before the swap must now exit non-zero with no rename and no
# application stop. restore.test.sh runs the same script against real
# PostgreSQL.
# Assertions are single-quoted on purpose: check() evaluates them after each run.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
restore="$here/../pocketboard-restore"
runbook="$here/../../../docs/deployment.md"
snapshot="5e1f00d1c0ffee5e"
failures=0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# Each mode fails exactly one step.
cat > "$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$FAKE_CALLS"
fail() { [[ "$FAKE_MODE" == "$1" ]] && exit 1; return 0; }
case "$1" in
  ps)
    fail ps-fails
    case "$*" in
      *service=postgres*) [[ "$FAKE_MODE" == no-db ]] || echo "pgcid" ;;
      *service=api*) echo "apicid" ;;
      *service=web*) echo "webcid" ;;
    esac ;;
  stop) fail stop-fails; echo "$2" ;;
  start) echo "$2" ;;
  exec)
    case "$*" in
      *"pg_restore --list"*) cat > /dev/null; fail bad-toc; echo "; Archive created" ;;
      *pg_restore*) cat > /dev/null; fail restore-fails ;;
      *"CREATE DATABASE"*) fail create-fails ;;
      *"FROM cards"*) fail no-cards; echo 2 ;;
      *__drizzle_migrations*)
        fail no-ledger
        if [[ "$FAKE_MODE" == empty-ledger ]]; then echo "0 "; else echo "2 1726000000000"; fi ;;
      *"RENAME TO"*) fail swap-fails ;;
      *psql*) ;;
      *) exit 99 ;;
    esac ;;
  *) exit 99 ;;
esac
FAKE

cat > "$work/bin/restic" <<'FAKE'
#!/usr/bin/env bash
printf 'restic %s\n' "$*" >> "$FAKE_CALLS"
case "$1" in
  cat) [[ "$FAKE_MODE" == no-repo ]] && exit 1; echo '{"version":2}' ;;
  dump)
    [[ "$FAKE_MODE" == dump-fails ]] && exit 1
    if [[ "$FAKE_MODE" == bad-dump ]]; then echo "not a dump"; else printf 'PGDMP fake dump body\n'; fi ;;
  *) exit 99 ;;
esac
FAKE
chmod +x "$work/bin/docker" "$work/bin/restic"

cat > "$work/backup.env" <<'ENV'
RESTIC_REPOSITORY=s3:https://example.r2.cloudflarestorage.com/pocketboard-backups
RESTIC_PASSWORD=test-only-password
AWS_ACCESS_KEY_ID=test-only-id
AWS_SECRET_ACCESS_KEY=test-only-secret
ENV
chmod 600 "$work/backup.env"

# run <mode> [args...]; sets code, output
run() {
  local mode="$1"
  shift
  : > "$work/calls"
  rm -rf "$work/tmp"
  code=0
  output="$(env -i PATH="$work/bin:/usr/bin:/bin" FAKE_CALLS="$work/calls" FAKE_MODE="$mode" \
    POCKETBOARD_BACKUP_ENV="$work/backup.env" POCKETBOARD_BACKUP_TMP="$work/tmp" \
    RESTIC_CACHE_DIR="$work/cache" POCKETBOARD_EXPECTED_OWNER_UID="$(id -u)" \
    bash "$restore" "$@" 2>&1)" || code=$?
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

renamed() { grep -q 'RENAME TO' "$work/calls"; }
stopped() { grep -q '^docker stop' "$work/calls"; }
no_dump_left() { [[ -z "$(find "$work/tmp" -type f 2>/dev/null)" ]]; }
line() { grep -n -m 1 -- "$1" "$work/calls" | cut -d: -f1; }

run ok "$snapshot"
check "a verified restore swaps the databases" '[[ $code == 0 && $output == *"swapped"* ]]'
check "it reports what it verified" '[[ $output == *"2 cards, 2 migrations, last migration when 1726000000000"* ]]'
check "the restore stops at the first error in one transaction" \
  'grep -q "pg_restore -U pocketboard -d pocketboard_restore --exit-on-error --single-transaction --no-owner" "$work/calls"'
check "verification runs before the application stops" '(( $(line __drizzle_migrations) < $(line "docker stop") ))'
check "api and web stop before the swap" '(( $(line "docker stop") < $(line "RENAME TO") ))'
check "both renames run in one transaction" \
  'grep -q "BEGIN; ALTER DATABASE pocketboard RENAME TO pocketboard_before_restore_[0-9TZ]*; ALTER DATABASE pocketboard_restore RENAME TO pocketboard; COMMIT;" "$work/calls"'
check "the local dump is deleted" no_dump_left
check "no secret value reaches the output" '[[ $output != *test-only* ]]'

for mode in no-repo dump-fails bad-dump bad-toc no-db ps-fails create-fails restore-fails no-cards no-ledger empty-ledger; do
  run "$mode" "$snapshot"
  check "$mode: fails before any rename or application stop" '[[ $code == 1 ]] && ! renamed && ! stopped'
  check "$mode: the local dump is deleted" no_dump_left
done

run stop-fails "$snapshot"
check "a failed application stop never swaps" '[[ $code == 1 ]] && ! renamed'

run swap-fails "$snapshot"
check "a failed swap restarts the stopped application and fails" \
  '[[ $code == 1 && $output == *"unchanged"* ]] && grep -q "^docker start apicid" "$work/calls" && grep -q "^docker start webcid" "$work/calls"'

run ok
check "a missing snapshot id is refused" '[[ $code == 2 && ! -s "$work/calls" ]]'
run ok "latest; rm -rf /"
check "a malformed snapshot id is refused" '[[ $code == 2 && ! -s "$work/calls" ]]'

chmod 644 "$work/backup.env"
run ok "$snapshot"
check "a group- or world-readable backup.env is refused" '[[ $code == 1 && ! -s "$work/calls" ]]'
chmod 600 "$work/backup.env"

# The runbook must run this tested script rather than a copyable sequence of
# its own, which is what reached the swap after a failure.
section="$(sed -n '/^## Recovery/,/^## Integration tests/p' "$runbook")"
check "the runbook restores with pocketboard-restore" '[[ $section == *"pocketboard-restore <snapshot id>"* ]]'
check "the runbook has no database rename of its own" '[[ $section != *"RENAME TO"* ]]'

if (( failures > 0 )); then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
