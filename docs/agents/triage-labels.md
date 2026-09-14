# Triage labels

Exactly one of these lifecycle labels may be active on an issue at a time.
Category and risk labels do not count as lifecycle labels.

| Skill role | GitHub label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Human owner must evaluate the issue |
| `needs-info` | `needs-info` | Waiting for information from the human owner |
| `ready-for-agent` | `ready-for-agent` | Fully specified and safe for an assigned agent |
| `ready-for-human` | `ready-for-human` | Requires direct human implementation or judgment |
| `wontfix` | `wontfix` | Will not be actioned |

Transition an issue by removing its current lifecycle label before adding the
next. Agents may recommend a transition; the human owns high-impact decisions.
