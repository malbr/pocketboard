#!/usr/bin/env bash
# Real Docker Compose, real PostgreSQL: proves the Compose commands
# pocketboard-deploy relies on keep the database container out of an
# application rollback (PR #29 review, finding 3).
#
# Two releases differ in their PostgreSQL definition. Deploying B recreates
# the database, which is why the deploy backs it up first. Rolling back to A
# with the script's own rollback command must leave B's database container,
# settings and data untouched. The old command (`up --remove-orphans` over
# every service) is run last to reproduce the downgrade it caused.
#
# Needs only Docker with the Compose plugin and the PostgreSQL image pinned in
# compose.production.yml. Nothing here touches a real host.
# Assertions are single-quoted on purpose: check() evaluates them after each run.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

root="$(cd "$(dirname "$0")/../../../.." && pwd)"
deploy_script="$root/deploy/vps/pocketboard-deploy"
pg_image="$(grep -oE 'image: postgres:[^ ]+@sha256:[0-9a-f]{64}' "$root/compose.production.yml" | head -n 1 | cut -d' ' -f2)"
[[ -n "$pg_image" ]] || { echo "no pinned postgres image in compose.production.yml" >&2; exit 1; }
rollback_command="up -d --wait --wait-timeout 180 --no-deps api web"
grep -qF -- "compose $rollback_command" "$deploy_script" \
  || { echo "pocketboard-deploy no longer rolls back with '$rollback_command'; update this test" >&2; exit 1; }

work="$(mktemp -d)"
project="pb-boundary-$$"
failures=0
cleanup() {
  docker compose -p "$project" -f "$work/a.yml" down -v --remove-orphans > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# release <name> <max_connections>: api and web stand in for the application
# images with the same dependency shape as production.
release() {
  cat > "$work/$1.yml" <<EOF
name: $project
services:
  postgres:
    image: $pg_image
    command: ["postgres", "-c", "max_connections=$2"]
    environment:
      POSTGRES_USER: pocketboard
      POSTGRES_DB: pocketboard
      POSTGRES_PASSWORD: throwaway-test-only
    volumes:
      - pocketboard-postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U pocketboard -d pocketboard"]
      interval: 2s
      retries: 30
  api:
    image: $pg_image
    command: ["sleep", "infinity"]
    labels: { release: "$1" }
    healthcheck: { test: ["CMD", "true"], interval: 2s }
    depends_on: { postgres: { condition: service_healthy } }
  web:
    image: $pg_image
    command: ["sleep", "infinity"]
    labels: { release: "$1" }
    healthcheck: { test: ["CMD", "true"], interval: 2s }
    depends_on: { api: { condition: service_healthy } }
volumes:
  pocketboard-postgres:
EOF
}
release a 40
release b 50

compose() { local file="$1"; shift; docker compose -p "$project" -f "$work/$file.yml" "$@"; }
pg_id() { compose a ps -q postgres; }
sql() { docker exec "$(pg_id)" psql -U pocketboard -d pocketboard -tAc "$1"; }
label() { docker inspect --format '{{ index .Config.Labels "release" }}' "$(compose a ps -q "$1")"; }
check() {
  if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1"; failures=$((failures + 1)); fi
}

compose a up -d --wait --wait-timeout 120 > /dev/null 2>&1
sql "CREATE TABLE cards (title text); INSERT INTO cards VALUES ('written under A');" > /dev/null
a_db="$(pg_id)"

# Deploy B the way pocketboard-deploy does after its backup.
compose b up -d --wait --wait-timeout 120 postgres > /dev/null 2>&1
compose b up -d --wait --wait-timeout 180 --remove-orphans > /dev/null 2>&1
b_db="$(pg_id)"
check "deploying a release with a new database definition recreates the database container" \
  '[[ "$b_db" != "$a_db" && "$(sql "SHOW max_connections")" == 50 ]]'
sql "INSERT INTO cards VALUES ('written under B');" > /dev/null
b_started="$(docker inspect --format '{{.State.StartedAt}}' "$b_db")"

# Roll back to A with pocketboard-deploy's command.
# shellcheck disable=SC2086
compose a $rollback_command > /dev/null 2>&1
check "the rollback leaves the database container as it was" \
  '[[ "$(pg_id)" == "$b_db" && "$(docker inspect --format "{{.State.StartedAt}}" "$b_db")" == "$b_started" ]]'
check "the rollback keeps the newer database settings" '[[ "$(sql "SHOW max_connections")" == 50 ]]'
check "the rollback keeps every row" '[[ "$(sql "SELECT count(*) FROM cards")" == 2 ]]'
check "the rollback does replace api and web with release A" '[[ "$(label api)" == a && "$(label web)" == a ]]'

# The command PR #29 used, reproduced: it recreates the database from A.
compose a up -d --wait --wait-timeout 180 --remove-orphans > /dev/null 2>&1
check "counterexample: the old rollback command recreated and downgraded the database" \
  '[[ "$(pg_id)" != "$b_db" && "$(sql "SHOW max_connections")" == 40 ]]'

if (( failures > 0 )); then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
