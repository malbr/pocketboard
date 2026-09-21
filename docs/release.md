# Release artifacts

PocketBoard publishes two container images for every commit that reaches
`main`. Publishing is not deploying: nothing in CI touches the VPS. Deployment
is a separate, human-approved step described in [production deployment](deployment.md).

| Image | Contents |
| --- | --- |
| `ghcr.io/malbr/pocketboard-api:<commit SHA>` | Bundled Fastify API on `node:24-alpine`, production dependencies only, runs as `node` |
| `ghcr.io/malbr/pocketboard-web:<commit SHA>` | Built SPA on `nginx-unprivileged` (alpine-slim), proxies `/api/` to the API, runs as uid 101 |

The decision record is [ADR 0005](adr/0005-immutable-commit-sha-release-images.md).

## Tag rules

- The only tag is the full 40-character commit SHA. There is no `latest`,
  branch, or version tag.
- A tag is never pushed twice. `scripts/release/require-unpublished-tag.sh`
  stops the publish if the tag exists, or if GHCR's answer is anything other
  than "not found".
- Deployments reference `tag@digest`, so a tag cannot silently change what runs.

## From tag to source and evidence

For any image `ghcr.io/malbr/pocketboard-<api|web>:<SHA>`:

1. **Source:** the tag is the commit, at
   `https://github.com/malbr/pocketboard/commit/<SHA>`. The image also carries
   `org.opencontainers.image.revision=<SHA>`, which the publish job checks
   before pushing.
2. **Digest and run:** the `publish` job for that commit writes a release record
   to its job summary and to the `release-record-<SHA>` workflow artifact
   (kept 90 days). The record lists each tag, its registry digest, and the run
   URL.
3. **Verification:** the same run's checks on the commit show the evidence:
   `build-and-test`, `openapi-drift`, `secret-scan`, `codeql`, `images`, and
   the Trivy rescan inside `publish` of the exact images pushed.

To re-check a published image yourself:

```sh
docker buildx imagetools inspect ghcr.io/malbr/pocketboard-api:<SHA>
docker pull ghcr.io/malbr/pocketboard-api:<SHA>
docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ghcr.io/malbr/pocketboard-api:<SHA>
```

## What gates a publish

The `publish` job runs only on a push to `main`, and only after every other
job succeeds. Its token has `contents: read` and `packages: write` and nothing
else. Every other job has `contents: read` only.

| Check | Tool | Fails on |
| --- | --- | --- |
| Dependencies (incl. dev) | `npm audit --audit-level=high` | any high or critical advisory |
| Dependency changes in a PR | `actions/dependency-review-action` | a new high or critical advisory |
| Secrets in history | gitleaks (digest-pinned), via `scan-secrets.sh` | any finding, or fewer commits scanned than exist |
| Static analysis | CodeQL `security-extended`, JavaScript/TypeScript and Actions | any result, of any severity |
| Images | Trivy (digest-pinned), via `scan-image.sh` | any fixable high or critical vulnerability, or any embedded secret |
| API contract | `npm run openapi:check` | a generated OpenAPI document that differs from the committed one |
| Migrations | `check-migrations.mjs` | any `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, `RENAME`, column type change, or a new `NOT NULL`, constraint, or unique index on an existing table; a changed column default, or a new column default other than a constant, `now()` or `gen_random_uuid()`; an identifier over 63 bytes; any statement outside a few additive shapes |
| Compose | `check-production-compose.sh` plus a smoke run | a public database port, a non-internal backend, a missing limit or health check, or an unpinned image |

No check has an ignore file, baseline, or allowlist. An exception needs a
separate security-exception approval on GitHub. No workflow can merge,
approve, or dismiss anything.

Accepted risk: `npm audit`, including dev dependencies, reports one moderate
advisory (GHSA-67mh-4wv8-2f99, an esbuild dev-server request/response
disclosure) nested under `drizzle-kit`'s deprecated `@esbuild-kit/*` loader
chain. It never ships in an image, and `drizzle-kit`'s latest release has no
newer dependency chain to move to; the only fix is an unreleased `1.0.0`
pre-release. It is below `--audit-level=high` so it does not fail CI. The
owner accepted this as a permanent-until-superseded risk exception rather
than suppressing it — security-exception gate `issue-31-security-exception-esbuild-kit`,
approved on [issue #31](https://github.com/malbr/pocketboard/issues/31#issuecomment-5733225289).
Revisit once `drizzle-kit` ships a stable `1.0.0` that drops `@esbuild-kit/*`.

## API contract

`packages/api/openapi.json` is generated from the shared Zod contracts by
`packages/api/src/openapi/document.ts`. A unit test fails if that route table
differs from the routes Fastify actually registers, so a new or removed route
cannot go undocumented. After changing a route or contract:

```sh
npm run openapi:generate   # rewrite packages/api/openapi.json
npm run openapi:check      # what CI runs; fails on any difference
```

Commit the regenerated file in the same pull request.

## API image build

The API cannot run from `tsc` output, because of extensionless imports and the
shared package shipping TypeScript source. `npm run build --workspace=packages/api`
therefore bundles `src/server.ts` and `src/db/migrate.ts` with esbuild. Only
`@pocketboard/shared` is inlined; third-party packages stay external and come
from `npm ci --omit=dev`, including any that npm nests under
`packages/api/node_modules`. The runtime image has no npm, bundler, or dev
dependency. Local `npm run dev` and the end-to-end tests still run the source
through `tsx`.

## Reproducibility

Base images are pinned by digest and dependencies come from `package-lock.json`.
`scripts/release/build-image.sh` sets `SOURCE_DATE_EPOCH` to the commit time
and rewrites layer timestamps to it. For both the API and web images, two
cold-cache builds from the same commit produced the same image ID. Build with a
`docker-container` Buildx builder: Docker Desktop's default builder refuses
`rewrite-timestamp` when loading into its image store.

## Production Compose

`compose.production.yml` is the release definition. It deploys nothing by
itself; the approved deploy script supplies `RELEASE_SHA`, `API_DIGEST`,
`WEB_DIGEST`, and `SECRETS_DIR`, and Compose refuses to start without them.

- `postgres` sits only on the `backend` network, which is `internal: true`. It
  publishes no port and stores data on the named volume `pocketboard-postgres`.
- `api` joins `backend` and `frontend`. `frontend` is its only egress path,
  which the GitHub OAuth code exchange needs.
- `web` publishes `127.0.0.1:${WEB_PORT:-8080}` only. A TLS-terminating reverse
  proxy on the host is the public entry point and must set `X-Forwarded-Proto`.
  The API trusts forwarded headers only from the web container's fixed address.
- Every long-running service has a health check, CPU, memory, and PID limits,
  and `no-new-privileges`. `api` and `web` are read-only with all capabilities
  dropped.
- `migrate` is behind a profile and never starts with `up`. The deploy script
  runs it once, after a verified backup:
  `docker compose -f compose.production.yml --profile migrate run --rm migrate`.

### Secret files

`SECRETS_DIR` holds `api.env` (with `DATABASE_URL` and `APP_BASE_URL`),
`postgres-password`, `github-client-id`, `github-client-secret`,
`session-secret`, and `owner-github-user-id`. Compose outside Swarm mounts
secret files with their host ownership and mode, so the API's four files must
be readable by the container user (uid 1000). For example, make them owned by
`root:1000` with mode `0440`. `postgres-password` is read by the entrypoint as
root and can stay `root:root 0400`.

## Recovery

- **Publish failed after one image was pushed:** the retry stops at the tag
  guard. The owner deletes the partial package version in GHCR and re-runs the
  job. No agent deletes packages.
- **First-ever publish:** GHCR creates each package as private. Changing its
  visibility is an owner-only settings change.
- **Bad release:** images are never deployed automatically. Roll back to the
  previous release recorded on the host; see
  [production deployment](deployment.md#recovery).
