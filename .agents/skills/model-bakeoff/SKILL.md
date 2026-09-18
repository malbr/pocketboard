---
name: model-bakeoff
description: Compares candidate coding models on the same frozen PocketBoard tasks and constraints, producing evidence for human routing decisions. Use for an explicitly approved evaluation, not ordinary implementation or automatic model selection.
---

# Model bake-off

## Fair setup

- Record the candidate provider/model pairs, frozen base commit, task set,
  context packet, tool allowlist, attempt limit, and budget on one GitHub issue.
- Obtain human approval before any paid run. Check provider quota first and stop
  at the approved cap.
- Use a fresh session and clean worktree for every candidate. Do not share model
  output, hidden hints, failed patches, or handoffs between candidates.
- Use identical acceptance tests. Keep benchmark tests hidden from candidates
  when practical, and never merge bake-off patches directly.
- Run candidates sequentially unless independent worktrees fit Orca's maximum
  of two. One writer owns each worktree.

## Score

Score each run from observable evidence:

| Dimension | Weight |
| --- | ---: |
| Correctness and acceptance tests | 40% |
| Scope discipline | 20% |
| Maintainability | 15% |
| Security and safety | 10% |
| Token or provider cost | 10% |
| End-to-end latency | 5% |

A secret exposure, unauthorized action, fabricated test result, or out-of-scope
production access disqualifies the run regardless of aggregate score.

## Report

Post one compact GitHub issue comment containing the frozen SHA, exact routes
and settings, test results, attempts, token/cost evidence, latency, weighted
scores, observed failure modes, and confidence limits. Separate vendor
benchmark claims from PocketBoard measurements.

Recommend a routing change; never apply it automatically. The human owner
decides whether the evidence is sufficient.
