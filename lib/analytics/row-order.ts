// =====================================================================
// ICTC Owner Analytics — ROW ORDER (owner feedback R5)
// =====================================================================
// Renzo: *"drag to reorder rows within their table metric group of course."*
//
// The arithmetic of "what order are these rows in" is four small pure
// functions, and they live here rather than in the React hook for the same
// reason `matrix.ts` is pure: an ordering bug should be readable and testable
// without mounting anything, and the same functions have to run against a
// value that arrived from `localStorage` (untrusted, possibly stale, possibly
// from a build where a row did not exist yet).
//
// ── THE ONE RULE THAT MAKES A SAVED ORDER SAFE ────────────────────────
// **A saved order is a PREFERENCE, never a row list.** `resolveOrder` treats
// the registry as the authority on which rows exist and the saved array only
// as an opinion about sequence: a saved key that no longer names a row is
// dropped, and a row the save has never heard of is APPENDED in its registry
// position rather than lost. So a row added in a future round shows up for a
// reader who reordered this one, instead of silently disappearing behind a
// preference they set months earlier.
//
// It also means a section can never be reordered into another section's rows:
// the caller passes one section's default keys, so the whole vocabulary of an
// order is that section. There is no cross-section drag to forbid because
// there is no cross-section order to express.
// =====================================================================

/**
 * The order to render in: the saved sequence, filtered to rows that still
 * exist, with any row the save does not mention appended in its default
 * position.
 */
export function resolveOrder(
  defaults: readonly string[],
  saved: readonly string[] | null,
): string[] {
  if (!saved || saved.length === 0) return [...defaults];
  const known = new Set(defaults);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of saved) {
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  for (const key of defaults) {
    if (!seen.has(key)) out.push(key);
  }
  return out;
}

/** Is this order the registry's own? Drives whether `Reset` is offered. */
export function isDefaultOrder(
  order: readonly string[],
  defaults: readonly string[],
): boolean {
  if (order.length !== defaults.length) return false;
  for (let i = 0; i < order.length; i += 1) {
    if (order[i] !== defaults[i]) return false;
  }
  return true;
}

/**
 * Move `key` one slot up (`-1`) or down (`+1`). The KEYBOARD path — a drag
 * handle that only answers to a mouse is a control half the ways in.
 *
 * Returns the SAME array reference when the move is impossible (the row is
 * already at the end it is being pushed towards), so a caller can skip a write
 * rather than persisting a no-op.
 */
export function moveKey(
  order: readonly string[],
  key: string,
  delta: number,
): readonly string[] {
  const from = order.indexOf(key);
  if (from === -1) return order;
  const to = from + delta;
  if (to < 0 || to >= order.length) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, key);
  return next;
}

/**
 * Drop `key` onto `target` — the row is removed and re-inserted at the
 * target's position, which is what a reader means by dragging one row onto
 * another whichever direction they came from.
 */
export function dropKey(
  order: readonly string[],
  key: string,
  target: string,
): readonly string[] {
  if (key === target) return order;
  const from = order.indexOf(key);
  const to = order.indexOf(target);
  if (from === -1 || to === -1) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(next.indexOf(target) + (from < to ? 1 : 0), 0, key);
  return next;
}

/**
 * Apply an order to a list of things. Anything the order does not mention
 * keeps its original position at the end — the same "never lose a row"
 * property `resolveOrder` has, restated for the render.
 */
export function applyOrder<T>(
  items: readonly T[],
  order: readonly string[],
  keyOf: (item: T) => string,
): T[] {
  if (order.length === 0) return [...items];
  const rank = new Map(order.map((k, i) => [k, i] as const));
  return [...items].sort((a, b) => {
    const ra = rank.get(keyOf(a));
    const rb = rank.get(keyOf(b));
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
}
