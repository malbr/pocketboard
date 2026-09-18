#!/usr/bin/env bash
# Builds one release image into the local Docker image store. Used by both the
# pull-request image job and the publish job so the scanned image and the
# published image come from the same recipe.
#
# SOURCE_DATE_EPOCH is the commit time, and rewrite-timestamp normalises file
# and layer timestamps to it, so a rebuild of the same commit does not differ
# merely because it ran later.
set -euo pipefail

if [[ $# -ne 2 || ! "$1" =~ ^(api|web)$ ]]; then
  echo "usage: $0 <api|web> <image reference>" >&2
  exit 2
fi

component="$1"
ref="$2"
commit="$(git rev-parse HEAD)"
epoch="$(git log -1 --format=%ct "$commit")"

SOURCE_DATE_EPOCH="$epoch" docker buildx build \
  --file "packages/$component/Dockerfile" \
  --build-arg SOURCE_COMMIT="$commit" \
  --build-arg SOURCE_DATE_EPOCH="$epoch" \
  --provenance=false \
  --output "type=docker,name=$ref,rewrite-timestamp=true" \
  .
