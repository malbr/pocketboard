#!/usr/bin/env bash
# Exercises pocketboard-deploy against fake `docker`, `curl`, `systemctl` and
# backup commands. The cases pin the safety order (owner authorization, then
# verified image, then backup, then database changes and migrations, then
# start, then health, then record) and that every failure stops the sequence
# without a silent rollback.
# Assertions are single-quoted on purpose: check() evaluates them after each run.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
deploy="$here/../pocketboard-deploy"
unit="$here/../config/pocketboard-deploy@.service"
sha="0123456789abcdef0123456789abcdef01234567"
old="89abcdef0123456789abcdef0123456789abcdef"
api="$(printf 'a%.0s' {1..64})"
web="$(printf 'b%.0s' {1..64})"
failures=0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

cat > "$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Every call is recorded. FAKE_MODE selects one failure at a time; FAKE_DB is
# the database's state before the run: running, stopped, or absent.
args="$*"
printf 'docker %s\n' "$args" >> "$FAKE_CALLS"
ref="${@: -1}"
case "$1" in
  pull) [[ "$FAKE_MODE" == pull-fails ]] && exit 1; exit 0 ;;
  ps) [[ "$FAKE_DB" == running ]] && echo "pgcid"; exit 0 ;;
  volume) [[ "$FAKE_DB" != absent ]] && echo "pocketboard_pocketboard-postgres"; exit 0 ;;
  image)
    [[ "$FAKE_MODE" == not-local && "$args" == *".Id"* && ! -f "$FAKE_PULLED" ]] && { touch "$FAKE_PULLED"; exit 1; }
    if [[ "$args" == *revision* ]]; then
      rev="${ref#*:}"; rev="${rev%@*}"
      [[ "$FAKE_MODE" == mislabelled ]] && rev="ffffffffffffffffffffffffffffffffffffffff"
      echo "$rev"
    else
      echo "sha256:id-of-${ref##*@sha256:}"
    fi ;;
  inspect)
    # `docker inspect --format {{.Image}} <container>`; containers are named
    # after the digest they run, see `compose ps` below.
    if [[ "$FAKE_MODE" == wrong-image ]]; then echo "sha256:id-of-something-else"; else echo "sha256:id-of-${ref#cid-}"; fi ;;
  compose)
    case "$args" in
      *" config "*) [[ "$FAKE_MODE" == bad-compose ]] && exit 1; exit 0 ;;
      *" run --rm migrate"*) [[ "$FAKE_MODE" == migrate-fails ]] && exit 1; echo "Migrations applied" ;;
      *" up "*) [[ "$FAKE_MODE" == up-fails ]] && exit 1; exit 0 ;;
      *" ps -q api"*) echo "cid-${API_DIGEST#sha256:}" ;;
      *" ps -q web"*) echo "cid-${WEB_DIGEST#sha256:}" ;;
      *" ps "*) echo "api running (healthy)" ;;
      *) exit 99 ;;
    esac ;;
  *) exit 99 ;;
esac
FAKE

cat > "$work/bin/systemctl" <<'FAKE'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$FAKE_CALLS"
[[ "$*" == "is-active --quiet docker.service" && "$FAKE_DOCKER" == active ]]
FAKE

cat > "$work/bin/curl" <<'FAKE'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$FAKE_CALLS"
url="${@: -1}"
out=""
while [[ $# -gt 0 ]]; do [[ "$1" == -o ]] && out="$2"; shift; done
if [[ -n "$out" ]]; then
  [[ "$FAKE_MODE" == fetch-fails ]] && exit 22
  echo "name: pocketboard # fetched from $url" > "$out"
  exit 0
fi
[[ "$FAKE_MODE" == unhealthy && "$url" == https://* ]] && exit 22
case "$url" in
  */healthz) echo ok ;;
  */api/health) echo '{"status":"ok"}' ;;
  *) exit 22 ;;
esac
FAKE

cat > "$work/bin/fake-backup" <<'FAKE'
#!/usr/bin/env bash
printf 'backup %s\n' "$*" >> "$FAKE_CALLS"
[[ "$FAKE_MODE" == backup-fails ]] && { echo "backup: FAILED: simulated"; exit 1; }
echo "backup: verified backup: snapshot 5e1f00d1"
FAKE
chmod +x "$work/bin/"*

auth="$work/authorized-requests"
reset_state() {
  rm -rf "$work/state"
  mkdir -p "$work/state"
  : > "$auth"
  chmod 600 "$auth"
}

future="$(date -u -d '+1 hour' +%FT%TZ)"
# authorize <action> <sha> [api hex] [web hex] [expiry]
authorize() {
  printf '%s %s %s sha256:%s sha256:%s\n' "${5:-$future}" "$1" "$2" "${3:-$api}" "${4:-$web}" >> "$auth"
}

# run <mode> <request>; sets code, output. FAKE_DB and FAKE_DOCKER may be set
# by the caller for one run.
run() {
  : > "$work/calls"
  rm -f "$work/pulled"
  code=0
  output="$(env -i PATH="$work/bin:/usr/bin:/bin" FAKE_CALLS="$work/calls" FAKE_MODE="$1" \
    FAKE_DB="${FAKE_DB:-running}" FAKE_DOCKER="${FAKE_DOCKER:-active}" \
    FAKE_PULLED="$work/pulled" POCKETBOARD_STATE_DIR="$work/state" \
    POCKETBOARD_AUTHORIZATIONS="$auth" POCKETBOARD_EXPECTED_OWNER_UID="$(id -u)" \
    POCKETBOARD_SECRETS_DIR=/etc/pocketboard/secrets POCKETBOARD_BACKUP="$work/bin/fake-backup" \
    POCKETBOARD_HEALTH_ATTEMPTS=2 POCKETBOARD_HEALTH_DELAY=0 INVOCATION_ID=0123456789abcdef0123456789abcdef \
    ${PUBLIC_URL+PUBLIC_URL="$PUBLIC_URL"} bash "$deploy" "$2" 2>&1)" || code=$?
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

called() { grep -q -- "$1" "$work/calls"; }
# Line number of the first call matching $1, or 0.
at() { grep -n -m 1 -- "$1" "$work/calls" | cut -d: -f1 || echo 0; }
ledger() { cat "$work/state/releases.log" 2>/dev/null; }
touched_docker() { grep -q '^docker ' "$work/calls"; }

export PUBLIC_URL="https://pocketboard.dedyn.io"
request="deploy-$sha-$api-$web"

# --- First deploy on an empty host -------------------------------------------
reset_state
authorize deploy "$sha"
FAKE_DB=absent run ok "$request"
check "a first deploy succeeds" '[[ $code == 0 ]]'
check "the unit log starts with this run's invocation id" \
  '[[ "$(head -n 1 <<< "$output")" == "invocation 0123456789abcdef0123456789abcdef" ]]'
check "the compose file is fetched for the exact commit" \
  'called "https://raw.githubusercontent.com/malbr/pocketboard/$sha/compose.production.yml" && [[ -s "$work/state/releases/$sha/compose.production.yml" ]]'
check "images are pulled by tag and digest" \
  'called "pull --quiet ghcr.io/malbr/pocketboard-api:$sha@sha256:$api" && called "pull --quiet ghcr.io/malbr/pocketboard-web:$sha@sha256:$web"'
check "first deploy: verify, create database, back it up, migrate, start, health" '
  (( $(at revision) < $(at "up -d --wait --wait-timeout 120 postgres") &&
     $(at "up -d --wait --wait-timeout 120 postgres") < $(at "backup $sha") &&
     $(at "backup $sha") < $(at "run --rm migrate") &&
     $(at "run --rm migrate") < $(at "up -d --wait --wait-timeout 180 --remove-orphans") &&
     $(at "up -d --wait --wait-timeout 180 --remove-orphans") < $(at "https://pocketboard.dedyn.io/api/health") ))'
check "migrations run exactly once" '[[ $(grep -c "run --rm migrate" "$work/calls") == 1 ]]'
check "the release is recorded as running" \
  '[[ "$(ledger)" =~ deploy\ $sha\ sha256:$api\ sha256:$web\ ok$ && "$(cat "$work/state/current")" == "$sha sha256:$api sha256:$web" ]]'
check "the running image is reported" '[[ $output == *"running $sha"* ]]'

# --- PR #29 review finding 3: backup before any database reconciliation ------
reset_state
authorize deploy "$sha"
FAKE_DB=running run ok "$request"
check "with a live database, the backup comes before any compose up" \
  '[[ $code == 0 ]] && (( $(at "backup $sha") < $(at " up ") ))'
check "the database is reconciled to the new release only after the backup" \
  '(( $(at "backup $sha") < $(at "up -d --wait --wait-timeout 120 postgres") &&
      $(at "up -d --wait --wait-timeout 120 postgres") < $(at "run --rm migrate") ))'

reset_state
authorize deploy "$sha"
FAKE_DB=running run backup-fails "$request"
check "a failed backup of a live database leaves it untouched" \
  '[[ $code == 1 ]] && ! called " up " && ! called migrate && [[ "$(ledger)" == *" failed" ]]'

reset_state
authorize deploy "$sha"
FAKE_DB=stopped run ok "$request"
check "an existing but stopped database is not started from a new definition" \
  '[[ $code == 1 && $output == *"not running"* ]] && ! called " up " && ! called backup'

# --- Redeploys and digests ---------------------------------------------------
reset_state
authorize deploy "$sha"
authorize deploy "$sha" "$api" "$web" "$(date -u -d '+2 hours' +%FT%TZ)"
run ok "$request"
run ok "$request"
check "redeploying the same release reuses the stored compose file" '[[ $code == 0 ]] && ! called raw.githubusercontent.com'

authorize deploy "$sha" "$web" "$api"
run ok "deploy-$sha-$web-$api"
check "a release SHA can never be redeployed with different digests" \
  '[[ $code == 1 && $output == *"different digests"* ]] && ! called pull'

for mode in fetch-fails bad-compose pull-fails mislabelled; do
  reset_state
  authorize deploy "$sha"
  run "$mode" "$request"
  check "$mode stops before the backup and migrations" '[[ $code == 1 ]] && ! called backup && ! called migrate'
done

reset_state
authorize deploy "$sha"
run migrate-fails "$request"
check "a failed migration stops before the new release starts" \
  '[[ $code == 1 ]] && ! called "remove-orphans" && [[ "$(ledger)" == *" failed" ]]'

reset_state
authorize deploy "$old"
authorize deploy "$sha"
run ok "deploy-$old-$api-$web"
run unhealthy "$request"
check "a failed health check is recorded and not rolled back automatically" \
  '[[ $code == 1 && "$(ledger | tail -n 1)" == *"deploy $sha "*" failed" && "$(cat "$work/state/current")" == "$old "* ]]'
check "a failed deploy starts nothing older" '[[ $(grep -c " up " "$work/calls") == 2 ]]'

reset_state
authorize deploy "$sha"
run wrong-image "$request"
check "a container running some other image fails the deploy" '[[ $code == 1 && $output == *"is running"* && ! -f "$work/state/current" ]]'

# --- Rollback ----------------------------------------------------------------
reset_state
authorize deploy "$old"
authorize deploy "$sha"
authorize rollback "$old"
run ok "deploy-$old-$api-$web"
run ok "$request"
run ok "rollback-$old"
check "a rollback to a recorded release succeeds" '[[ $code == 0 && "$(cat "$work/state/current")" == "$old sha256:$api sha256:$web" ]]'
check "a rollback takes no backup and runs no migration" '! called backup && ! called migrate'
check "a rollback uses the stored compose file, not GitHub" '! called raw.githubusercontent.com && called "releases/$old/compose.production.yml"'
check "a rollback checks health and records itself" \
  'called "https://pocketboard.dedyn.io/api/health" && [[ "$(ledger | tail -n 1)" =~ rollback\ $old\ .*\ ok$ ]]'
# PR #29 review finding 3: an application rollback must never recreate or
# downgrade PostgreSQL, whatever the older compose file says about it.
check "a rollback starts only api and web, without dependencies or orphan removal" \
  'called "up -d --wait --wait-timeout 180 --no-deps api web" && ! called postgres && ! called remove-orphans'

authorize rollback "$old" "$api" "$web" "$(date -u -d '+2 hours' +%FT%TZ)"
run not-local "rollback-$old"
check "a rollback pulls an image that is no longer local" '[[ $code == 0 ]] && called "pull --quiet ghcr.io/malbr/pocketboard-api:$old"'

authorize rollback ffffffffffffffffffffffffffffffffffffffff
run ok "rollback-ffffffffffffffffffffffffffffffffffffffff"
check "a rollback to an unrecorded release is refused" '[[ $code == 1 && $output == *"no successful deploy"* ]] && ! called " up "'

reset_state
authorize deploy "$old"
authorize rollback "$old"
run backup-fails "deploy-$old-$api-$web"
run ok "rollback-$old"
check "a rollback to a release that only ever failed is refused" '[[ $code == 1 ]] && ! called " up "'

# --- PR #29 review finding 2: the host enforces owner authorization ----------
unauthorized() { [[ $code == 2 && $output == *"$1"* ]] && ! touched_docker && ! called curl && ! called backup; }

reset_state
run ok "$request"
check "a deploy with no host authorization is refused before any side effect" \
  'unauthorized "not authorized" && [[ ! -e "$work/state/releases" && -z "$(ledger)" ]]'

reset_state
authorize deploy "$sha" "$web" "$api"
run ok "$request"
check "an authorization for other digests does not cover this deploy" 'unauthorized "not authorized"'

reset_state
authorize rollback "$sha"
run ok "$request"
check "a rollback authorization does not cover a deploy" 'unauthorized "not authorized"'

reset_state
authorize deploy "$sha" "$api" "$web" "$(date -u -d '-1 minute' +%FT%TZ)"
run ok "$request"
check "an expired authorization is refused" 'unauthorized "not authorized"'

reset_state
authorize deploy "$sha" "$api" "$web" "$(date -u -d '+8 days' +%FT%TZ)"
run ok "$request"
check "an authorization valid for more than 7 days is refused" 'unauthorized "not authorized"'

reset_state
authorize deploy "$sha"
chmod 666 "$auth"
run ok "$request"
check "an authorization file others can write is refused" 'unauthorized "must be owned by uid"'

reset_state
rm -f "$auth"
run ok "$request"
check "a missing authorization file is refused" 'unauthorized "not authorized"'

reset_state
authorize deploy "$sha"
run ok "$request"
run ok "$request"
check "an authorization is used once; replaying the request is refused" 'unauthorized "already used"'

reset_state
authorize deploy "$old"
authorize deploy "$sha"
authorize rollback "$old" "$web" "$api"
run ok "deploy-$old-$api-$web"
run ok "$request"
run ok "rollback-$old"
check "a rollback authorization must name the digests recorded for that release" 'unauthorized "not authorized"'

reset_state
printf '# comment\n\nnot a valid line\n' >> "$auth"
authorize deploy "$sha"
run ok "$request"
check "comments and malformed lines are ignored, a valid line still authorizes" '[[ $code == 0 ]]'

# --- PR #29 review finding 7: status is read-only ----------------------------
reset_state
authorize deploy "$old"
run ok "deploy-$old-$api-$web"
run ok status
check "status reports the running release without changing anything" \
  '[[ $code == 0 && $output == *"current: $old"* ]] && ! called pull && ! called " up " && ! called backup'

reset_state
run ok status
check "status with nothing deployed says so and writes no state" \
  '[[ $code == 0 && $output == *"no release recorded"* && -z "$(ls -A "$work/state")" ]]'

reset_state
authorize deploy "$old"
run ok "deploy-$old-$api-$web"
FAKE_DOCKER=inactive run ok status
check "status with Docker stopped never calls docker, which could start it" \
  '[[ $code == 0 && $output == *"docker is not running"* ]] && ! touched_docker'

check "the unit does not pull in Docker, so a status request cannot start it" \
  '! grep -Eq "^(Requires|Wants|BindsTo|Requisite)=.*docker" "$unit"'
# Found by the disposable-host test: PrivateTmp's host directory is named
# systemd-private-<boot id>-<unit name>-<suffix>, over 255 bytes for a deploy
# request, and systemd failed every deploy with "File name too long".
check "the unit avoids settings that derive host file names from the long unit name" \
  '! grep -Eq "^(PrivateTmp|RuntimeDirectory|StateDirectory|CacheDirectory|LogsDirectory)=" "$unit"'

reset_state
authorize deploy "$sha"
FAKE_DOCKER=inactive run ok "$request"
check "a deploy with Docker stopped fails without starting it" \
  '[[ $code == 1 && $output == *"docker is not running"* ]] && ! touched_docker && ! called backup'

# --- Concurrency and request validation --------------------------------------
reset_state
authorize deploy "$sha"
exec 8> "$work/state/deploy.lock"
flock 8
run ok "$request"
check "a second concurrent deploy is refused" '[[ $code == 1 && $output == *"another deploy"* ]] && ! called pull'
flock -u 8
exec 8>&-

for bad in "" "deploy-$sha" "deploy-$sha-$api" "rollback-${sha:0:7}" "status;id" "status-$sha" \
  "rollback-$sha-$api" "deploy-${sha^^}-$api-$web" $'status\nid' "../rollback-$sha"; do
  reset_state
  run ok "$bad"
  check "refuses request $(printf '%q' "$bad")" '[[ $code == 2 && ! -s "$work/calls" ]]'
done

unset PUBLIC_URL
reset_state
authorize deploy "$sha"
run ok "$request"
check "deploy needs PUBLIC_URL" '[[ $code == 2 && $output == *PUBLIC_URL* && ! -s "$work/calls" ]]'
PUBLIC_URL="http://pocketboard.dedyn.io" run ok "$request"
check "PUBLIC_URL must be https" '[[ $code == 2 && ! -s "$work/calls" ]]'

if (( failures > 0 )); then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
