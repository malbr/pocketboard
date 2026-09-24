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

# FAKE_MODE holds one or more space-separated modes, each failing one step.
# After a swap error the script reads the database names once; the swap-*
# modes answer as unchanged names (a rolled-back swap, or one still pending),
# a committed swap whose response was lost, or a server that cannot be asked.
# The *-stalls and swap-hangs modes never answer.
cat > "$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$FAKE_CALLS"
has() { [[ " $FAKE_MODE " == *" $1 "* ]]; }
fail() { has "$1" && exit 1; return 0; }
stall() { has "$1" && exec sleep 30; return 0; }
replaced() { grep -o 'pocketboard_before_restore_[0-9_]*' "$FAKE_CALLS" | head -n 1; }
case "$1" in
  ps)
    fail ps-fails
    case "$*" in
      *service=postgres*) [[ "$FAKE_MODE" == no-db ]] || echo "pgcid" ;;
      *service=api*) fail api-ps-fails; echo "apicid" ;;
      *service=web*) echo "webcid" ;;
    esac ;;
  stop)
    fail stop-fails
    [[ "$2" == apicid ]] && fail api-stop-fails
    # The operator presses Ctrl-C, or the session ends, just after web stopped.
    has interrupted && [[ "$2" == webcid ]] && kill -TERM "$PPID"
    echo "$2" ;;
  start) fail restart-fails; echo "$2" ;;
  exec)
    case "$*" in
      *"pg_restore --list"*) cat > /dev/null; fail bad-toc; echo "; Archive created" ;;
      *pg_restore*) cat > /dev/null; fail restore-fails ;;
      *"CREATE DATABASE"*) fail create-fails ;;
      *"FROM cards"*) fail no-cards; echo 2 ;;
      *__drizzle_migrations*)
        fail no-ledger
        if [[ "$FAKE_MODE" == empty-ledger ]]; then echo "0 "; else echo "2 1726000000000"; fi ;;
      *"RENAME TO"*)
        stall swap-hangs
        [[ "$FAKE_MODE" == swap-* ]] && exit 1
        exit 0 ;;
      # A pending swap has not reached PostgreSQL yet, so no session shows it.
      *pg_stat_activity*) echo 0 ;;
      *"count(*) FROM pg_database"*)
        stall precheck-stalls
        if has name-taken; then echo 1; else echo 0; fi ;;
      *pg_database*)
        stall check-stalls
        fail swap-unknown
        if has swap-lost; then echo "pocketboard $(replaced)"; else echo "pocketboard pocketboard_restore"; fi ;;
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
# Temporary-file cleanup that fails, as on a full or read-only disk.
cat > "$work/bin/rm" <<'FAKE'
#!/usr/bin/env bash
[[ " $FAKE_MODE " == *" cleanup-fails "* ]] && { echo "rm: simulated failure" >&2; exit 1; }
exec /bin/rm "$@"
FAKE
chmod +x "$work/bin/docker" "$work/bin/restic" "$work/bin/rm"

cat > "$work/backup.env" <<'ENV'
RESTIC_REPOSITORY=s3:https://example.r2.cloudflarestorage.com/pocketboard-backups
RESTIC_PASSWORD=test-only-password
AWS_ACCESS_KEY_ID=test-only-id
AWS_SECRET_ACCESS_KEY=test-only-secret
ENV
chmod 600 "$work/backup.env"

# run <mode> [args...]; sets code, output, elapsed (seconds)
run() {
  local mode="$1" started=$SECONDS
  shift
  : > "$work/calls"
  /bin/rm -rf "$work/tmp"
  code=0
  output="$(env -i PATH="$work/bin:/usr/bin:/bin" FAKE_CALLS="$work/calls" FAKE_MODE="$mode" \
    POCKETBOARD_BACKUP_ENV="$work/backup.env" POCKETBOARD_BACKUP_TMP="$work/tmp" \
    RESTIC_CACHE_DIR="$work/cache" POCKETBOARD_EXPECTED_OWNER_UID="$(id -u)" \
    POCKETBOARD_CHECK_TIMEOUT=1 POCKETBOARD_SWAP_TIMEOUT=1 \
    bash "$restore" "$@" 2>&1)" || code=$?
  elapsed=$((SECONDS - started))
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
  'grep -q "BEGIN; ALTER DATABASE pocketboard RENAME TO pocketboard_before_restore_[0-9_]*; ALTER DATABASE pocketboard_restore RENAME TO pocketboard; COMMIT;" "$work/calls"'
check "the local dump is deleted" no_dump_left
check "no secret value reaches the output" '[[ $output != *test-only* ]]'

for mode in no-repo dump-fails bad-dump bad-toc no-db ps-fails create-fails restore-fails no-cards no-ledger empty-ledger \
  name-taken; do
  run "$mode" "$snapshot"
  check "$mode: fails before any rename or application stop" '[[ $code == 1 ]] && ! renamed && ! stopped'
  check "$mode: the local dump is deleted" no_dump_left
done

run stop-fails "$snapshot"
check "a failed application stop never swaps" '[[ $code == 1 ]] && ! renamed'

restarted() { grep -q "^docker start $1\$" "$work/calls"; }

never_restarted() { ! grep -q "^docker start" "$work/calls"; }

# PR #34 review, P1: unchanged names do not prove a rollback. A swap command
# that Docker accepted may still be on its way to PostgreSQL and commit after
# the check. Once the swap has been sent, nothing restarts automatically.
run swap-pending "$snapshot"
check "unchanged names after a swap error never restart the application" \
  '[[ $code == 1 && $output == *"left stopped"* && $output != *"were restarted"* ]] && never_restarted'
check "the output says a delayed swap cannot be ruled out" '[[ $output == *"cannot be ruled out"* ]]'
# PR #34 review: the swap is still pending while nothing shows it, which is
# what the owner would see at every observation. The script must hand the
# decision to the runbook rather than to elapsed time.
check "the output sends the owner to the runbook, not to a restart" \
  '[[ $output == *"runbook"* && $output != *"start the"* ]]'

# PR #33 follow-up review, P1: an error from the swap command does not prove
# the transaction rolled back. PostgreSQL may have committed both renames
# before the response was lost.
run swap-lost "$snapshot"
check "a committed swap whose response was lost is reported as swapped" \
  '[[ $code == 0 && $output == *"swapped"* && $output == *"WARNING"* && $output != *"unchanged"* ]]'
check "a committed swap never restarts the previous application" never_restarted

run swap-unknown "$snapshot"
check "an outcome that cannot be read leaves the application stopped and says so" \
  '[[ $code == 1 && $output == *"could not be established"* ]] && never_restarted'

# PR #34 review, P2: every database call after the application stops has a
# deadline. A stalled call counts as an unknown outcome and never hangs the
# run with the application down.
run "swap-hangs" "$snapshot"
check "a swap command that hangs is cut off and leaves the application stopped" \
  '[[ $code == 1 && $output == *"left stopped"* ]] && (( elapsed < 10 )) && never_restarted'
run "swap-pending check-stalls" "$snapshot"
check "a stalled outcome check is cut off and reported as unknown" \
  '[[ $code == 1 && $output == *"could not be established"* ]] && (( elapsed < 10 )) && never_restarted'
run precheck-stalls "$snapshot"
check "a stalled check before the stop is cut off and stops nothing" \
  '[[ $code == 1 ]] && (( elapsed < 10 )) && ! stopped && ! renamed'

# PR #33 follow-up review, P2: a failure part-way through stopping the
# application must not leave it down, and a failed restart must be reported.
run api-ps-fails "$snapshot"
check "a failed lookup of the second service stops nothing" '[[ $code == 1 ]] && ! stopped && ! renamed'

run api-stop-fails "$snapshot"
check "a failure stopping the second service restarts the first" \
  '[[ $code == 1 && $output == *"restarted webcid"* ]] && restarted webcid && ! renamed'

run interrupted "$snapshot"
check "an interruption after a successful stop restarts what was stopped" \
  '[[ $code != 0 ]] && restarted webcid && ! renamed'

run "api-stop-fails restart-fails" "$snapshot"
check "a failed restart is reported, never claimed as done" \
  '[[ $code == 1 && $output == *"FAILED to restart"*webcid* && $output != *"restarted webcid"* ]]'

# PR #34 review, P3: recovery must not depend on removing the temporary files.
run "api-stop-fails cleanup-fails" "$snapshot"
check "a failed cleanup still restarts what was stopped" '[[ $code == 1 ]] && restarted webcid && ! renamed'

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

# PR #34 review: an accepted Docker execution can stay pending through any
# number of observations, so no observation, name or wait may authorize a
# restart. Only a confirmed committed swap, or a reviewed recovery action,
# lets the application run again.
check "the runbook calls the swap-error observations diagnostics, not proof" \
  '[[ $section == *"cannot prove"* && $section != *"Make sure no swap can still run"* ]]'
check "the runbook keeps an unestablished outcome stopped and escalates" \
  '[[ $section == *"Escalate on issue #8"* && $section == *"Do not restart"* ]]'
check "the runbook never authorizes a restart from names or elapsed time" \
  '[[ $section == *"process absence, database names, or elapsed time"* ]]'

if (( failures > 0 )); then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
