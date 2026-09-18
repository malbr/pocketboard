#!/usr/bin/env bash
# Exercises push-and-record.sh with a fake `docker` that logs every call.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/push-and-record.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
sha="0123456789abcdef0123456789abcdef01234567"
api="ghcr.io/malbr/pocketboard-api:$sha"
web="ghcr.io/malbr/pocketboard-web:$sha"

mkdir "$work/bin"
cat > "$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "image inspect")
    ref="${@: -1}"
    if [[ "$FAKE_MODE" == wrong-label && "$ref" == *web* ]]; then echo "ffffffffffffffffffffffffffffffffffffffff"; else echo "$FAKE_SHA"; fi ;;
  "push "*)
    [[ "$FAKE_MODE" == push-fails ]] && { echo "denied" >&2; exit 1; }
    exit 0 ;;
  "buildx imagetools")
    [[ "$FAKE_MODE" == no-digest ]] && { echo '""'; exit 0; }
    if [[ "$*" == *pocketboard-api* ]]; then echo '"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'; else echo '"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"'; fi ;;
  *) echo "unexpected: $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$work/bin/docker"

run() { # run <description> <expected exit> <expected fragment> <mode>
  local output code=0
  : > "$work/log"
  output="$(PATH="$work/bin:$PATH" FAKE_LOG="$work/log" FAKE_MODE="$4" FAKE_SHA="$sha" \
    GITHUB_SHA="$sha" RUN_URL="https://github.com/malbr/pocketboard/actions/runs/1/attempts/1" \
    "$script" "$api" "$web" 2>&1)" || code=$?
  if [[ "$code" != "$2" || "$output" != *"$3"* ]]; then
    echo "FAIL: $1 (exit $code, output: $output)"
    failures=$((failures + 1))
  else
    echo "ok: $1"
  fi
  LAST_OUTPUT="$output"
}

run "records both digests against the commit" 0 "ghcr.io/malbr/pocketboard-api@sha256:aaaa" ok
for fragment in "ghcr.io/malbr/pocketboard-web@sha256:bbbb" "$sha" "actions/runs/1/attempts/1"; do
  if [[ "$LAST_OUTPUT" != *"$fragment"* ]]; then
    echo "FAIL: record is missing $fragment"; failures=$((failures + 1))
  fi
done

run "revision label mismatch fails before any push" 1 "revision label" wrong-label
if grep -q "^push" "$work/log"; then echo "FAIL: pushed despite a label mismatch"; failures=$((failures + 1)); fi

run "push failure fails" 1 "denied" push-fails
run "unreadable registry digest fails" 1 "no registry digest" no-digest
output="$(PATH="$work/bin:$PATH" FAKE_LOG="$work/log" FAKE_MODE=ok FAKE_SHA="$sha" GITHUB_SHA="$sha" RUN_URL=x "$script" "${api%:*}:latest" "$web" 2>&1)" && code=0 || code=$?
if [[ "$code" != 2 || "$output" != *"must be tagged with GITHUB_SHA"* ]]; then echo "FAIL: mutable tag accepted (exit $code)"; failures=$((failures + 1)); else echo "ok: tag that is not the current commit fails"; fi

if (( failures > 0 )); then echo "$failures case(s) failed"; exit 1; fi
echo "all cases passed"
