#!/usr/bin/env bash
# Asserts the production Compose invariants from issue #7 on the file as
# Compose itself resolves it, so anchors, merges and interpolation are applied.
set -euo pipefail

file="${1:-compose.production.yml}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Placeholder values only: they make interpolation succeed and are never used.
for secret in api.env postgres-password github-client-id github-client-secret \
  session-secret owner-github-user-id; do
  : > "$work/$secret"
done

RELEASE_SHA=0123456789abcdef0123456789abcdef01234567 \
API_DIGEST="sha256:$(printf '%064d' 0)" \
WEB_DIGEST="sha256:$(printf '%064d' 1)" \
SECRETS_DIR="$work" \
  docker compose -f "$file" --profile migrate config --format json > "$work/resolved.json"

node - "$work/resolved.json" <<'NODE'
const config = require(process.argv[2]);
const services = config.services;
const problems = [];
const longRunning = ["postgres", "api", "web"];

for (const name of [...longRunning, "migrate"]) {
  if (!services[name]) problems.push(`${name} service is missing`);
}

if (services.postgres?.ports?.length) problems.push("postgres publishes ports");
if (config.networks?.backend?.internal !== true) problems.push("backend network is not internal");
if (Object.keys(services.postgres?.networks ?? {}).join() !== "backend") {
  problems.push("postgres is attached to a network other than backend");
}
const pgData = (services.postgres?.volumes ?? []).find((v) => v.target === "/var/lib/postgresql/data");
if (pgData?.type !== "volume") problems.push("postgres data is not on a named volume");

for (const port of services.web?.ports ?? []) {
  if (port.host_ip !== "127.0.0.1") problems.push("web port is not loopback-only");
}
for (const name of ["api", "migrate"]) {
  if (services[name]?.ports?.length) problems.push(`${name} publishes ports`);
}

const releaseImage = /^ghcr\.io\/malbr\/pocketboard-(api|web):([^@]+)@sha256:[0-9a-f]{64}$/;
for (const [name, service] of Object.entries(services)) {
  const image = service.image ?? "";
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) problems.push(`${name} image ${image} is not pinned by digest`);
  if (image.startsWith("ghcr.io/malbr/pocketboard-")) {
    const match = releaseImage.exec(image);
    if (!match || !/^[0-9a-f]{40}$/.test(match[2])) problems.push(`${name} image ${image} is not a commit-SHA tag`);
  }
}

for (const name of longRunning) {
  const service = services[name] ?? {};
  const limits = service.deploy?.resources?.limits ?? {};
  if (!limits.memory) problems.push(`${name} has no memory limit`);
  if (!limits.cpus) problems.push(`${name} has no cpu limit`);
  if (!service.healthcheck?.test) problems.push(`${name} has no health check`);
}

if (problems.length) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}
console.log("production compose invariants hold");
NODE
