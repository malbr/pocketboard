#!/usr/bin/env bash
# Exercises ssh-gate against a fake `systemctl`, so every accepted and refused
# request is covered without systemd, polkit, or root.
# Assertions are single-quoted on purpose: check() evaluates them after each run.
# shellcheck disable=SC2016
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
gate="$here/../ssh-gate"
sha="0123456789abcdef0123456789abcdef01234567"
api="$(printf 'a%.0s' {1..64})"
web="$(printf 'b%.0s' {1..64})"
failures=0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/log"
cat > "$work/bin/systemctl" <<'FAKE'
#!/usr/bin/env bash
# Records its arguments; writes the unit's log unless told the unit never ran.
printf '%s\n' "$*" >> "$FAKE_CALLS"
unit="${@: -1}"
instance="${unit#pocketboard-deploy@}"
instance="${instance%.service}"
if [[ "$FAKE_SYSTEMCTL" != denied ]]; then
  echo "log line from $instance" > "$POCKETBOARD_GATE_LOG_DIR/$instance.log"
fi
case "$FAKE_SYSTEMCTL" in
  ok) exit 0 ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$work/bin/systemctl"

# run <request> <systemctl mode>; sets code, output
run() {
  : > "$work/calls"
  code=0
  output="$(env -i PATH="$work/bin:/usr/bin:/bin" SSH_ORIGINAL_COMMAND="$1" \
    POCKETBOARD_GATE_LOG_DIR="$work/log" FAKE_CALLS="$work/calls" FAKE_SYSTEMCTL="$2" \
    bash "$gate" 2>&1)" || code=$?
}

check() {
  local description="$1" condition="$2"
  if eval "$condition"; then
    echo "ok: $description"
  else
    echo "FAIL: $description (exit $code, output: $output, calls: $(cat "$work/calls"))"
    failures=$((failures + 1))
  fi
}

run "deploy $sha sha256:$api sha256:$web" ok
check "deploy starts the one matching unit" \
  '[[ $code == 0 && "$(cat "$work/calls")" == "--no-ask-password start pocketboard-deploy@deploy-$sha-$api-$web.service" ]]'
check "deploy prints the unit log" '[[ $output == *"log line from deploy-$sha-$api-$web"* ]]'

run "rollback $sha" ok
check "rollback starts the rollback unit" \
  '[[ $code == 0 && "$(cat "$work/calls")" == "--no-ask-password start pocketboard-deploy@rollback-$sha.service" ]]'

run "status" ok
check "status starts the status unit" \
  '[[ $code == 0 && "$(cat "$work/calls")" == "--no-ask-password start pocketboard-deploy@status.service" ]]'

run "rollback $sha" failed
check "a failed unit fails the SSH command and still shows its log" \
  '[[ $code == 1 && $output == *"log line from rollback-$sha"* ]]'

echo "stale output from an earlier run" > "$work/log/status.log"
touch -d '1 hour ago' "$work/log/status.log"
run "status" denied
check "an old log is never shown as this run's result" \
  '[[ $code == 1 && $output != *"stale output"* && $output == *"no log from this run"* ]]'

refused=(
  ""
  "deploy"
  "status now"
  " status"
  "status "
  "STATUS"
  "status; id"
  $'status\nid'
  "status && id"
  "rollback"
  "rollback ${sha:0:7}"
  "rollback ${sha^^}"
  "rollback $sha extra"
  "rollback ../../etc/passwd"
  "rollback \$(id)"
  "deploy $sha $api $web"
  "deploy $sha sha256:$api"
  "deploy $sha sha256:${api:1} sha256:$web"
  "deploy $sha sha256:$api sha256:$web; reboot"
  "bash"
  "scp -t /tmp"
  "sftp"
)
for request in "${refused[@]}"; do
  run "$request" ok
  check "refuses $(printf '%q' "$request")" '[[ $code == 2 && ! -s "$work/calls" && $output == *"refused"* ]]'
done

if (( failures > 0 )); then
  echo "$failures case(s) failed"
  exit 1
fi
echo "all cases passed"
