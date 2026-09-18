# Agent and model routing

Orca selects one writer explicitly for each GitHub issue. It does not proxy
model traffic and does not perform automatic fallback.

## Platform roles

| Platform | Normal role |
| --- | --- |
| Claude Code | Primary issue writer; analysis, requirements, and docs when assigned |
| Pi | Controlled issue writer with an explicit provider and model |
| Codex | Architecture, UI direction, difficult debugging, security, and read-only final review |
| Kiro | Paused until the human owner restores it |

Codex or Claude may change roles only through a new issue assignment. A writer
cannot review its own work as the independent reviewer.

## Initial Pi routes

These routes are hypotheses derived from public benchmarks and must be tested
against PocketBoard before promotion:

| Route | Initial use |
| --- | --- |
| KiosAPI `glm-5.3-flash` | Default low/standard-risk implementation candidate |
| KiosAPI `kimi-k3` | Complex or longer-horizon implementation candidate |
| Tencent TokenHub `kimi-k3` | Official-route comparison or Kimi escalation |
| OpenAgentic `deepseek-v4.1-flash-free` | Challenger route after identity, tool, quota, and latency checks |
| KiosAPI `agnes-3.0-flash` | Experimental evaluation only |
| KiosAPI/OpenAgentic `union-alpha` | Experimental evaluation only while identity remains opaque |

Do not use experimental routes for mergeable auth, authorization, migrations,
security controls, release, deployment, or incident work.

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

Current Pi provider definitions do not expose reliable cost metadata and may
not forward configurable reasoning effort. Record this as unknown rather than
reporting zero cost or claiming benchmark-equivalent settings. Verify provider
identity, tool calls, reasoning behavior, latency, quota, and usage before a
route can win the project bake-off.

## Pi launch

From a dedicated issue worktree:

```powershell
& .\.agents\skills\pi-issue-writer\scripts\start-pi-writer.ps1 `
  -Issue 17 `
  -Route kios-glm
```

The launcher uses a fresh named Pi session, passes canonical `AGENTS.md`, loads
only requested skills, disables extensions and prompt templates, and omits
unrestricted shell tools. Orca or the human runs tests outside Pi and returns
only relevant failures. API keys remain environment variables and are never
placed in the repository or prompt. Add `-Lean` only when the issue contains an
explicit `Skills: lean-implementation` assignment.
