#!/usr/bin/env bash
# Runs host.test.sh inside a throwaway, privileged Ubuntu 24.04 container that
# boots systemd and carries sshd, polkitd, its own Docker daemon, and Restic,
# all from the Ubuntu archive. The container and its Docker volume are removed
# afterwards. Nothing is published, no port is exposed, and no real credential
# is used: the SSH key and Restic password are generated for the run.
#
# Needs a local Docker engine that allows --privileged containers with cgroup
# v2 (Docker Engine on Linux, or Docker Desktop). It downloads Ubuntu packages
# when it builds the image. The PostgreSQL image pinned in
# compose.production.yml is copied in from the local engine, so the inner
# daemon needs no registry access.
#
# Usage: deploy/vps/tests/integration/run-disposable-host.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/../../../.." && pwd)"
pg_image="$(grep -oE 'image: postgres:[^ ]+@sha256:[0-9a-f]{64}' "$root/compose.production.yml" | head -n 1 | cut -d' ' -f2)"
image="pocketboard-disposable-host:ubuntu-24.04"
name="pocketboard-disposable-host-$$"
work="$(mktemp -d)"

cleanup() {
  [[ -n "${KEEP_HOST:-}" ]] || docker rm -f -v "$name" > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker build -q -t "$image" - > /dev/null <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus polkitd openssh-server \
      openssh-client docker.io docker-compose-v2 restic curl ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl disable ssh.socket 2> /dev/null || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE

docker pull -q "$pg_image" > /dev/null
docker save "$pg_image" -o "$work/postgres.tar"
git -C "$root" ls-files -co --exclude-standard -z | tar -C "$root" --null -T - -cf "$work/tree.tar"

MSYS_NO_PATHCONV=1 docker run -d --name "$name" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  -v /var/lib/docker -v /var/lib/containerd "$image" > /dev/null

inside() { MSYS_NO_PATHCONV=1 docker exec -i "$name" "$@"; }
for _ in $(seq 60); do
  state="$(inside systemctl is-system-running 2> /dev/null || true)"
  [[ "$state" == running || "$state" == degraded ]] && break
  sleep 1
done
inside systemctl start docker.service
# An image saved by digest loads without a name, so it gets a local tag the
# inner daemon can use without contacting a registry.
loaded="$(inside docker load -q < "$work/postgres.tar" | grep -oE 'sha256:[0-9a-f]{64}|[^ ]+:[^ ]+$' | tail -n 1)"
inside docker tag "$loaded" pocketboard-disposable/postgres:pinned
inside mkdir -p /src
inside tar -C /src -xf - < "$work/tree.tar"
inside env POCKETBOARD_DISPOSABLE_HOST=yes bash /src/deploy/vps/tests/integration/host.test.sh /src \
  pocketboard-disposable/postgres:pinned
