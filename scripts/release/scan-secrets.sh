#!/usr/bin/env bash
# Scans the full git history for secrets with a digest-pinned gitleaks image.
# gitleaks exits 0 and reports "no leaks found" even when it could not read
# the repository, so this also requires that every non-merge commit reachable
# from any ref was scanned. Merge commits carry no diff of their own.
set -euo pipefail

repo="$(cd "${1:-.}" && pwd)"
image="zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"

expected="$(git -C "$repo" rev-list --no-merges --count --all)"

code=0
output="$(docker run --rm -v "$repo:/repo:ro" "$image" git /repo --redact --no-banner 2>&1)" || code=$?
echo "$output"

if (( code != 0 )); then
  echo "gitleaks reported findings (exit $code); secrets must be rotated and removed, not allow-listed" >&2
  exit 1
fi

# gitleaks colours its log even without a TTY; strip ANSI codes before parsing.
plain="$(sed $'s/\033\\[[0-9;]*m//g' <<< "$output")"
scanned="$(sed -n 's/.*[^0-9]\([0-9][0-9]*\) commits scanned.*/\1/p' <<< "$plain" | tail -1)"
if [[ -z "$scanned" ]]; then
  echo "gitleaks printed no scan summary; refusing to treat the history as clean" >&2
  exit 1
fi
if [[ "$scanned" != "$expected" ]]; then
  echo "gitleaks scanned $scanned of $expected non-merge commits; the history was not fully read" >&2
  exit 1
fi
echo "scanned all $expected non-merge commits; no leaks found"
