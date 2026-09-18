# 0003. The board presents one status at a time

- Status: Accepted
- Date: 2026-09-18
- Issue: #6

## Context

Until now the board rendered Backlog, Doing, and Done as three equal columns,
each card offering both of its destinations with the same weight. On a phone
that stacks into one long page: the owner scrolls past two statuses to reach the
third, and every card presents two moves of which only one is usually wanted.

Issue #6 required several materially different presentations to be built against
the real board states, compared by the human owner, and then rewritten as
production code. Three were built on a throwaway prototype branch:

- **A, three-lane workbench:** the whole board at once, destinations explicit.
  Long three-section page on a phone.
- **B, focused lane:** one status at a time, one obvious next action per card.
  The other two statuses are hidden until selected.
- **C, command ledger:** densest desktop scan, best view of waiting time and
  revision. Needs horizontal scrolling on a phone.

## Decision

**The production board is B, the focused lane.** The human owner selected it by
commenting `APPROVE issue6-select-b-ed32f97` from immutable GitHub user id
`325861437` against prototype commit `ed32f970e47d49779dc4de8efa07ea18ce719269`.
The verified approval is
https://github.com/malbr/pocketboard/pull/15#issuecomment-5715820181. Prototype
pull request #15 is a throwaway record and is not merged; none of its route,
fixtures, switcher, or styling reaches this branch.

**One status fills the page, reached through native buttons.** A `nav` labelled
"Board status" holds one button per status carrying its live count and
`aria-pressed`. They are buttons, not a tablist: nothing here is a tab panel, and
claiming that role would take over the arrow keys without delivering what a
tablist promises.

**Each card leads with the step that follows from where it is.** Backlog offers
Start, Doing offers Finish, Done offers Reopen. The second destination and
Delete stay visually quiet but keep full accessible names that open with their
visible label and then name the card and the destination, so several rows
offering "Start" are never ambiguous, by ear or by voice control.

**Creation is always into Backlog,** whichever status is on screen, and the lane
follows the new card there rather than dropping it into a status the owner
cannot see.

**Every load state is stated.** Loading, load failure with a retry, an empty
status that says what fills it, an ordinary failure, a stale conflict, and a
card already deleted elsewhere each have their own presentation. The conflict
presentations preserve the board exactly as the owner read it and name the
reload that resolves it, as `0002-card-move-optimistic-concurrency.md` requires;
the contested row now also says so in place.

**Presentation only.** No API contract, request shape, owner restriction, CSRF
header, version round-trip, or state-mutation rule changed with this decision.

## Consequences

- Two of the three statuses are one keystroke away rather than on screen. The
  counts in the navigation are what keep the rest of the board present, so they
  must stay accurate and must not be invented while the board is still loading.
- Any future card action has to declare which step is the primary one for each
  status, or the hierarchy that makes this design work erodes back into a row of
  equal buttons.
- The board is a single reading column at every width, so there is no
  multi-column grid to collapse and no horizontal scrolling at any width. The
  only reflow is the row's actions moving under its text on narrow screens.
- Styling lives in one stylesheet, `packages/web/src/index.css`, wired in at
  `main.tsx`. The palette is two warm neutrals, a deep pine accent, and one
  alarm colour; every pairing used for text or for an interactive edge was
  computed against WCAG AA rather than judged by eye.
- The prototype branch stays unmerged and will be deleted once #6 closes. It is
  not a dependency of anything on `main`.

## Superseded records

None.
