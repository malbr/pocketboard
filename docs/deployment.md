# Production deployment

How a published release reaches the VPS, how it is rolled back, and how the
host is prepared. Publishing is covered in [release artifacts](release.md);
the decision records are [ADR 0006](adr/0006-forced-command-deploy-with-systemd-bridge.md)
and [ADR 0007](adr/0007-host-authorization-and-database-boundary.md).

Every step here is performed by the human owner or runs only after the
owner's approval on GitHub. Agents hold no VPS credential and never see a
secret value.

## How a deploy works

```text
Actions "Deploy" (dispatched from main)
  └─ waits for the owner's approval on Environment `production`
      └─ ssh pocketboard-deploy@host "deploy <sha> <api digest> <web digest>"
          └─ ssh-gate (forced command, deploy user)       validates, nothing else
              └─ systemctl start pocketboard-deploy@<request>.service
                  └─ polkit: this user may start only that unit family
                      └─ pocketboard-deploy (root)       validates again, checks the
                                                         owner's host authorization,
                                                         then works
```

The workflow takes the digests from the release record of the commit's own
successful CI run on `main`. That is not what protects production, though:
anyone holding the deploy key could send a request over SSH directly. The
root script therefore refuses every `deploy` and `rollback` unless
`/etc/pocketboard/authorized-requests` holds a matching line the owner added
as root: same action, SHA and both digests, unexpired, at most 7 days out, and
not used before. The line is consumed before the first side effect. A refused
request writes no deploy state. See
[Authorizing a deploy or rollback](#authorizing-a-deploy-or-rollback).

For a deploy, the root script then:

1. Fetches `compose.production.yml` for that exact commit from GitHub and keeps
   it under `/var/lib/pocketboard/releases/<sha>/`.
2. Pulls both images by `tag@digest` and requires each image's
   `org.opencontainers.image.revision` label to equal the SHA.
3. Backs up the database before anything can change it. A running database is
   dumped as it runs, found by its Compose labels rather than through the new
   release's compose file. Only a host that has never had a database first
   gets an empty one from the new release, so the backup path is proven there
   too: no PostgreSQL container or volume with the Compose labels, no volume
   named `pocketboard_pocketboard-postgres` (a volume restored by hand has no
   labels), and no `ok` line in the ledger. A Docker lookup that fails refuses
   the deploy. A database that exists but is stopped is refused: the new
   release's definition must not be what starts it. `pocketboard-backup` dumps the
   database, proves the dump readable with `pg_restore --list`, uploads it
   with Restic to R2, and reads it back to compare SHA-256. No verified backup
   means no database change.
4. Applies the release's PostgreSQL definition (`compose up postgres`), which
   may recreate the database container, then runs the `migrate` service once.
   Drizzle's ledger skips migrations already applied.
5. Starts the release with `docker compose up --wait` and checks
   `127.0.0.1:8080/healthz`, `127.0.0.1:8080/api/health`, and
   `$PUBLIC_URL/api/health` through the TLS proxy. `/api/health` answers
   `200 {"status":"ok"}` only after a `select 1` round trip to PostgreSQL, and
   `503 {"status":"unavailable"}` otherwise. The same holds for the API
   container's health check and for Uptime Kuma.
6. Requires the running `api` and `web` containers to use exactly the pulled
   images, then appends an `ok` line to `/var/lib/pocketboard/releases.log` and
   writes `/var/lib/pocketboard/current`.

Any failure stops the sequence, appends a `failed` line, and leaves `current`
naming the last good release. **Nothing rolls back automatically.**

A rollback (`rollback <sha>`) accepts only a SHA with an `ok` line in the
ledger and an authorization line naming the digests recorded there. It reuses
that release's stored compose file and recorded digests, takes no backup, and
runs no migration. It restarts only `api` and `web`
(`compose up --no-deps api web`, no orphan removal), so the database keeps
its current container, settings and schema, whatever the older compose file
says about PostgreSQL. This is safe because CI rejects any migration an older
image cannot live with (`scripts/release/check-migrations.mjs`). That check
accepts only a small set of additive statement shapes, parsed with
PostgreSQL's lexical rules, and rejects everything else, including dynamic
SQL, functions, CTEs, and data changes.

`status` prints the running release, the last ledger lines, and container
health. It needs no authorization and only reads: it creates no state, takes
no lock, and never calls Docker while Docker is stopped, because any Docker
call could start the daemon. The unit has no dependency on `docker.service`
for the same reason, and `deploy` and `rollback` refuse to run while Docker is
stopped. `status` is the only standing diagnostic. Anything wider needs its
own temporary, supervised, read-only approval on GitHub.

The SSH gate prints the unit's log back to the caller only when the log's
first line, `invocation <systemd invocation id>`, changed across its
`systemctl start`. A start that polkit refused therefore reports
`no log from this run`, even straight after a real run of the same request.
The gate handles one request at a time, holding a lock on the log directory
from before the start until it has read the log, so a concurrent request
cannot rewrite the log in between. A request queues for up to 30 minutes,
longer than a deploy may run, so `status` can wait behind a running deploy.

## Files

| Repository file | Installed as | Owner and mode |
| --- | --- | --- |
| `deploy/vps/ssh-gate` | `/usr/local/lib/pocketboard/ssh-gate` | `root:root 0755` |
| `deploy/vps/pocketboard-deploy` | `/usr/local/sbin/pocketboard-deploy` | `root:root 0700` |
| `deploy/vps/pocketboard-backup` | `/usr/local/sbin/pocketboard-backup` | `root:root 0700` |
| `deploy/vps/pocketboard-restore` | `/usr/local/sbin/pocketboard-restore` | `root:root 0700` |
| `deploy/vps/config/pocketboard-deploy@.service` | `/etc/systemd/system/pocketboard-deploy@.service` | `root:root 0644` |
| `deploy/vps/config/50-pocketboard-deploy.rules` | `/etc/polkit-1/rules.d/50-pocketboard-deploy.rules` | `root:root 0644` |
| `deploy/vps/config/60-pocketboard-deploy.conf` | `/etc/ssh/sshd_config.d/60-pocketboard-deploy.conf` | `root:root 0644` |
| `deploy/vps/config/deploy.env.example` | `/etc/pocketboard/deploy.env` | `root:root 0644` (no secrets) |
| `deploy/vps/config/authorized-requests.example` | `/etc/pocketboard/authorized-requests` | `root:root 0600` (no secrets) |
| `deploy/vps/config/backup.env.example` | `/etc/pocketboard/backup.env` | `root:root 0600` |

Application secrets live in `/etc/pocketboard/secrets/` (`root:root 0750`)
with the names and modes in [release artifacts](release.md#secret-files).

## Host installation (owner, once)

Prerequisites: an amd64 host with Docker Engine and the Compose plugin, a
running `polkitd`, and `restic`, `curl` and `flock` installed. You also need a
TLS reverse proxy for the deSEC hostname that forwards to `127.0.0.1:8080` and
sets `X-Forwarded-Proto`.

Install from the approved merge commit, never from a branch:

```sh
git clone https://github.com/malbr/pocketboard.git && cd pocketboard
git checkout <approved merge SHA>

install -d -o root -g root -m 0755 /usr/local/lib/pocketboard /etc/pocketboard \
  /var/lib/pocketboard /var/log/pocketboard-deploy /etc/ssh/authorized_keys
install -d -o root -g root -m 0700 /var/lib/pocketboard/docker \
  /var/lib/pocketboard/backup-tmp /var/cache/pocketboard-restic
install -d -o root -g root -m 0750 /etc/pocketboard/secrets
install -o root -g root -m 0755 deploy/vps/ssh-gate /usr/local/lib/pocketboard/ssh-gate
install -o root -g root -m 0700 deploy/vps/pocketboard-deploy deploy/vps/pocketboard-backup \
  deploy/vps/pocketboard-restore /usr/local/sbin/
install -o root -g root -m 0644 deploy/vps/config/pocketboard-deploy@.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/vps/config/50-pocketboard-deploy.rules /etc/polkit-1/rules.d/
install -o root -g root -m 0644 deploy/vps/config/60-pocketboard-deploy.conf /etc/ssh/sshd_config.d/
install -o root -g root -m 0644 deploy/vps/config/deploy.env.example /etc/pocketboard/deploy.env
install -o root -g root -m 0600 deploy/vps/config/authorized-requests.example /etc/pocketboard/authorized-requests
# edit /etc/pocketboard/deploy.env: PUBLIC_URL=https://<name>.dedyn.io

useradd --system --no-create-home --home-dir /nonexistent --shell /bin/sh pocketboard-deploy
usermod -p '*' pocketboard-deploy   # no password, but not "locked", so key login works
id pocketboard-deploy               # must list no docker or sudo group

systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/pocketboard-deploy@.service
sshd -t && systemctl reload ssh
```

The account needs a real shell because sshd runs the forced command through
it. The `ForceCommand` and `restrict` settings mean it never gets one
interactively.

**Deploy key.** Generate it on your own machine, not on the VPS:

```sh
ssh-keygen -t ed25519 -N '' -C pocketboard-deploy-github -f pocketboard-deploy
```

Put the public half in `/etc/ssh/authorized_keys/pocketboard-deploy`
(`root:root 0644`) as a single line:

```text
restrict,command="/usr/local/lib/pocketboard/ssh-gate" ssh-ed25519 AAAA... pocketboard-deploy-github
```

Paste the private half into the Environment secret below, then delete the
local private key file.

**Secrets and backup.** Create the files in `/etc/pocketboard/secrets/` and
`/etc/pocketboard/backup.env` by hand on the VPS, as approved in
`issue8-secrets-placement` and `issue8-backup-r2`. Keep an off-VPS copy of
`RESTIC_PASSWORD`. Initialise the repository once:

```sh
( set -a; . /etc/pocketboard/backup.env; restic init )
```

**Image pull access.** If the GHCR packages are public, nothing is needed.
If they stay private, log in once as root with a read-only package token, so
the credential stays in root's deploy-only Docker config:

```sh
DOCKER_CONFIG=/var/lib/pocketboard/docker docker login ghcr.io -u malbr
```

**GitHub Environment.** Create `production` in the repository settings:

- Required reviewer: `malbr`. Allow administrators to bypass: off.
- Deployment branches: `main` only.
- Secret: `PRODUCTION_DEPLOY_SSH_KEY`, the private key. This is the only secret.
- Variables:
  - `PRODUCTION_SSH_HOST`
  - `PRODUCTION_SSH_PORT`
  - `PRODUCTION_SSH_KNOWN_HOSTS`: the host's public key line from `ssh-keyscan`, checked against the fingerprint on the VPS. With a port other than 22, the line starts `[host]:port`.

## Access review before the first deploy

Run these from your own machine and as root on the VPS. Every check must give
the stated result.

| Check | Expected |
| --- | --- |
| `ssh -i pocketboard-deploy pocketboard-deploy@<host>` | `refused: allowed requests are ...`, then the connection closes, with no prompt |
| `ssh ... pocketboard-deploy@<host> id` | `refused`, exit 2 |
| `ssh ... pocketboard-deploy@<host> status` | `invocation <id>`, then `no release recorded` |
| `ssh ... pocketboard-deploy@<host> "deploy <sha> sha256:<a> sha256:<b>"` with no authorization line | `refused: ... is not authorized`, and no `/var/lib/pocketboard/releases` |
| `ssh -N -L 5432:127.0.0.1:5432 ...` | forwarding refused |
| `sudo -l -U pocketboard-deploy` (root) | not allowed to run sudo |
| `sudo -u pocketboard-deploy docker ps` (root) | permission denied on the Docker socket |
| `sudo -u pocketboard-deploy systemctl --no-ask-password restart docker` (root) | access denied by polkit |
| `stat -c '%U %a' /etc/pocketboard/backup.env` | `root 600` |

## Deploy, roll back, status

1. Take the release SHA and its digests from the release record of its CI run.
2. After the matching `issue8-…` gate on the issue is approved, add the
   authorization line on the VPS as root (next section).
3. In **Actions → Deploy → Run workflow** on `main`, choose the mode and enter
   the SHA.
4. Approve the `production` deployment in GitHub. The job log shows the whole
   VPS run, including the `authorized by:` line.

The first deploy of an empty host also creates the database and applies every
migration. Rollback targets must be recorded `ok` in the ledger.

### Authorizing a deploy or rollback

The GitHub gate and the Environment approval control the workflow. The line
below is what the host itself checks, so a copied deploy key cannot deploy or
roll back anything the owner has not authorized. It can still use an unused
line first, before the Environment approval (ADR 0007). Add the line just
before approving the `production` deployment, with a short expiry. As root on
the VPS, add one line per approved action to
`/etc/pocketboard/authorized-requests`, using the SHA and digests stated in the
approved gate:

```sh
# deploy: digests from the commit's CI release record
echo "$(date -u -d '+1 day' +%FT%TZ) deploy <sha> sha256:<api> sha256:<web>" >> /etc/pocketboard/authorized-requests
# rollback: digests from that release's ok line in the ledger
grep " <sha> .* ok$" /var/lib/pocketboard/releases.log | tail -n 1
echo "$(date -u -d '+1 day' +%FT%TZ) rollback <sha> sha256:<api> sha256:<web>" >> /etc/pocketboard/authorized-requests
```

The expiry must be a real UTC time in exactly this form, in the future and at
most 7 days away. Each line works
once: the script records it in `/var/lib/pocketboard/authorizations.used`
before its first side effect. A failed run needs a new line with a new expiry,
after a new approval. The file must stay `root`-owned and writable only by
root, or every deploy and rollback is refused.

## Backups

Every deploy takes a pre-deploy snapshot with host `pocketboard`, tags
`pocketboard`, `pre-deploy` and `sha-<release>`, and the single path
`/pocketboard.dump`. Retention runs after each verified backup:
`restic forget --host pocketboard --tag pocketboard --group-by host
--keep-last 5 --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune`.
Grouping by host alone matters: Restic groups by host and path by default, so
a per-run path or grouping by the per-release tag would put every snapshot in
its own group and keep all of them. A retention failure is reported without
failing the deploy, because the verified snapshot already exists.

## Recovery

- **Deploy failed before the backup:** nothing changed. Fix the cause and
  request a new authorization.
- **Deploy failed after the backup:** the database definition may have been
  applied and migrations may have run forward, which the CI check keeps
  compatible with the previous image. Roll back to the SHA in `current`, which
  needs its own approval and authorization line.
- **Database restore** is a separate, human-approved production-data action
  with its own gate. It restores into a new, empty database and swaps it in
  only after verification, because `pg_restore --clean` into the live database
  drops only objects in the dump. With a newer schema, it errors on objects
  that depend on them, carries on by default, and leaves newer objects behind.
  As root:

  ```sh
  ( set -a; . /etc/pocketboard/backup.env; restic snapshots --host pocketboard --tag pocketboard )
  pocketboard-restore <snapshot id>
  ```

  `pocketboard-restore` stops at the first failure. It proves the dump is
  readable, restores it into an empty `pocketboard_restore` database with
  `--exit-on-error --single-transaction`, and requires a readable `cards`
  table and a non-empty Drizzle ledger. Only then does it stop `api` and
  `web` and swap both database names in one transaction, keeping the replaced
  database as `pocketboard_before_restore_<YYYYMMDD_HHMMSS UTC>`. Any earlier
  failure exits non-zero with the live database and the running application
  unchanged. A failure or interruption (Ctrl-C, a closed session) while it
  stops `api` and `web` restarts whatever it had stopped. Each restart that
  fails is named as `FAILED to restart`, so start those by hand.

  Once the swap has been sent, the script never restarts anything itself. An
  error from the swap does not prove it rolled back: PostgreSQL can commit
  after the response is lost, and a command Docker accepted can reach
  PostgreSQL late. The swap has a 120-second deadline. After an error the
  script reads the database names once, with a 10-second deadline:
  - **Committed** (a new `pocketboard_before_restore_*` exists): it prints a
    `WARNING` and continues as a successful swap.
  - **Anything else:** it fails and leaves `api` and `web` stopped. The
    message says either `a delayed swap cannot be ruled out` (the original
    names are still there) or `could not be established`.

  **Steps for a swap error** (as root, with `pg` set to the PostgreSQL
  container id):
  1. Make sure no swap can still run. `docker top "$pg"` must list no `psql`
     process, and
     `docker exec "$pg" psql -U pocketboard -d postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'pocketboard-restore-swap'"`
     must print `0`. Check both again a minute later.
  2. Only then read the names:
     `docker exec "$pg" psql -U pocketboard -d postgres -c 'SELECT datname FROM pg_database'`.
     The names alone prove nothing while a swap could still run.
     - `pocketboard_restore` is still there and no new
       `pocketboard_before_restore_*` exists: the swap did not happen. Start
       the current release again with an authorized rollback to the SHA in
       `current`.
     - A new `pocketboard_before_restore_*` exists and `pocketboard_restore`
       is gone: the swap committed. Continue below.
     - Anything else: stop and raise it on the issue.

  A failed run leaves `pocketboard_restore` for inspection, and the next run
  replaces it.

  The script prints `last migration when <n>`: the `when` of the last
  migration in the dump. Pick the release to start: the newest SHA recorded `ok` in the
  ledger whose `packages/api/migrations/meta/_journal.json` (view it on GitHub
  at that SHA) ends with an entry of exactly that `when`. Start it with an
  authorized `rollback <sha>`, which restarts only `api` and `web`. A newer
  image could expect columns the restored schema lacks. If no recorded
  release matches, stop and raise it on the issue. Drop the
  `pocketboard_before_restore_*` database only after the owner confirms the
  restored data.

## Integration tests

- `deploy/vps/tests/*.test.sh` run the scripts against fakes: request
  grammar, order of operations, authorization, and failure handling.
- `deploy/vps/tests/integration/database-boundary.test.sh` and
  `restore.test.sh` run in CI with real Docker Compose and PostgreSQL. They
  prove that a rollback leaves the database container alone, and that the
  restore script above works against a newer schema and that its failures
  stop before any swap.
- `scripts/release/smoke-production-compose.sh` freezes PostgreSQL under the
  real images and requires `/api/health` to answer 503 throughout, then
  recover.
- `deploy/vps/tests/integration/host.test.sh` needs a disposable host with
  systemd, sshd, polkitd, Docker and Restic. It checks effective sshd
  settings, the SSH → gate → polkit → systemd path, polkit denials,
  unauthorized requests, status with Docker stopped, gate output correlation,
  and Restic retention and restore over real snapshots.
  `run-disposable-host.sh` runs it in a throwaway privileged Ubuntu 24.04
  container. It is not in CI, because that needs Ubuntu packages CI does not
  install today. Never run it on the VPS: it refuses unless
  `POCKETBOARD_DISPOSABLE_HOST=yes`.

## Evidence for the issue #8 handoff

Post redacted text only:
- the job log lines for image verification, backup (snapshot id, size,
  SHA-256), migration output, health, and `running <sha>`
- `status` output
- the ledger lines
- the access-review table results

Never post secret values, full environment files, or database contents.
