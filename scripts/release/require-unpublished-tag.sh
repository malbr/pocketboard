#!/usr/bin/env bash
# Refuses to publish over an existing release tag. Release tags are the full
# commit SHA and are immutable by policy, but GHCR will silently move a tag
# that is pushed twice, so the check has to happen before the push.
#
# Fails closed: only an explicit "not found" from the registry counts as
# absent. Any other failure (auth, rate limit, network) stops the release,
# because treating it as absent could overwrite a published image.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <registry/image:<40-hex commit SHA>>" >&2
  exit 2
fi

ref="$1"
if [[ ! "$ref" =~ ^[a-z0-9./_-]+:[0-9a-f]{40}$ ]]; then
  echo "refusing '$ref': release tags must be the full 40-character lowercase commit SHA" >&2
  exit 2
fi

if output="$(docker buildx imagetools inspect "$ref" 2>&1)"; then
  echo "refusing to publish: $ref is already published" >&2
  exit 1
fi

shopt -s nocasematch
if [[ "$output" == *"not found"* || "$output" == *"manifest unknown"* ]]; then
  echo "$ref is not yet published"
  exit 0
fi

echo "could not verify whether $ref exists; refusing to publish:" >&2
echo "$output" >&2
exit 1
