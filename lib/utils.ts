import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// ─── focusNoScroll — the ONE autofocus idiom (2026-08-05) ─────────────────────────────
// `HTMLElement.focus()` is specified to run "scroll an element into view" with block AND
// inline **"center"**, in EVERY scrolling box up to the document (an `overflow-hidden`
// ancestor is still programmatically scrollable, so it counts). `"center"` always computes
// a target, so it fires even when the element is already fully visible — which is why
// merely STARTING a cell edit jogged the whole page.
//
// React's `autoFocus` prop is unfixable from the outside: react-dom's `commitMount` is a
// bare `domElement.focus()` with no options. So a cell editor must NOT use `autoFocus` —
// it passes this ref callback instead, which lands in the same commit (layout) phase
// `commitMount` would have and, like react-dom, calls no `select()`/`setSelectionRange()`,
// so caret + selection behaviour is byte-identical. Only the scroll is refused.
//
// Canonical prior art: `components/shared/grid/EditInput.tsx` (same idiom, local callback).
// A `.focus()` on a grid cell / grid wrapper without `{ preventScroll: true }` is a bug.
export function focusNoScroll(el: HTMLElement | null) {
  el?.focus({ preventScroll: true })
}
