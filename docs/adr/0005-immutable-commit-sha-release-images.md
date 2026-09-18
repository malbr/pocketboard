# ADR 0005: Immutable commit-SHA release images

## Status

Accepted

## Date

2026-09-18

## Superseded records

None.

## Context

PocketBoard needs deployable artifacts that can be traced to exact source and
verification evidence, with rollback to any earlier release, no self-hosted
runner, and no standing credentials. GHCR tags are mutable, and scanners can
report success without having scanned anything. Issue #7 required minimal
workflow permissions, approved in
https://github.com/malbr/pocketboard/issues/7#issuecomment-5726512293.

## Decision

- CI publishes one API and one web image per commit on `main`, tagged only with
  the full commit SHA, to GHCR. No other tag is ever pushed, and a publish
  that would overwrite an existing tag fails.
- Deployment references images by `tag@digest`.
- The workflow default token permission is none. Every job gets
  `contents: read`, and only the `publish` job adds `packages: write`. It runs
  on push to `main` after all checks pass and authenticates with
  `GITHUB_TOKEN`. There is no PAT, SARIF upload, OIDC, or attestation
  permission.
- Security checks block directly rather than through dismissible alerts. Every
  scanner wrapper fails closed when it cannot prove that it scanned.
- The publish job rebuilds and rescans the exact images it pushes, and it
  checks each image's revision label against the commit before any push.
- Actions and scanner images are pinned by commit SHA or digest.

## Consequences

- Any running image maps to a commit by its tag and label, and to its checks
  through that commit's CI run.
- A failed partial publish needs an owner to delete the partial package version
  before a retry.
- Build-provenance attestations and code-scanning dashboards are not available
  until a later gate grants `attestations`, `id-token`, or `security-events`
  permissions.
- Pinned bases and scanners need deliberate, reviewed updates. A new CVE in a
  pinned base blocks publishing until the pin moves.
