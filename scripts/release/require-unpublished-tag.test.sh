#!/usr/bin/env bash
# Exercises require-unpublished-tag.sh against a fake `docker` so every branch
# of the registry answer is covered without network access or credentials.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/require-unpublished-tag.sh"
sha="0123456789abcdef0123456789abcdef01234567"
failures=0

fake_bin="$(mktemp -d)"
trap 'rm -rf "$fake_bin"' EXIT
cat > "$fake_bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Behaviour is chosen per case through FAKE_DOCKER_MODE.
case "$FAKE_DOCKER_MODE" in
  exists) echo "Name: $4"; exit 0 ;;
  missing) echo "ERROR: ghcr.io/x: not found: manifest unknown" >&2; exit 1 ;;
  denied) echo "ERROR: failed to authorize: 403 Forbidden" >&2; exit 1 ;;
  *) echo "unexpected mode" >&2; exit 99 ;;
esac
FAKE
chmod +x "$fake_bin/docker"

# expect <description> <expected exit> <expected output fragment> <mode> <args...>
expect() {
  local description="$1" want_code="$2" want_text="$3" mode="$4"
  shift 4
  local output code=0
  output="$(PATH="$fake_bin:$PATH" FAKE_DOCKER_MODE="$mode" "$guard" "$@" 2>&1)" || code=$?
  if [[ "$code" != "$want_code" || "$output" != *"$want_text"* ]]; then
    echo "FAIL: $description (exit $code, output: $output)"
    failures=$((failures + 1))
  else
    echo "ok: $description"
  fi
}

expect "absent tag is allowed" 0 "not yet published" missing "ghcr.io/malbr/pocketboard-api:$sha"
expect "existing tag is refused" 1 "already published" exists "ghcr.io/malbr/pocketboard-api:$sha"
expect "unverifiable registry answer fails closed" 1 "could not verify" denied "ghcr.io/malbr/pocketboard-api:$sha"
expect "short SHA tag is refused" 2 "full 40-character" missing "ghcr.io/malbr/pocketboard-api:0123456"
expect "mutable tag is refused" 2 "full 40-character" missing "ghcr.io/malbr/pocketboard-api:latest"
expect "uppercase SHA tag is refused" 2 "full 40-character" missing "ghcr.io/malbr/pocketboard-api:${sha^^}"
expect "digest reference is refused" 2 "full 40-character" missing "ghcr.io/malbr/pocketboard-api@sha256:$sha"
expect "missing argument is refused" 2 "usage" missing

if (( failures > 0 )); then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
