# 0002. Card moves carry an explicit concurrency token

- Status: Accepted
- Date: 2026-09-17
- Issue: #4

## Context

A card can be moved among Backlog, Doing, and Done. The board is single-user,
but one owner can still have the same board open in two browsers, or a phone
and a laptop, and a tab can sit untouched for hours. A move sent from a tab
holding an old view of a card would otherwise apply silently and undo whatever
the other tab did — the card lands where the older tab thought it belonged, and
nothing in either window says so.

Last-write-wins is the default any plain `UPDATE ... SET status` gives, so
avoiding it has to be a deliberate part of the transport contract rather than
something the frontend is careful about.

## Decision

**Every card carries an integer `version`, and every move states the version it
is based on.** The column is `integer not null default 1`; each accepted move
sets `version = version + 1`. `PATCH /api/cards/:cardId` takes
`{ status, version }` validated by the shared `moveCardInputSchema`, and the
card in every response carries its current `version`.

**The version check is part of the write, not a read before it.** The move is a
single statement — `update cards set status = $1, version = version + 1 where
id = $2 and version = $3 returning *` — so the comparison and the write cannot
be separated by a concurrent move. No row returned means the move did not
apply; only then does the API read the row to distinguish a card that is gone
(`404 card_not_found`) from a stale token (`409 card_version_conflict`).

**A conflict answers with the card as it now stands.** The 409 body is
`{ error, card }`, so the frontend can name what actually happened rather than
reporting an anonymous failure.

**The frontend does not reconcile automatically.** On a conflict it leaves the
board exactly as the owner was reading it and shows an alert naming the card,
where it is now, and that reloading the page will catch it up. Silently
repainting the board would hide the concurrent change — the thing the owner
most needs to see.

An integer version is preferred over `updated_at` because two moves within the
same clock tick are indistinguishable by timestamp, and over a hash of the row
because a hash says nothing about which of two states is newer.

## Consequences

- Any future card mutation must take and return the version, and clients must
  round-trip it. A caller that discards the token cannot mutate a card at all,
  which is the intended failure.
- The migration is additive: `add column if not exists version integer default 1
  not null`. Existing rows become version 1 and older readers that ignore the
  column keep working, so no destructive-migration approval is needed.
- The owner may see a conflict alert that a plain reload resolves. That is the
  cost of never losing a concurrent change silently.
- There is no generated OpenAPI artifact in the repository yet; the shared Zod
  schemas in `packages/shared` are the authoritative transport contract, and
  #7 owns generated-artifact drift enforcement.

## Superseded records

None.
