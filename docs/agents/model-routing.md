# Agent and model routing

Orca selects one writer explicitly for each GitHub issue. It does not proxy
model traffic and does not perform automatic fallback.

## Platform roles

| Platform | Model and effort | Normal role |
| --- | --- | --- |
| Orca | No inference model; coordinator only | Creates worktrees, enforces one writer per issue, and surfaces gates |
| Claude Code | `sonnet` alias (currently Claude Sonnet 5), `high` effort | Primary issue writer; analysis, requirements, and docs when assigned |
| Codex | `gpt-5.6-sol`, `high` effort by default | Architecture, UI direction, difficult debugging, security, and read-only final review |
| Codex escalation | `gpt-6-astra`, `max` effort when available in the subscription | Highest-risk architecture, security, debugging, and release review only |
| Pi | Explicit provider/model below, always `max` effort | Controlled issue writer |
| Kiro | None while suspended | Paused until the human owner restores it |

The local Claude Code default is `model: sonnet` and `effortLevel: high`.
Claude's alias may resolve to a newer Sonnet release as the CLI is updated, so
record the concrete model identifier shown by the session in the writer lease
and handoff. Changing a platform model or effort requires a new lease; do not
silently substitute a cheaper or stronger model.

Codex or Claude may change roles only through a new issue assignment. A writer
cannot review its own work as the independent reviewer.

## Initial Pi routes

These routes are hypotheses derived from public benchmarks and must be tested
against PocketBoard before promotion:

| Route | Effort | Initial use |
| --- | --- | --- |
| KiosAPI `glm-5.3-flash` | `max` | Default low/standard-risk implementation candidate |
| KiosAPI `kimi-k3` | `max` | Complex or longer-horizon implementation candidate |
| Tencent TokenHub `kimi-k3` | `max` | Official-route comparison or Kimi escalation |
| OpenAgentic `deepseek-v4.1-flash-free` | `max` | Challenger route after identity, tool, quota, and latency checks |
| KiosAPI `agnes-3.0-flash` | Not supported | Experimental evaluation only; never a writer |
| KiosAPI/OpenAgentic `union-alpha` | Not supported | Experimental evaluation only; never a writer while identity remains opaque |

Do not use experimental routes for mergeable auth, authorization, migrations,
security controls, release, deployment, or incident work.

## Current conformance state

The 2026-09-18 minimal live check used one no-tool, no-session request per
reachable route with `--thinking max`. It was a transport check, not a coding
quality benchmark:

| Route | Result | Evidence and restriction |
| --- | --- | --- |
| Tencent TokenHub `kimi-k3` | Pass | Correct marker, reasoning stream present, 1,687 reported tokens, 4.4 seconds |
| OpenAgentic `glm-5.3-flash` | Pass | Correct marker, 73 reasoning tokens, 2,195 total tokens, 4.0 seconds |
| OpenAgentic `deepseek-v4.1-flash-free` | Partial | Correct marker, but zero reasoning tokens and 53.5-second latency; `max` upstream behavior is not proven |
| KiosAPI reasoning routes | Blocked | `router.kiosapi.com` had no DNS record locally or through public resolvers; no inference occurred |

Do not assign a KiosAPI writer until its documented endpoint resolves and a
fresh conformance check passes. Do not promote the OpenAgentic DeepSeek route
until a bounded reasoning test confirms that its gateway honors `max`.

## Selection protocol

Before starting, record on the issue:

```text
Writer lease:
Platform:
Provider/model:
Reasoning setting or provider default:
Attempt limit:
Context files:
Permitted files:
Tool allowlist:
Budget or subscription constraint:
Escalation owner:
```

If a route is unavailable or exhausts quota, the writer stops and posts a
compact handoff. The human or Orca records a new writer lease and starts a
fresh session. Never switch Kimi or another model inside an existing session.

Reasoning-capable Pi definitions explicitly forward `reasoning_effort: max`.
The launcher pins `--thinking max`; lower effort is not an eligible writer
configuration. This improves reliability but maximizes reasoning-token use and
latency, so Pi remains issue-scoped with bounded attempts. Provider definitions
still do not expose reliable cost metadata. Record cost as unknown rather than
zero, and verify identity, tool calls, reasoning behavior, latency, quota, and
usage before a route can win the project bake-off.

Global Pi settings allow at most one automatic retry after the initial request;
provider-SDK retries remain disabled. A failed retry ends the run and requires
a recorded human or Orca decision before another session starts.

## Pi launch

From a dedicated issue worktree:

```powershell
& .\.agents\skills\pi-issue-writer\scripts\start-pi-writer.ps1 `
  -Issue 17 `
  -Route kios-glm
```

The launcher uses a fresh named Pi session, passes canonical `AGENTS.md`, loads
only requested skills, disables extensions and prompt templates, and omits
unrestricted shell tools. It also forces `--thinking max` for every route.
Orca or the human runs tests outside Pi and returns only relevant failures. API
keys remain environment variables and are never placed in the repository or
prompt. Add `-Lean` only when the issue explicitly assigns the
`lean-implementation` skill.
