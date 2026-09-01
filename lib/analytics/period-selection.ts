// =====================================================================
// ICTC Owner Analytics — the PERIOD SELECTION, and its URL spelling
// =====================================================================
// Owner feedback R2 (2026-09-02). The matrix's column checklist writes
// itself into the address bar as `?hide=`, so the set has to be readable
// on BOTH sides of the boundary: the Server Component resolves the opening
// view from `searchParams`, and the client shell writes it back with
// `history.replaceState`.
//
// **That is the whole reason these three live here and not in
// `period-filter.tsx`.** That file is `"use client"`, and a plain function
// exported from a client module is turned into a client REFERENCE — an RSC
// that imported and called it would fail at request time rather than at
// build time, which is the worst place for this class of mistake to
// surface. Pure module, no `"use client"`, importable from either side.
//
// ── THE ONE STRUCTURAL DECISION: THE SET IS WHAT IS *HIDDEN* ──────────
// Renzo: *"We must always default this filter checklist to checking all."*
// Storing the hidden keys rather than the selected ones makes that a
// property of the shape instead of a default someone has to remember: an
// absent param and an empty set cannot mean "nothing is selected", they can
// only mean "everything is". It also gives the param its natural spelling —
// `hide` is simply dropped when nothing is hidden, so the default view has
// a clean address and the presence of the param always means something.
//
// Pure and client-safe: no React, no Supabase, no `server-only`.
// =====================================================================

/** The empty set, shared — a default-all state is one object, not one per render. */
export const NO_HIDDEN: ReadonlySet<string> = new Set<string>();

/**
 * The URL spelling of a hidden set: the period keys, comma-joined and sorted
 * so the same selection always produces the same address (a link that changes
 * spelling on every render is a link nobody can compare). `null` when nothing
 * is hidden, and the caller then DELETES the param rather than writing an
 * empty one.
 */
export function serializeHidden(hidden: ReadonlySet<string>): string | null {
  if (hidden.size === 0) return null;
  return [...hidden].sort().join(",");
}

/**
 * How many keys a hand-edited URL may put into the set. Bounded because the
 * parsed set is rebuilt on the server for every request; the real ceiling in
 * normal use is a few dozen (twelve months + four quarters + the years on
 * record), so this is loose enough never to bite a real selection.
 */
const MAX_HIDDEN_KEYS = 240;

/**
 * The reverse. Deliberately does NOT validate a key against the current view:
 * one set is shared across every granularity and year, and a period key is
 * already self-describing (`2026-03`, `2026-Q1`, `2025`), so a key belonging to
 * a view the reader is not on matches nothing and is inert. That is what lets
 * a quarter selection survive a trip through the month columns and come back
 * intact — and what stops hiding March 2026 from also hiding March 2025.
 */
export function parseHidden(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const k = part.trim();
    if (!k) continue;
    out.add(k);
    if (out.size >= MAX_HIDDEN_KEYS) break;
  }
  return out;
}
