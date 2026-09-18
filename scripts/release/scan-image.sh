#!/usr/bin/env bash
# Scans a locally built image with a digest-pinned Trivy. Fails on any HIGH or
# CRITICAL vulnerability that has a fix, and on any embedded secret. Trivy
# errors (database download, unreadable image) exit non-zero too, so a scan
# that did not run cannot pass. There is deliberately no ignore file.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <local image reference>" >&2
  exit 2
fi

image="aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"

docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v "${TRIVY_CACHE_DIR:-$HOME/.cache/trivy}:/root/.cache/trivy" \
  "$image" image \
  --scanners vuln,secret \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  --exit-code 1 \
  --no-progress \
  "$1"
