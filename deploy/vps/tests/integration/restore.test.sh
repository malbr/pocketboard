#!/usr/bin/env bash
# Real PostgreSQL: runs deploy/vps/pocketboard-restore, the script the
# "Database restore" runbook in docs/deployment.md calls, against a newer
# schema than the dump (PR #29 review, finding 5; PR #33 re-review, finding 3).
#
# The dump is taken after migrations 0000-0001. Migration 0002 and a newer
# table that references cards are applied afterwards. The old runbook
# (`pg_restore --clean` into the live database) is reproduced first: it
# reports errors, and newer objects survive. The script must then refuse a
# corrupt dump, a dump whose restore fails part-way, a dump without a Drizzle
# ledger, and a swap that fails half-way, each without renaming the live
# database or leaving the application stopped. A good dump is restored,
# verified and swapped in.
#
# Needs only Docker and the PostgreSQL image pinned in compose.production.yml.
# Restic is replaced by a fake that serves the test's dump files.
# Assertions are single-quoted on purpose: check() evaluates them after each run.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

root="$(cd "$(dirname "$0")/../../../.." && pwd)"
migrations="$root/packages/api/migrations"
pg_image="$(grep -oE 'image: postgres:[^ ]+@sha256:[0-9a-f]{64}' "$root/compose.production.yml" | head -n 1 | cut -d' ' -f2)"
[[ -n "$pg_image" ]] || { echo "no pinned postgres image in compose.production.yml" >&2; exit 1; }

work="$(mktemp -d)"
pg="pb-restore-$$"
api="pb-restore-api-$$"
project="pb-restore-test-$$"
failures=0
cleanup() {
  docker rm -f "$pg" "$api" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker run -d --name "$pg" --label "com.docker.compose.project=$project" \
  --label com.docker.compose.service=postgres -e POSTGRES_USER=pocketboard -e POSTGRES_DB=pocketboard \
  -e POSTGRES_PASSWORD=throwaway-test-only "$pg_image" > /dev/null
for _ in $(seq 60); do
  docker exec "$pg" pg_isready -h 127.0.0.1 -U pocketboard -d pocketboard > /dev/null 2>&1 && break
  sleep 1
done
# pg_isready can pass during the image's init restart; wait for real queries.
for _ in $(seq 30); do
  docker exec "$pg" psql -h 127.0.0.1 -U pocketboard -d pocketboard -c 'select 1' > /dev/null 2>&1 && break
  sleep 1
done

# The same helper the runbook defines: psql inside the database container,
# stopping at the first error.
psql() {
  docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$pg" \
    psql -h 127.0.0.1 -U pocketboard -v ON_ERROR_STOP=1 -q "$@"
}
check() {
  if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1"; failures=$((failures + 1)); fi
}

journal_when() {
  tr -d '[:space:]' < "$migrations/meta/_journal.json" | grep -oE "\"when\":[0-9]+,\"tag\":\"$1\"" | grep -oE '[0-9]+' | head -n 1
}

# Applies one repository migration and records it the way drizzle-orm's
# migrator does: sha256 of the file, and the journal's `when` as created_at.
apply() {
  local tag="$1" when hash
  when="$(journal_when "$tag")"
  hash="$(sha256sum < "$migrations/$tag.sql" | cut -d' ' -f1)"
  psql -d pocketboard < "$migrations/$tag.sql"
  psql -d pocketboard -c "CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('$hash', $when);"
}

apply 0000_parallel_leo
apply 0001_owner_sessions
psql -d pocketboard -c "INSERT INTO cards (title) VALUES ('one'), ('two');"
docker exec "$pg" pg_dump -h 127.0.0.1 -U pocketboard -d pocketboard --format=custom > "$work/restore.dump"

# The release after the dump: one more migration, a newer table that depends
# on cards, and more rows.
apply 0002_card_version
psql -d pocketboard -c "CREATE TABLE labels (card_id uuid REFERENCES cards(id), name text);
  INSERT INTO cards (title) VALUES ('three');
  INSERT INTO labels SELECT id, 'x' FROM cards LIMIT 1;"

# --- Counterexample: the old runbook, on a scratch copy of the live data ----
psql -d postgres -c "CREATE DATABASE old_runbook TEMPLATE pocketboard;"
old_code=0
docker exec -i "$pg" pg_restore -h 127.0.0.1 -U pocketboard --clean --if-exists -d old_runbook \
  < "$work/restore.dump" > "$work/old.log" 2>&1 || old_code=$?
check "counterexample: pg_restore --clean over a newer schema reports errors" '(( old_code != 0 ))'
check "counterexample: newer objects survive, leaving a mixed database" \
  '[[ "$(psql -d old_runbook -tAc "SELECT to_regclass('"'"'public.labels'"'"') IS NOT NULL")" == t ]]'
psql -d postgres -c "DROP DATABASE old_runbook;"

# --- pocketboard-restore ------------------------------------------------------
# A stand-in for the api container, so the tests can see whether the script
# stopped or restarted the application.
docker run -d --name "$api" --label "com.docker.compose.project=$project" \
  --label com.docker.compose.service=api --entrypoint sleep "$pg_image" infinity > /dev/null

real_docker="$(command -v docker)"
mkdir -p "$work/bin"
cat > "$work/bin/restic" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  cat) echo '{"version":2}' ;;
  dump) cat "$FAKE_DUMP" ;;
  *) exit 99 ;;
esac
FAKE
# Passes through to Docker, except for the swap. With SWAP_MODE=hold it first
# opens a session on pocketboard_restore, so the swap's second rename fails
# after its first one succeeded. With SWAP_MODE=lose the swap runs and
# commits, but the script is told it failed, as when the response is lost.
cat > "$work/bin/docker" <<FAKE
#!/usr/bin/env bash
if [[ "\$*" == *"RENAME TO"* ]]; then
  case "\${SWAP_MODE:-}" in
    hold)
      "$real_docker" exec -d "$pg" psql -U pocketboard -d pocketboard_restore -c 'SELECT pg_sleep(10)'
      sleep 2 ;;
    lose)
      "$real_docker" "\$@" > /dev/null 2>&1
      exit 1 ;;
  esac
fi
exec "$real_docker" "\$@"
FAKE
chmod +x "$work/bin/restic" "$work/bin/docker"
printf 'RESTIC_REPOSITORY=test-only\nRESTIC_PASSWORD=test-only\n' > "$work/backup.env"
chmod 600 "$work/backup.env"

# restore <dump file> [hold|lose]; sets code, output
restore() {
  code=0
  output="$(env PATH="$work/bin:$PATH" FAKE_DUMP="$1" SWAP_MODE="${2:-}" \
    POCKETBOARD_BACKUP_ENV="$work/backup.env" POCKETBOARD_BACKUP_TMP="$work/tmp" \
    RESTIC_CACHE_DIR="$work/cache" POCKETBOARD_EXPECTED_OWNER_UID="$(id -u)" \
    POCKETBOARD_COMPOSE_PROJECT="$project" bash "$root/deploy/vps/pocketboard-restore" 5e1f00d1 2>&1)" || code=$?
}
live_cards() { psql -d pocketboard -tAc "SELECT count(*) FROM cards"; }
swapped() { [[ "$(psql -d postgres -tAc "SELECT count(*) FROM pg_database WHERE datname LIKE 'pocketboard_before_restore%'")" != 0 ]]; }
api_running() { [[ "$(docker inspect -f '{{.State.Running}}' "$api")" == true ]]; }
untouched() { (( code != 0 )) && ! swapped && [[ "$(live_cards)" == 3 ]] && api_running; }

head -c 2000 "$work/restore.dump" > "$work/corrupt.dump"
restore "$work/corrupt.dump"
check "a corrupt dump fails with the live database and the application untouched" untouched

# A dump whose restore fails part-way: a grant to a role this cluster lacks.
psql -d postgres -c "CREATE DATABASE partial TEMPLATE pocketboard;"
psql -d postgres -c "CREATE ROLE gone;"
psql -d partial -c "GRANT SELECT ON cards TO gone;"
docker exec "$pg" pg_dump -h 127.0.0.1 -U pocketboard -d partial --format=custom > "$work/partial.dump"
psql -d partial -c "REVOKE SELECT ON cards FROM gone;"
psql -d postgres -c "DROP ROLE gone;" -c "DROP DATABASE partial;"
restore "$work/partial.dump"
check "a restore that fails part-way stops before any swap" 'untouched && [[ $output == *"restore failed"* ]]'
check "the failed restore was rolled back, leaving the clean target empty" \
  '[[ "$(psql -d pocketboard_restore -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = '"'"'public'"'"'")" == 0 ]]'

# A readable dump that fails verification: no Drizzle ledger.
psql -d postgres -c "CREATE DATABASE unmigrated TEMPLATE pocketboard;"
psql -d unmigrated -c "DROP SCHEMA drizzle CASCADE;"
docker exec "$pg" pg_dump -h 127.0.0.1 -U pocketboard -d unmigrated --format=custom > "$work/unmigrated.dump"
psql -d postgres -c "DROP DATABASE unmigrated;"
restore "$work/unmigrated.dump"
check "a dump that fails verification is never swapped in" 'untouched && [[ $output == *"ledger"* ]]'

restore "$work/restore.dump" hold
check "a swap whose second rename fails is shown to have rolled back and restarts the application" \
  'untouched && [[ $output == *"swap failed"* && $output == *"rolled back"* ]] &&[[ "$(psql -d postgres -tAc "SELECT count(*) FROM pg_database WHERE datname = '"'"'pocketboard_restore'"'"'")" == 1 ]]'
psql -d postgres -tAc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'pocketboard_restore'" > /dev/null

restore "$work/restore.dump"
check "a verified restore succeeds" '(( code == 0 )) && [[ $output == *"swapped"* ]]'
check "it reports the dump's last migration" '[[ $output == *"last migration when $(journal_when 0001_owner_sessions)"* ]]'
check "after the swap the live database holds exactly the dumped rows" '[[ "$(live_cards)" == 2 ]]'
check "the live database has none of the newer objects" \
  '[[ "$(psql -d pocketboard -tAc "SELECT to_regclass('"'"'public.labels'"'"') IS NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '"'"'cards'"'"' AND column_name = '"'"'version'"'"')")" == t ]]'
ledger="$(psql -d pocketboard -tAc "SELECT count(*) || ' ' || max(created_at) FROM drizzle.__drizzle_migrations")"
check "the migration ledger identifies the last applied journal entry (0001)" \
  '[[ "$ledger" == "2 $(journal_when 0001_owner_sessions)" ]]'
replaced="$(psql -d postgres -tAc "SELECT datname FROM pg_database WHERE datname LIKE 'pocketboard_before_restore_%'")"
check "the replaced database is kept for comparison" '[[ "$(psql -d "$replaced" -tAc "SELECT count(*) FROM cards")" == 3 ]]'
check "the application is left stopped for an authorized rollback" '! api_running'

# PR #33 follow-up review, P1: the swap commits but its response is lost. The
# script must find the restored database live and must not restart the
# previous application against it.
docker start "$api" > /dev/null
psql -d pocketboard -c "INSERT INTO cards (title) VALUES ('after the first restore');"
sleep 1 # the replaced database's name is per second
restore "$work/restore.dump" lose
check "a committed swap with a lost response is reported as swapped, with a warning" \
  '(( code == 0 )) && [[ $output == *"WARNING"* && $output == *"swapped"* && $output != *"unchanged"* ]]'
check "the restored database is live" '[[ "$(live_cards)" == 2 ]]'
check "the previous application was not restarted against it" '! api_running'

if (( failures > 0 )); then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
