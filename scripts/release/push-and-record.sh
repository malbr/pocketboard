#!/usr/bin/env bash
# Pushes already-built, already-scanned release images and prints a Markdown
# release record mapping each tag to its commit, registry digest and CI run.
# Every label is checked before the first push, so a mismatched image never
# leaves the runner. Digests are read back from the registry, not from the
# local store, so the record names what GHCR actually serves.
set -euo pipefail

: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${RUN_URL:?RUN_URL is required}"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <image:GITHUB_SHA>..." >&2
  exit 2
fi

for ref in "$@"; do
  if [[ "${ref##*:}" != "$GITHUB_SHA" ]]; then
    echo "refusing '$ref': release images must be tagged with GITHUB_SHA ($GITHUB_SHA)" >&2
    exit 2
  fi
done

for ref in "$@"; do
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ref")"
  if [[ "$revision" != "$GITHUB_SHA" ]]; then
    echo "refusing to push $ref: revision label is '$revision', expected $GITHUB_SHA" >&2
    exit 1
  fi
done

declare -A digests
for ref in "$@"; do
  docker push "$ref" >&2
  digest="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}' | tr -d '"')"
  if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "pushed $ref but got no registry digest ('$digest'); the release is not recorded" >&2
    exit 1
  fi
  digests["$ref"]="$digest"
done

echo "## Release ${GITHUB_SHA}"
echo
echo "- Source commit: https://github.com/malbr/pocketboard/commit/${GITHUB_SHA}"
echo "- Verification run: ${RUN_URL}"
echo "- Checks passed before publish: build-and-test, openapi-drift, secret-scan, codeql, images (Trivy + Compose smoke), and a Trivy rescan of these exact images"
echo
echo "| Image tag | Pinned reference |"
echo "| --- | --- |"
for ref in "$@"; do
  echo "| \`$ref\` | \`${ref%:*}@${digests[$ref]}\` |"
done
