# Production deployment

How a published release reaches the VPS, how it is rolled back, and how the
host is prepared. Publishing is covered in [release artifacts](release.md);
the decision record is [ADR 0006](adr/0006-forced-command-deploy-with-systemd-bridge.md).

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
                      └─ pocketboard-deploy (root)       validates again, then works
```

The workflow takes the digests from the release record of the commit's own
successful CI run on `main`, so it can deploy only images that passed every
check. The root script then:

1. Fetches `compose.production.yml` for that exact commit from GitHub and keeps
   it under `/var/lib/pocketboard/releases/<sha>/`.
2. Pulls both images by `tag@digest` and requires each image's
   `org.opencontainers.image.revision` label to equal the SHA.
3. Starts PostgreSQL if needed and runs `pocketboard-backup`. It dumps the
   database, proves the dump readable with `pg_restore --list`, uploads it with
   Restic to R2, and reads it back to compare SHA-256. No verified backup means
   no migration.
4. Runs the `migrate` service once. Drizzle's ledger skips migrations already
   applied.
5. Starts the release with `docker compose up --wait` and checks
   `127.0.0.1:8080/healthz`, `127.0.0.1:8080/api/health`, and
   `$PUBLIC_URL/api/health` through the TLS proxy.
6. Requires the running `api` and `web` containers to use exactly the pulled
   images, then appends an `ok` line to `/var/lib/pocketboard/releases.log` and
   writes `/var/lib/pocketboard/current`.

Any failure stops the sequence, appends a `failed` line, and leaves `current`
naming the last good release. **Nothing rolls back automatically.**

A rollback (`rollback <sha>`) accepts only a SHA with an `ok` line in the
ledger. It reuses that release's stored compose file and recorded digests,
takes no backup, runs no migration, and never touches the database. This is
safe because CI rejects any migration an older image cannot live with
(`scripts/release/check-migrations.mjs`).

`status` prints the running release, the last ledger lines, and container
health. It is the only standing diagnostic. Anything wider needs its own
temporary, supervised, read-only approval on GitHub.

## Files

| Repository file | Installed as | Owner and mode |
| --- | --- | --- |
| `deploy/vps/ssh-gate` | `/usr/local/lib/pocketboard/ssh-gate` | `root:root 0755` |
| `deploy/vps/pocketboard-deploy` | `/usr/local/sbin/pocketboard-deploy` | `root:root 0700` |
| `deploy/vps/pocketboard-backup` | `/usr/local/sbin/pocketboard-backup` | `root:root 0700` |
| `deploy/vps/config/pocketboard-deploy@.service` | `/etc/systemd/system/pocketboard-deploy@.service` | `root:root 0644` |
| `deploy/vps/config/50-pocketboard-deploy.rules` | `/etc/polkit-1/rules.d/50-pocketboard-deploy.rules` | `root:root 0644` |
| `deploy/vps/config/60-pocketboard-deploy.conf` | `/etc/ssh/sshd_config.d/60-pocketboard-deploy.conf` | `root:root 0644` |
| `deploy/vps/config/deploy.env.example` | `/etc/pocketboard/deploy.env` | `root:root 0644` (no secrets) |
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
install -o root -g root -m 0700 deploy/vps/pocketboard-deploy deploy/vps/pocketboard-backup /usr/local/sbin/
install -o root -g root -m 0644 deploy/vps/config/pocketboard-deploy@.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/vps/config/50-pocketboard-deploy.rules /etc/polkit-1/rules.d/
install -o root -g root -m 0644 deploy/vps/config/60-pocketboard-deploy.conf /etc/ssh/sshd_config.d/
install -o root -g root -m 0644 deploy/vps/config/deploy.env.example /etc/pocketboard/deploy.env
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
| `ssh ... pocketboard-deploy@<host> status` | `no release recorded` |
| `ssh -N -L 5432:127.0.0.1:5432 ...` | forwarding refused |
| `sudo -l -U pocketboard-deploy` (root) | not allowed to run sudo |
| `sudo -u pocketboard-deploy docker ps` (root) | permission denied on the Docker socket |
| `sudo -u pocketboard-deploy systemctl --no-ask-password restart docker` (root) | access denied by polkit |
| `stat -c '%U %a' /etc/pocketboard/backup.env` | `root 600` |

## Deploy, roll back, status

1. Take the release SHA and its digests from the release record of its CI run.
2. In **Actions → Deploy → Run workflow** on `main`, choose the mode and enter
   the SHA.
3. Approve the `production` deployment in GitHub only after the matching
   `issue8-…` gate on the issue is approved. The job log shows the whole VPS run.

The first deploy of an empty host also creates the database and applies every
migration. Rollback targets must be recorded `ok` in the ledger.

## Recovery

- **Deploy failed before migrations:** nothing changed except a possibly
  restarted PostgreSQL. Fix the cause and deploy again.
- **Deploy failed after migrations:** the schema is migrated forward, and that
  is compatible with the previous image by the CI check. Roll back to the SHA
  in `current`, which needs its own approval.
- **Database restore** is a separate, human-approved production-data action.
  As root:
  1. `restic snapshots --tag pre-deploy` to pick the snapshot.
  2. `restic dump <id> /<file> > /var/lib/pocketboard/backup-tmp/restore.dump`.
  3. Stop `api`.
  4. `docker exec -i <postgres> pg_restore --clean --if-exists -U pocketboard -d pocketboard < restore.dump`.
  5. Start `api`.
  6. Delete the dump.

## Evidence for the issue #8 handoff

Post redacted text only:
- the job log lines for image verification, backup (snapshot id, size,
  SHA-256), migration output, health, and `running <sha>`
- `status` output
- the ledger lines
- the access-review table results

Never post secret values, full environment files, or database contents.
