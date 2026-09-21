#!/usr/bin/env bash
# Privileged integration test for a DISPOSABLE Linux host (issue #8, PR #29
# review). It installs the VPS files the way docs/deployment.md does, creates
# the deploy account with a throwaway key, and exercises the real sshd, polkit,
# systemd, Docker, PostgreSQL and Restic:
#
#   - effective sshd settings for the deploy account (sshd -T)
#   - SSH -> ssh-gate -> polkit -> systemd unit -> root script, end to end
#   - refused commands, TTY and port forwarding; polkit denials
#   - status with Docker stopped does not start it (finding 7), and the old
#     unit's Requires=docker.service did (counterexample)
#   - gate output correlation when polkit refuses a retry straight after a
#     real run (finding 8)
#   - an unauthorized deploy is refused before any state is written (finding 2)
#   - Restic retention over many real snapshots, and restoring the newest one
#     with pocketboard-restore (findings 5 and 6; PR #33 re-review finding 3)
#   - concurrent SSH requests each get their own run's log (PR #33 re-review
#     finding 7)
#
# It creates a user, rewrites sshd and polkit configuration, and stops Docker,
# so it refuses to run unless POCKETBOARD_DISPOSABLE_HOST=yes. Run it through
# run-disposable-host.sh, or on a throwaway VM as described in
# docs/deployment.md. Never run it on the production VPS.
#
# Usage (root): POCKETBOARD_DISPOSABLE_HOST=yes host.test.sh <repository root> <postgres image>
# Assertions are single-quoted on purpose: check() evaluates them after each run.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

[[ "${POCKETBOARD_DISPOSABLE_HOST:-}" == yes ]] || { echo "refusing: set POCKETBOARD_DISPOSABLE_HOST=yes on a disposable host only" >&2; exit 2; }
[[ $(id -u) == 0 && -d /run/systemd/system ]] || { echo "needs root on a systemd host" >&2; exit 2; }
[[ $# -eq 2 ]] || { echo "usage: $0 <repository root> <postgres image>" >&2; exit 2; }
repo="$1"
pg_image="$2"
cd "$repo"

failures=0
check() {
  if eval "$2"; then echo "ok: $1"; else echo "FAIL: $1 (exit ${code:-}, output: ${output:-})"; failures=$((failures + 1)); fi
}
sha="0123456789abcdef0123456789abcdef01234567"
digest_a="sha256:$(printf 'a%.0s' {1..64})"
digest_b="sha256:$(printf 'b%.0s' {1..64})"

# --- Install, as in docs/deployment.md --------------------------------------
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
sed -i 's#^PUBLIC_URL=.*#PUBLIC_URL=https://pocketboard.invalid#' /etc/pocketboard/deploy.env

id pocketboard-deploy > /dev/null 2>&1 \
  || useradd --system --no-create-home --home-dir /nonexistent --shell /bin/sh pocketboard-deploy
usermod -p '*' pocketboard-deploy

systemctl daemon-reload
check "systemd-analyze verify accepts the unit" \
  'systemd-analyze verify /etc/systemd/system/pocketboard-deploy@.service'

# A throwaway key that exists only on this disposable host.
key="$(mktemp -d)/key"
ssh-keygen -q -t ed25519 -N '' -C disposable-test -f "$key"
printf 'restrict,command="/usr/local/lib/pocketboard/ssh-gate" %s\n' "$(cat "$key.pub")" \
  > /etc/ssh/authorized_keys/pocketboard-deploy
chmod 0644 /etc/ssh/authorized_keys/pocketboard-deploy
mkdir -p /run/sshd
sshd -t
systemctl restart ssh
for _ in $(seq 20); do ssh-keyscan -T 2 127.0.0.1 > "$key.known" 2> /dev/null && [[ -s "$key.known" ]] && break; sleep 1; done
deploy_ssh() {
  ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$key.known" -o ConnectTimeout=10 pocketboard-deploy@127.0.0.1 "$@"
}
ssh_run() { code=0; output="$(deploy_ssh "$@" 2>&1)" || code=$?; }

# --- sshd --------------------------------------------------------------------
effective="$(sshd -T -C user=pocketboard-deploy,host=localhost,addr=127.0.0.1)"
for setting in "forcecommand /usr/local/lib/pocketboard/ssh-gate" "permittty no" "allowtcpforwarding no" \
  "allowagentforwarding no" "allowstreamlocalforwarding no" "x11forwarding no" "permittunnel no" \
  "permituserrc no" "passwordauthentication no" "kbdinteractiveauthentication no" \
  "authenticationmethods publickey" "authorizedkeysfile /etc/ssh/authorized_keys/%u" "permitopen none"; do
  check "effective sshd setting for the deploy account: $setting" 'grep -qx -- "$setting" <<< "$effective"'
done

# --- End to end through SSH, polkit and systemd -----------------------------
ssh_run status
check "status over SSH runs the unit through polkit and returns its log" \
  '[[ $code == 0 && $output =~ invocation\ [0-9a-f]{32} && $output == *"no release recorded"* ]]'
check "status wrote no deploy state" '[[ -z "$(ls -A /var/lib/pocketboard | grep -v -e docker -e backup-tmp)" ]]'

ssh_run id
check "any other command is refused" '[[ $code == 2 && $output == *refused* ]]'
ssh_run
check "a login without a command is refused" '[[ $code == 2 && $output == *refused* ]]'
# sshd refuses a local forward only when a connection uses it, so one is made
# through the tunnel to this host's own sshd: a working forward would return
# its "SSH-2.0" banner.
ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$key.known" -N -L 15432:127.0.0.1:22 pocketboard-deploy@127.0.0.1 > /dev/null 2>&1 &
tunnel=$!
sleep 3
banner="$(timeout 5 bash -c 'exec 3<> /dev/tcp/127.0.0.1/15432 && head -c 7 <&3' 2> /dev/null || true)"
kill "$tunnel" 2> /dev/null || true
wait "$tunnel" 2> /dev/null || true
code="" output="$banner"
check "port forwarding is refused" '[[ "$banner" != SSH-2.0 ]] && journalctl --no-pager | grep -q "refused local port forward"'

as_deploy() { code=0; output="$(runuser -u pocketboard-deploy -- "$@" 2>&1)" || code=$?; }
as_deploy systemctl --no-ask-password restart docker.service
check "polkit refuses the deploy account a Docker restart" '[[ $code != 0 ]]'
as_deploy systemctl --no-ask-password start pocketboard-deploy@anything.service
check "polkit refuses an instance outside the request grammar" '[[ $code != 0 ]]'
as_deploy systemctl --no-ask-password stop pocketboard-deploy@status.service
check "polkit refuses any verb but start" '[[ $code != 0 ]]'
as_deploy docker ps
check "the deploy account cannot use the Docker socket" '[[ $code != 0 ]]'
check "the deploy account has no sudo and no docker group" \
  '! id -nG pocketboard-deploy | grep -qwE "sudo|docker|wheel|adm"'

# --- Finding 2: unauthorized deploys are refused before side effects --------
ssh_run "deploy $sha $digest_a $digest_b"
check "an unauthorized deploy over SSH is refused" '[[ $code != 0 && $output == *"not authorized"* ]]'
check "the refused deploy created no release, ledger or lock" \
  '[[ ! -e /var/lib/pocketboard/releases && ! -e /var/lib/pocketboard/releases.log && ! -e /var/lib/pocketboard/deploy.lock ]]'
ssh_run "rollback $sha"
check "an unauthorized rollback over SSH is refused" '[[ $code != 0 && $output == *"not authorized"* ]]'

# --- Finding 7: status never starts Docker ----------------------------------
printf '%s %s %s\n' "$sha" "$digest_a" "$digest_b" > /var/lib/pocketboard/current
systemctl stop docker.socket docker.service
ssh_run status
check "status with Docker stopped reports it" '[[ $code == 0 && $output == *"docker is not running"* ]]'
check "status left Docker stopped" '! systemctl is-active --quiet docker.service'

mkdir -p /etc/systemd/system/pocketboard-deploy@.service.d
printf '[Unit]\nRequires=docker.service\n' > /etc/systemd/system/pocketboard-deploy@.service.d/pr29.conf
systemctl daemon-reload
ssh_run status
check "counterexample: the PR #29 unit (Requires=docker.service) started Docker for a status" \
  'systemctl is-active --quiet docker.service'
rm -rf /etc/systemd/system/pocketboard-deploy@.service.d
systemctl daemon-reload
systemctl start docker.service
rm -f /var/lib/pocketboard/current

# --- Finding 8: refused retries never print an earlier run's log ------------
ssh_run status
first="$output"
mv /etc/polkit-1/rules.d/50-pocketboard-deploy.rules /root/50-pocketboard-deploy.rules.off
for _ in $(seq 20); do
  runuser -u pocketboard-deploy -- systemctl --no-ask-password start pocketboard-deploy@status.service > /dev/null 2>&1 || break
  sleep 0.5
done
ssh_run status
check "a start refused by polkit reports no log, not the previous run's" \
  '[[ $code != 0 && $output == *"no log from this run"* && $output != *"no release recorded"* && $first == *"no release recorded"* ]]'
mv /root/50-pocketboard-deploy.rules.off /etc/polkit-1/rules.d/50-pocketboard-deploy.rules
for _ in $(seq 20); do deploy_ssh status > /dev/null 2>&1 && break; sleep 0.5; done

# PR #33 re-review finding 7: concurrent requests for the same unit share one
# log file. Each caller must get the log of the run it started.
for n in 1 2 3 4; do deploy_ssh status > "/tmp/concurrent-$n.out" 2>&1 & done
wait
# sshd's "Could not chdir to home directory" notice comes first on stderr.
ids="$(for n in 1 2 3 4; do grep -m 1 -E '^invocation [0-9a-f]{32}$' "/tmp/concurrent-$n.out"; done | sort -u | wc -l)"
code="" output="$(cat /tmp/concurrent-*.out)"
check "four concurrent status requests get four different runs' logs" '[[ $ids == 4 ]]'
rm -f /tmp/concurrent-*.out

# --- Findings 5 and 6: Restic retention and restore -------------------------
# A local file repository and a real PostgreSQL container carrying the
# production Compose labels, so pocketboard-backup finds it as it would on
# the VPS.
repo_dir=/srv/restic-disposable
rm -rf "$repo_dir" && mkdir -p "$repo_dir"
cat > /etc/pocketboard/backup.env <<EOF
RESTIC_REPOSITORY=$repo_dir
RESTIC_PASSWORD=disposable-test-only
AWS_ACCESS_KEY_ID=unused
AWS_SECRET_ACCESS_KEY=unused
EOF
chmod 0600 /etc/pocketboard/backup.env
# shellcheck disable=SC1091
restic_env() { (set -a; . /etc/pocketboard/backup.env; set +a; RESTIC_CACHE_DIR=/var/cache/pocketboard-restic restic "$@"); }
restic_env init > /dev/null

compose_dir="$(mktemp -d)"
cat > "$compose_dir/compose.yml" <<EOF
name: pocketboard
services:
  postgres:
    image: $pg_image
    environment:
      POSTGRES_USER: pocketboard
      POSTGRES_DB: pocketboard
      POSTGRES_PASSWORD: disposable-test-only
    volumes: [pocketboard-postgres:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U pocketboard -d pocketboard"]
      interval: 2s
      retries: 30
volumes:
  pocketboard-postgres:
EOF
docker compose -f "$compose_dir/compose.yml" up -d --wait --wait-timeout 120 > /dev/null 2>&1
pg="$(docker compose -f "$compose_dir/compose.yml" ps -q postgres)"
psql_in() { docker exec -i "$pg" psql -h 127.0.0.1 -U pocketboard -v ON_ERROR_STOP=1 -qtA "$@"; }
psql_in -d pocketboard -c "CREATE TABLE cards (title text); INSERT INTO cards VALUES ('one'), ('two');
  CREATE SCHEMA drizzle;
  CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
  INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('disposable', 1726000000000);"

# Sixty days of earlier pre-deploy snapshots, shaped exactly as
# pocketboard-backup writes them now, then two real runs of the script.
seed="$(mktemp)"
docker exec "$pg" pg_dump -h 127.0.0.1 -U pocketboard -d pocketboard --format=custom > "$seed"
for day in $(seq 60 -2 2); do
  restic_env backup --quiet --host pocketboard --tag pocketboard --tag pre-deploy --tag "sha-$sha" \
    --time "$(date -u -d "-$day days" '+%F %T')" --stdin --stdin-filename pocketboard.dump < "$seed"
done
seeded="$(restic_env snapshots --json --host pocketboard | grep -o '"id"' | wc -l)"
code=0
output="$(/usr/local/sbin/pocketboard-backup "$sha" 2>&1 && /usr/local/sbin/pocketboard-backup "$sha" 2>&1)" || code=$?
check "two real verified backups succeed" '[[ $code == 0 && $(grep -c "verified backup" <<< "$output") == 2 ]]'
kept="$(restic_env snapshots --json --host pocketboard | grep -o '"id"' | wc -l)"
check "retention removed old snapshots ($((seeded + 2)) before, $kept kept)" \
  '(( kept < seeded + 2 && kept >= 10 && kept <= 19 ))'
oldest="$(restic_env snapshots --json --host pocketboard | grep -oE '"time":"[0-9-]+' | cut -d'"' -f4 | sort | head -n 1)"
check "monthly recovery points older than 30 days are kept (oldest $oldest)" \
  '[[ "$oldest" < "$(date -u -d "-30 days" +%F)" ]]'

# The old naming, reproduced: one path per run keeps every snapshot.
old_repo=/srv/restic-disposable-old
rm -rf "$old_repo" && mkdir -p "$old_repo"
old_restic() { RESTIC_REPOSITORY="$old_repo" RESTIC_PASSWORD=disposable-test-only RESTIC_CACHE_DIR=/var/cache/pocketboard-restic restic "$@"; }
old_restic init > /dev/null
for day in $(seq 60 -2 2); do
  old_restic backup --quiet --host pocketboard --tag pocketboard --tag pre-deploy --tag "sha-$sha" \
    --time "$(date -u -d "-$day days" '+%F %T')" --stdin \
    --stdin-filename "pocketboard-$(date -u -d "-$day days" +%Y%m%dT%H%M%SZ)-$sha.dump" < "$seed"
done
old_restic forget --host pocketboard --tag pocketboard --keep-last 5 --keep-daily 7 --keep-weekly 4 \
  --keep-monthly 3 --prune > /dev/null
old_kept="$(old_restic snapshots --json | grep -o '"id"' | wc -l)"
check "counterexample: per-run file names kept all $old_kept of $seeded snapshots" '(( old_kept == seeded ))'

# Restore the newest snapshot with the script docs/deployment.md runs.
psql_in -d pocketboard -c "INSERT INTO cards VALUES ('after the backup');"
latest="$(restic_env snapshots --json --host pocketboard --latest 1 | grep -oE '"short_id":"[0-9a-f]+' | cut -d'"' -f4)"
code=0
output="$(/usr/local/sbin/pocketboard-restore "$latest" 2>&1)" || code=$?
check "pocketboard-restore swaps in the newest snapshot with the backed-up rows" \
  '[[ $code == 0 && $output == *"swapped"* && "$(psql_in -d pocketboard -c "SELECT count(*) FROM cards")" == 2 ]]'
replaced="$(psql_in -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE 'pocketboard_before_restore_%'")"
check "the replaced database is kept with the row added after the backup" \
  '[[ "$(psql_in -d "$replaced" -c "SELECT count(*) FROM cards")" == 3 ]]'
check "no restore dump is left behind" '[[ -z "$(find /var/lib/pocketboard/backup-tmp -type f)" ]]'

docker compose -f "$compose_dir/compose.yml" down -v > /dev/null 2>&1

if (( failures > 0 )); then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
