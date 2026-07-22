# PROMPT — Cenapro Ledger Phase 3: Editing Everywhere (scope-independent)

## Before anything else
1. Read `TIMELINE.md`, `CLAUDE.md`, then
   `.agents/prompts/cenapro-ledger-endless-sheet-spec.md` (esp. "Editing
   everywhere" + the draft-loss root cause — locked).
2. Read `app/(app)/cenapro/CONTEXT.md` (Production section) and
   `components/shared/grid/CONTEXT.md`.
3. Read the Phase-1 + Phase-2 deliverables (axis framework, endless ledger +
   endless pivots, their hooks) and `bulk-add-modal.tsx` (you absorb its
   validation/paste/keyboard behavior, then delete it) + the daily block's
   existing focus-scope editing. Phases 1-2 MUST be shipped and working — verify
   before planning.
4. **Enter plan mode, present the plan, get approval, then execute.** Delegate to
   senior-frontend-engineer (opus). Verify on disk after every completion.

## Goal
Introduce a lock/unlock that is FULLY ORTHOGONAL to view and scope. Unlocking
enables (a) a draft entry zone that RETIRES the fragile Bulk Add modal and (b)
inline edit of committed rows — in EVERY view (ledger/W6/W7) and BOTH scopes
(endless/focus). Loss-proof: no dialog lifecycle can destroy drafts, and drafts +
pending edits mirror to localStorage.

## Build
### A. Lock/unlock (the axis)
- A single unlock control (repurpose the "Bulk Add" button → an unlock toggle,
  lock/unlock icon + label). UI-only state (not URL). Locked = read-only; unlocked
  = entry zone + inline edit. Works identically in endless and focus, ledger and
  pivots. Locking with unsaved work is SAFE (state + localStorage persist, reappear
  on unlock) — a small non-blocking "N unsaved kept" hint, no confirm dialog.

### B. Draft entry zone (retire the modal)
- First, extract the modal's brains (`mapBulkRowToDirty`, row types/constants)
  into a client-safe module (heed the CLAUDE.md client/server boundary trap), used
  by the draft zone.
- Airtable-style blank rows at the ledger's BOTTOM edge (oldest-first → bottom is
  the append edge). Reuse the shared grid cell/paste/keyboard hooks (`GridCell`,
  `SelectCell`, `DatePickerCell`, `useGridKeyboardNav`, `useGridPaste`,
  `useCellSelection`, etc.) for full modal parity (typing, Tab/Enter nav, Excel
  paste with auto-extend). Escape cancels only the CURRENT cell — never clears
  rows.
- **Endless caveat (locked):** after a period JUMP the loaded window's tail is not
  the global newest. The entry zone must anchor to the TRUE latest — provide a
  "jump to latest" affordance and/or only surface the zone when `hasNewer===false`.
  Never append drafts to a mid-history window. In focus scope the entry edge is
  simply the (loaded) month's bottom.
- Drafts render as tinted rows; a pinned "Save N rows" bar; commit through the
  EXISTING `saveProductionEvents(dirtyRows, [])`. Validation errors block save +
  highlight cells + persistent `errorToast` (HARD RULE). After success: clear
  drafts + mirror, then reconcile the window (the hook must `refreshNewest()` /
  merge inserted rows — `revalidatePath` alone won't refresh client-held pages).

### C. localStorage loss-proofing
- Mirror drafts (and, per D, pending edits) on every change, debounced ~300ms,
  keyed to surface + user id, storage-versioned. Restore on mount. Clear ONLY on
  confirmed save. (Pattern precedent: `dev_mock_role`, next-themes.)

### D. Inline edit of committed rows
- Unlocked, committed cells become editable using the SAME shared grid editors +
  dirty tracking (existing/new/modified/deleted) the focus grid uses today. One
  unified edit session + one Save bar spanning drafts + edits ("3 new · 2
  modified · 1 deleted"); one `saveProductionEvents(dirtyRows, deletedIds)` call.
- **Virtualization constraint (endless):** per-cell/row edit + dirty state MUST
  live in the edit session keyed by row/event id — NEVER in component-local state
  inside a recycled virtual row. A dirtied row scrolled out and back must keep its
  pending value. Consider virtuoso `increaseViewportBy` to reduce editor churn.
- W6/W7 pivots are already editable in focus — extend that editing to the endless
  (virtualized) pivot rendering under the same unlock.
- After save, refresh loaded pages touching dirtied ids (simplest correct: refetch
  the loaded window around the viewport), keeping the viewport stable. A recv_date
  edit may relocate a row in canonical order — accept the relocation without
  crashing the window merge.

### E. Retire the modal
- Delete `bulk-add-modal.tsx` + its mount/trigger; grep stray imports. Log the
  data-loss bug in `docs/BUG_LEDGER.md` (root cause: no close-guard +
  reset-on-reopen; fix: modal retired, entry moved to the loss-proof zone) → move
  to Fixed with the commit hash once committed.

## Verify yourself (real dev server, auth-gated — same guidance as prior phases)
- `env -u ANTHROPIC_API_KEY npm run build` passes.
- The draft-loss gauntlet (what the modal failed): draft rows (typed + pasted),
  then (a) Escape → survive; (b) click outside → survive; (c) lock→unlock →
  reappear; (d) reload → restore from localStorage; (e) Save → land in committed
  history + drafts/mirror cleared; (f) invalid row → save blocked with copyable
  error; (g) Discard all → confirm → reset.
- Inline edit: edit a committed cell (endless) → tint + Save count; scroll the
  dirtied row far out and back → dirty value intact (recycling test); edit rows in
  two different months + a draft + a delete → Save once → all land (verify by
  query) + render correctly after reload; recv_date edit across a month boundary →
  relocates without crash/viewport jump.
- All SIX view×scope combos still render; lock mode is byte-for-byte read-only.
- Clean up any test rows written to the real table; say so explicitly.
- Screenshots: draft zone with tinted drafts + Save bar; mixed dirty state
  (new+modified+deleted) + unified Save bar; survival after reload.

## Bookkeeping (same changeset)
Update `app/(app)/cenapro/CONTEXT.md` (modal removed, lock/unlock, entry zone,
localStorage, unified edit across view×scope) + `TIMELINE.md`; append the
bug-ledger entry. No commit/push.

## Report back
What was built; files changed/deleted; decisions beyond the spec (+ why); the
verification results (esp. the loss-survival + recycling + multi-page tests);
any follow-up debt.
