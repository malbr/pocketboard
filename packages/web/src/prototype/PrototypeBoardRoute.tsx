// THROWAWAY PROTOTYPE — host route for the board UI variants.
//
// Question: which board presentation lets the owner see what is in play and
// move the next card with the least effort?
//
// Three variants of the board, switchable via ?variant=, on the development-only
// route /prototype/board. Reached only through the import.meta.env.DEV gate in
// App.tsx, so a production build cannot enable it. Nothing here calls the API
// and nothing is saved. Delete the whole src/prototype/ folder once the owner
// has chosen — see NOTES.md.

import { useCallback, useState } from "react";
import { CardStatus, type Card } from "@pocketboard/shared";
import {
  prototypeStateKeys,
  snapshotFor,
  statusLabels,
  type BoardSnapshot,
  type PrototypeStateKey,
} from "./fixtures";
import { PrototypeSwitcher, type VariantEntry } from "./PrototypeSwitcher";
import { VariantA, variantAName } from "./VariantA";
import { VariantB, variantBName } from "./VariantB";
import { VariantC, variantCName } from "./VariantC";
import type { VariantProps } from "./variant";
// `?inline` hands back the stylesheet as a string instead of registering it as
// a bundled asset. That keeps every byte of prototype styling inside this
// module, so the dead-code branch in App.tsx drops the CSS along with the JSX —
// a plain `import "./prototype.css"` would ship the styles to production even
// though the route itself is unreachable there.
import chromeCss from "./prototype.css?inline";
import variantACss from "./variant-a.css?inline";
import variantBCss from "./variant-b.css?inline";
import variantCCss from "./variant-c.css?inline";

export const prototypeBoardPath = "/prototype/board";

const variants: (VariantEntry & { render: (props: VariantProps) => React.ReactNode })[] = [
  { key: "A", name: variantAName, render: (props) => <VariantA {...props} /> },
  { key: "B", name: variantBName, render: (props) => <VariantB {...props} /> },
  { key: "C", name: variantCName, render: (props) => <VariantC {...props} /> },
];

const NOT_SAVED = "Prototype only — nothing was saved.";

function readVariant(): string {
  const requested = new window.URLSearchParams(window.location.search).get("variant");
  return variants.some((variant) => variant.key === requested) ? (requested as string) : "A";
}

function readState(): PrototypeStateKey {
  const requested = new window.URLSearchParams(window.location.search).get("state");
  return prototypeStateKeys.includes(requested as PrototypeStateKey)
    ? (requested as PrototypeStateKey)
    : "populated";
}

/** Keeps the URL shareable and reload-stable without stacking history entries. */
function writeUrl(variant: string, state: PrototypeStateKey) {
  const params = new window.URLSearchParams(window.location.search);
  params.set("variant", variant);
  params.set("state", state);
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

export function PrototypeBoardRoute() {
  const [variant, setVariant] = useState(readVariant);
  const [state, setState] = useState(readState);
  const [snapshot, setSnapshot] = useState<BoardSnapshot>(() => snapshotFor(readState()));
  const [announcement, setAnnouncement] = useState("");

  const selectVariant = useCallback(
    (key: string) => {
      setVariant(key);
      writeUrl(key, state);
    },
    [state],
  );

  const selectState = useCallback(
    (next: PrototypeStateKey) => {
      setState(next);
      setSnapshot(snapshotFor(next));
      setAnnouncement("");
      writeUrl(variant, next);
    },
    [variant],
  );

  function handleMove(card: Card, status: CardStatus) {
    setSnapshot((current) => ({
      ...current,
      cards: current.cards.map((candidate) =>
        candidate.id === card.id
          ? { ...candidate, status, version: candidate.version + 1 }
          : candidate,
      ),
    }));
    setAnnouncement(`${NOT_SAVED} “${card.title}” now shows in ${statusLabels[status]}.`);
  }

  function handleDelete(card: Card) {
    const confirmed = window.confirm(
      `Delete “${card.title}”? This is a prototype: the card only disappears from this ` +
        `page, and nothing is saved.`,
    );
    if (!confirmed) {
      return;
    }
    setSnapshot((current) => ({
      ...current,
      cards: current.cards.filter((candidate) => candidate.id !== card.id),
    }));
    setAnnouncement(`${NOT_SAVED} “${card.title}” was removed from this page only.`);
  }

  function handleCreate(title: string) {
    const created: Card = {
      id: crypto.randomUUID(),
      title,
      status: CardStatus.Backlog,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    setSnapshot((current) => ({ ...current, cards: [created, ...current.cards] }));
    setAnnouncement(`${NOT_SAVED} “${title}” was added to this page only.`);
  }

  function handleRetry() {
    setAnnouncement(
      `${NOT_SAVED} There is nothing to reload — pick another board state in the ` +
        `prototype bar to see a different one.`,
    );
  }

  const active = variants.find((entry) => entry.key === variant) ?? variants[0];
  const variantProps: VariantProps = {
    snapshot,
    onMove: handleMove,
    onDelete: handleDelete,
    onCreate: handleCreate,
    onRetry: handleRetry,
  };

  return (
    <div className="prototype-root">
      <style>{[chromeCss, variantACss, variantBCss, variantCCss].join("\n")}</style>
      <div className="proto-ribbon">
        <p className="proto-ribbon__line proto-ribbon__question">
          <span className="proto-ribbon__tag">Throwaway prototype.</span> Which board
          presentation lets the owner see what is in play and move the next card with the least
          effort?
        </p>
        <p className="proto-ribbon__line">
          Sample cards only. Every button here changes this page and nothing else: the API is
          never called and nothing is saved.
        </p>
        <p className="proto-ribbon__line">
          Run it with <code>npm run dev --workspace=packages/web</code>, then open{" "}
          <code>http://127.0.0.1:5173/prototype/board?variant=A&amp;state=populated</code>. Use
          the bar at the bottom, or ← and →, to change variant.
        </p>
        <p className="proto-ribbon__line proto-ribbon__status" role="status">
          {announcement}
        </p>
      </div>

      {active.render(variantProps)}

      <PrototypeSwitcher
        variants={variants.map(({ key, name }) => ({ key, name }))}
        current={active.key}
        onSelectVariant={selectVariant}
        state={state}
        onSelectState={selectState}
      />
    </div>
  );
}
