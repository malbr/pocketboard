#!/usr/bin/env bash
# Runs compose.production.yml end to end with locally built images and
# throwaway secrets: database up on the internal network, migrations applied
# once through the `migrate` profile, API healthy behind the web proxy, and no
# database port reachable from the host. Nothing here touches a real host.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <local api image> <local web image>" >&2
  exit 2
fi

api_image="$1"
web_image="$2"
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
project="pocketboard-smoke-$$"
port="${SMOKE_WEB_PORT:-18089}"

export RELEASE_SHA=0123456789abcdef0123456789abcdef01234567
export API_DIGEST="sha256:$(printf '%064d' 0)"
export WEB_DIGEST="sha256:$(printf '%064d' 1)"
export SECRETS_DIR="$work/secrets"
export WEB_PORT="$port"

compose() {
  docker compose -p "$project" -f "$root/compose.production.yml" -f "$work/override.yml" "$@"
}

cleanup() {
  local code=$?
  if (( code != 0 )); then
    compose --profile migrate logs --no-color 2>&1 | tail -80 || true
  fi
  compose --profile migrate down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT

mkdir -p "$SECRETS_DIR"
password="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')"
printf '%s' "$password" > "$SECRETS_DIR/postgres-password"
printf 'DATABASE_URL=postgres://pocketboard:%s@postgres:5432/pocketboard\nAPP_BASE_URL=http://127.0.0.1:%s\n' \
  "$password" "$port" > "$SECRETS_DIR/api.env"
printf '%s' "smoke-client-id" > "$SECRETS_DIR/github-client-id"
printf '%s' "smoke-client-secret" > "$SECRETS_DIR/github-client-secret"
od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$SECRETS_DIR/session-secret"
printf '%s' "1" > "$SECRETS_DIR/owner-github-user-id"
# Compose outside Swarm mounts secret files with host ownership and mode; the
# API runs as uid 1000, so the throwaway files must be world-readable here.
chmod 0444 "$SECRETS_DIR"/*

# Only the image references change; every other production setting is kept.
cat > "$work/override.yml" <<EOF
services:
  api:
    image: $api_image
  web:
    image: $web_image
  migrate:
    image: $api_image
EOF

compose up -d --wait --wait-timeout 180 postgres
compose --profile migrate run --rm migrate
compose up -d --wait --wait-timeout 180

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

[[ "$(curl -fsS "http://127.0.0.1:$port/healthz")" == "ok" ]] || fail "web /healthz"
[[ "$(curl -fsS "http://127.0.0.1:$port/api/health")" == '{"status":"ok"}' ]] || fail "API health through the web proxy"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/cards")"
[[ "$code" == "401" ]] || fail "unauthenticated /api/cards returned $code, expected 401"
curl -fsS "http://127.0.0.1:$port/" | grep -q '<div id="root">' || fail "SPA index"
curl -fsSI "http://127.0.0.1:$port/" | grep -qi '^content-security-policy:' || fail "security headers"

# `compose port` prints ":0" and exits 0 for an unpublished port, so the
# container's actual host bindings are inspected instead.
pg_container="$(compose ps -q postgres)"
[[ -n "$pg_container" ]] || fail "postgres container not found"
bindings="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$pg_container")"
[[ "$bindings" == "{}" || "$bindings" == "null" ]] || fail "postgres publishes host ports: $bindings"

# Prolonged database failure (PR #29 review, finding 4). PostgreSQL is frozen
# for many probe timeouts: health must answer 503 every time, the API must not
# restart, and health must recover once the database returns with at most one
# health connection left open.
api_container="$(compose ps -q api)"
restarts="$(docker inspect --format '{{.RestartCount}}' "$api_container")"
health_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$port/api/health" || true; }
docker pause "$pg_container" > /dev/null
sleep 2 # outlast the cached healthy result
probes=0
outage_end=$((SECONDS + ${SMOKE_DB_OUTAGE_SECONDS:-20}))
while (( SECONDS < outage_end )); do
  code="$(health_code)"
  [[ "$code" == 503 ]] || { docker unpause "$pg_container" > /dev/null; fail "health returned $code while the database was frozen"; }
  probes=$((probes + 1))
done
docker unpause "$pg_container" > /dev/null
recovered=no
for _ in $(seq 30); do
  [[ "$(health_code)" == 200 ]] && { recovered=yes; break; }
  sleep 1
done
[[ "$recovered" == yes ]] || fail "health did not recover after the database returned"
[[ "$(docker inspect --format '{{.RestartCount}}' "$api_container")" == "$restarts" ]] || fail "the API restarted during the outage"
health_connections() {
  docker exec "$pg_container" psql -U pocketboard -d pocketboard -tAc \
    "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'pocketboard-health'"
}
for _ in $(seq 20); do
  (( $(health_connections) <= 1 )) && break
  sleep 1
done
(( $(health_connections) <= 1 )) || fail "$(health_connections) health connections remain open after the outage"
echo "database outage: $probes health probes answered 503; recovered; no restart"

echo "production compose smoke test passed"
