// THROWAWAY PROTOTYPE — the floating variant switcher.
// Delete with the rest of src/prototype/.

import { useEffect, useRef } from "react";
import { prototypeStateKeys, prototypeStateLabels, type PrototypeStateKey } from "./fixtures";

export interface VariantEntry {
  key: string;
  name: string;
}

/**
 * Put this on anything that scrolls with the arrow keys, and the switcher will
 * leave them alone. Variant C's ledger needs it: at phone width the register is
 * scrolled sideways from the keyboard, and a global shortcut that stole those
 * keys would make the only way to reach the right-hand columns impossible.
 */
export const ARROW_KEY_OWNER = { "data-arrow-keys": "own" } as const;

/** Gap kept between a newly focused control and the top of the switcher. */
const FOCUS_CLEARANCE = 12;

interface PrototypeSwitcherProps {
  variants: VariantEntry[];
  current: string;
  onSelectVariant: (key: string) => void;
  state: PrototypeStateKey;
  onSelectState: (state: PrototypeStateKey) => void;
}

/**
 * Arrow keys cycle variants, but only when the page itself has focus. A field
 * or a control that owns the arrow keys — including the state `<select>` in
 * this very bar — keeps them, so nothing the owner is operating gets hijacked.
 * Anything else that reads the arrow keys declares it with ARROW_KEY_OWNER
 * where the element is written, rather than leaving this guard to infer intent
 * from overflow styles.
 */
function ownsArrowKeys(target: unknown): boolean {
  if (!(target instanceof window.HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target.closest('[data-arrow-keys="own"]')) {
    return true;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || tag === "button";
}

export function PrototypeSwitcher({
  variants,
  current,
  onSelectVariant,
  state,
  onSelectState,
}: PrototypeSwitcherProps) {
  const barRef = useRef<React.ElementRef<"div">>(null);
  const index = Math.max(
    0,
    variants.findIndex((variant) => variant.key === current),
  );
  const step = (offset: number) => {
    const next = (index + offset + variants.length) % variants.length;
    onSelectVariant(variants[next].key);
  };

  useEffect(() => {
    const listening = new window.AbortController();

    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
          return;
        }
        if (event.altKey || event.ctrlKey || event.metaKey || ownsArrowKeys(event.target)) {
          return;
        }
        event.preventDefault();
        const offset = event.key === "ArrowLeft" ? -1 : 1;
        const next = (index + offset + variants.length) % variants.length;
        onSelectVariant(variants[next].key);
      },
      { signal: listening.signal },
    );

    return () => listening.abort();
  }, [index, variants, onSelectVariant]);

  /**
   * The bar is fixed over the bottom of the page, so at phone width Tab happily
   * lands on card controls hidden underneath it. The browser's own scrolling
   * cannot help: as far as it is concerned the control is already in view. So
   * whenever focus reaches something outside the bar, nudge the page just far
   * enough to lift that control clear of it.
   */
  useEffect(() => {
    const listening = new window.AbortController();

    window.addEventListener(
      "focusin",
      (event) => {
        const focused = event.target;
        const bar = barRef.current;
        if (!bar || !(focused instanceof window.HTMLElement) || bar.contains(focused)) {
          return;
        }

        const barTop = bar.getBoundingClientRect().top;
        const rect = focused.getBoundingClientRect();
        const clearance = barTop - FOCUS_CLEARANCE;

        if (rect.height > clearance) {
          // Taller than the space above the bar — Variant C's ledger is. It can
          // never sit entirely clear, so settle for its top edge being visible.
          if (rect.top > clearance) {
            window.scrollBy({ top: rect.top - FOCUS_CLEARANCE });
          }
          return;
        }
        if (rect.bottom + FOCUS_CLEARANCE > barTop) {
          window.scrollBy({ top: rect.bottom + FOCUS_CLEARANCE - barTop });
        }
      },
      { signal: listening.signal },
    );

    return () => listening.abort();
  }, []);

  /**
   * That nudge only works if the page has somewhere left to scroll, so the
   * document reserves the bar's own height at the bottom. Measured rather than
   * guessed: the bar wraps to two rows at phone width, and a fixed value would
   * be wrong at one width or the other.
   */
  useEffect(() => {
    const bar = barRef.current;
    const root = bar?.closest(".prototype-root");
    if (!bar || !(root instanceof window.HTMLElement)) {
      return;
    }

    const sync = () => {
      // Nothing laid out (jsdom under test) — leave the CSS fallback alone
      // rather than reserving a height of zero.
      if (bar.offsetHeight === 0) {
        return;
      }
      root.style.setProperty(
        "--p-switcher-space",
        `${bar.offsetHeight + FOCUS_CLEARANCE * 3}px`,
      );
    };

    sync();
    if (typeof window.ResizeObserver !== "function") {
      return;
    }
    const observer = new window.ResizeObserver(sync);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const currentVariant = variants[index];
  const previous = variants[(index - 1 + variants.length) % variants.length];
  const next = variants[(index + 1) % variants.length];

  return (
    <div className="proto-switcher" role="group" aria-label="Prototype controls" ref={barRef}>
      <div className="proto-switcher__group">
        <button
          type="button"
          className="proto-switcher__step"
          aria-label={`Previous variant: ${previous.key} — ${previous.name}`}
          onClick={() => step(-1)}
        >
          ← Previous
        </button>
        <span className="proto-switcher__name">
          {currentVariant.key} — {currentVariant.name}
        </span>
        <button
          type="button"
          className="proto-switcher__step"
          aria-label={`Next variant: ${next.key} — ${next.name}`}
          onClick={() => step(1)}
        >
          Next →
        </button>
      </div>
      <div className="proto-switcher__state">
        <label htmlFor="proto-state">Board state</label>
        <select
          id="proto-state"
          className="proto-switcher__select"
          value={state}
          onChange={(event) => onSelectState(event.target.value as PrototypeStateKey)}
        >
          {prototypeStateKeys.map((key) => (
            <option key={key} value={key}>
              {prototypeStateLabels[key]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
