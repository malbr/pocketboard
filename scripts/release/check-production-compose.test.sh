#!/usr/bin/env bash
# Runs check-production-compose.sh against the real production file and
# against deliberately broken copies, so each invariant is shown to fail.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
check="$here/check-production-compose.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

run() { # run <description> <expected exit> <expected output fragment> <compose file>
  local output code=0
  output="$("$check" "$4" 2>&1)" || code=$?
  if [[ "$code" != "$2" || "$output" != *"$3"* ]]; then
    echo "FAIL: $1 (exit $code, output: $output)"
    failures=$((failures + 1))
  else
    echo "ok: $1"
  fi
}

mutate() { # mutate <name> <sed expression>
  sed -e "$2" "$root/compose.production.yml" > "$work/$1.yml"
  echo "$work/$1.yml"
}

run "production file passes" 0 "production compose invariants hold" "$root/compose.production.yml"
run "public database port fails" 1 "postgres publishes ports" \
  "$(mutate db-port 's#^    \# Deliberately no `ports`.*#    ports: ["5432:5432"]#')"
run "non-internal backend fails" 1 "backend network is not internal" \
  "$(mutate backend 's#^    internal: true#    internal: false#')"
run "web bound to all interfaces fails" 1 "web port is not loopback-only" \
  "$(mutate web-port 's#"127.0.0.1:\${WEB_PORT:-8080}:8080"#"8080:8080"#')"
run "image without digest fails" 1 "is not pinned by digest" \
  "$(mutate digest 's#@\${WEB_DIGEST:?set WEB_DIGEST}##')"
run "mutable tag fails" 1 "is not a commit-SHA tag" \
  "$(mutate tag 's#pocketboard-web:\${RELEASE_SHA:?set RELEASE_SHA}#pocketboard-web:latest#')"
run "missing memory limit fails" 1 "web has no memory limit" \
  "$(mutate limit '/memory: 128M/d')"
run "missing volume fails" 1 "postgres data is not on a named volume" \
  "$(mutate volume 's#- pocketboard-postgres:/var/lib/postgresql/data#- /tmp/pg:/var/lib/postgresql/data#')"

if (( failures > 0 )); then echo "$failures case(s) failed"; exit 1; fi
echo "all cases passed"
