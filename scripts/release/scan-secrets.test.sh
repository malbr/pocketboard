#!/usr/bin/env bash
# gitleaks exits 0 with "0 commits scanned" when it cannot read the repository
# (seen with a git worktree mount), so scan-secrets.sh must verify coverage.
# A fake `docker` stands in for the gitleaks container.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
scan="$here/scan-secrets.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0

repo="$work/repo"
git init -q "$repo"
for n in 1 2 3; do
  echo "$n" > "$repo/file"
  git -C "$repo" add file
  git -C "$repo" -c user.name=t -c user.email=t@example.invalid commit -q -m "c$n"
done

mkdir "$work/bin"
cat > "$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case "$FAKE_GITLEAKS" in
  clean) echo "INF 3 commits scanned." >&2; echo "INF no leaks found" >&2; exit 0 ;;
  # Real gitleaks output: the count directly follows an ANSI bold code.
  colored) printf '\033[90m7:20AM\033[0m \033[32mINF\033[0m \033[1m3 commits scanned.\033[0m\n' >&2; exit 0 ;;
  unreadable) echo "ERR fatal: not a git repository" >&2; echo "INF 0 commits scanned." >&2; echo "INF no leaks found" >&2; exit 0 ;;
  partial) echo "INF 2 commits scanned." >&2; echo "INF no leaks found" >&2; exit 0 ;;
  leak) echo "INF 3 commits scanned." >&2; echo "WRN leaks found: 1" >&2; exit 1 ;;
  silent) exit 0 ;;
esac
FAKE
chmod +x "$work/bin/docker"

run() { # run <description> <expected exit> <expected output fragment> <mode>
  local output code=0
  output="$(PATH="$work/bin:$PATH" FAKE_GITLEAKS="$4" "$scan" "$repo" 2>&1)" || code=$?
  if [[ "$code" != "$2" || "$output" != *"$3"* ]]; then
    echo "FAIL: $1 (exit $code, output: $output)"
    failures=$((failures + 1))
  else
    echo "ok: $1"
  fi
}

run "clean full scan passes" 0 "scanned all 3 non-merge commits" clean
run "colored gitleaks log passes" 0 "scanned all 3 non-merge commits" colored
run "unreadable repository fails" 1 "scanned 0 of 3" unreadable
run "partial scan fails" 1 "scanned 2 of 3" partial
run "leak fails" 1 "gitleaks reported findings" leak
run "missing summary fails" 1 "no scan summary" silent

if (( failures > 0 )); then echo "$failures case(s) failed"; exit 1; fi
echo "all cases passed"
