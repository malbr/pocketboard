#!/usr/bin/env bash
# Real PostgreSQL: runs the database restore procedure from
# docs/deployment.md ("Database restore") against a newer schema than the
# dump (PR #29 review, finding 5).
#
# The dump is taken after migrations 0000-0001. Migration 0002 and a newer
# table that references cards are applied afterwards. The old runbook
# (`pg_restore --clean` into the live database) is reproduced first: it
# reports errors, and newer objects survive. The documented procedure then
# restores into a clean database with --exit-on-error --single-transaction,
# verifies rows and the Drizzle migration ledger against the journal, and
# swaps databases. A corrupt dump must fail without touching the live data.
#
# Needs only Docker and the PostgreSQL image pinned in compose.production.yml.
# Assertions are single-quoted on purpose: check() evaluates them after each run.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

root="$(cd "$(dirname "$0")/../../../.." && pwd)"
migrations="$root/packages/api/migrations"
pg_image="$(grep -oE 'image: postgres:[^ ]+@sha256:[0-9a-f]{64}' "$root/compose.production.yml" | head -n 1 | cut -d' ' -f2)"
[[ -n "$pg_image" ]] || { echo "no pinned postgres image in compose.production.yml" >&2; exit 1; }

work="$(mktemp -d)"
pg="pb-restore-$$"
failures=0
cleanup() {
  docker rm -f "$pg" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker run -d --name "$pg" -e POSTGRES_USER=pocketboard -e POSTGRES_DB=pocketboard \
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

# --- The documented procedure ----------------------------------------------
# A corrupt dump first: it must fail and leave the live database alone.
head -c 2000 "$work/restore.dump" > "$work/corrupt.dump"
psql -d postgres -c "DROP DATABASE IF EXISTS pocketboard_restore;" -c "CREATE DATABASE pocketboard_restore TEMPLATE template0;"
corrupt_code=0
docker exec -i "$pg" pg_restore -h 127.0.0.1 -U pocketboard -d pocketboard_restore --exit-on-error \
  --single-transaction --no-owner < "$work/corrupt.dump" > /dev/null 2>&1 || corrupt_code=$?
check "a corrupt dump fails the restore" '(( corrupt_code != 0 ))'
check "a failed restore leaves nothing half-restored in the clean target" \
  '[[ "$(psql -d pocketboard_restore -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = '"'"'public'"'"'")" == 0 ]]'
check "a failed restore leaves the live database untouched" \
  '[[ "$(psql -d pocketboard -tAc "SELECT count(*) FROM cards")" == 3 ]]'

# The real dump into a clean target.
psql -d postgres -c "DROP DATABASE IF EXISTS pocketboard_restore;" -c "CREATE DATABASE pocketboard_restore TEMPLATE template0;"
docker exec -i "$pg" pg_restore -h 127.0.0.1 -U pocketboard -d pocketboard_restore --exit-on-error \
  --single-transaction --no-owner < "$work/restore.dump"
check "the clean restore holds exactly the dumped rows" \
  '[[ "$(psql -d pocketboard_restore -tAc "SELECT count(*) FROM cards")" == 2 ]]'
check "the clean restore has none of the newer objects" \
  '[[ "$(psql -d pocketboard_restore -tAc "SELECT to_regclass('"'"'public.labels'"'"') IS NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '"'"'cards'"'"' AND column_name = '"'"'version'"'"')")" == t ]]'
ledger="$(psql -d pocketboard_restore -tAc "SELECT count(*) || ' ' || max(created_at) FROM drizzle.__drizzle_migrations")"
check "the migration ledger identifies the last applied journal entry (0001)" \
  '[[ "$ledger" == "2 $(journal_when 0001_owner_sessions)" ]]'

# Swap with the application stopped; the old database is kept, renamed.
psql -d postgres -c "ALTER DATABASE pocketboard RENAME TO pocketboard_before_restore;" \
  -c "ALTER DATABASE pocketboard_restore RENAME TO pocketboard;"
check "after the swap the live database is the restored one" \
  '[[ "$(psql -d pocketboard -tAc "SELECT count(*) FROM cards")" == 2 ]]'
check "the replaced database is kept for comparison" \
  '[[ "$(psql -d pocketboard_before_restore -tAc "SELECT count(*) FROM cards")" == 3 ]]'

if (( failures > 0 )); then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
