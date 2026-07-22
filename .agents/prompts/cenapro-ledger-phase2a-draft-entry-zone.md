# PROMPT — Cenapro Ledger Phase 2A: Draft Entry Zone + Retire the Modal

## Before anything else
1. Read `TIMELINE.md`, `CLAUDE.md`, then
   `.agents/prompts/cenapro-ledger-endless-sheet-spec.md` — esp. the RESEQUENCED
   phasing note, the draft-loss root cause, and "Editing everywhere" (this phase
   delivers the DRAFT-ZONE part of it, NOT committed-row inline edit).
2. Read `app/(app)/cenapro/CONTEXT.md` (Production section) +
   `components/shared/grid/CONTEXT.md`.
3. Read: `production-endless-sheet.tsx` (the read-only endless Ledger — you add the
   unlock + entry zone here), `use-ledger-window.ts` (`hasNewer`, `reset`, and how
   pages are held — you'll add a `refreshNewest`/merge), `actions.ts`
   (`saveProductionEvents`, `fetchLedgerPage`), `bulk-add-modal.tsx` +
   `bulk-paste-utils.ts` (you ABSORB their validation/paste/keyboard behavior,
   then delete the modal), and `production-ledger-grid.tsx` (where the modal is
   mounted + the focus toolbar).
4. **Enter plan mode, present the plan, get approval, then execute.** Delegate to
   senior-frontend-engineer (opus). Verify on disk after.

## Goal
Kill the fragile Bulk Add modal and replace it with a loss-proof DRAFT ENTRY ZONE
on the endless Ledger. After this phase: no Escape, click-out, tab-close, crash,
or navigation can destroy drafted rows, and there is a clear bulk-entry surface in
the normal workflow.

## Scope (tight — do NOT overreach)
IN: lock/unlock on the endless Ledger; the draft entry zone at the true-latest
bottom edge; localStorage loss-proofing; Save via the existing action; DELETE the
modal; repoint the focus toolbar's bulk-entry affordance at the endless sheet.
OUT (later phases): inline edit of COMMITTED rows; endless W6/W7 pivots; unifying
the lock across focus scope (focus keeps its current inline editing untouched).

## Build
### A. Lock/unlock on the endless Ledger
- An unlock toggle in the endless-Ledger toolbar (lock/unlock icon + label,
  compact zinc styling). UI-only state (not URL). Locked (default) = today's
  read-only endless sheet; unlocked = the draft entry zone appears. Locking with
  unsaved drafts is SAFE (drafts persist in state + localStorage, reappear on
  unlock) — a small non-blocking "N drafts kept" hint, NO confirm dialog.

### B. Draft entry zone — IN-LIST INFINITE BLANK ROWS (refined 2026-07-21)
> **REVISION.** The pinned-section approach the first 2A build shipped is being
> replaced with the more natural "Google Sheets" model Renzo asked for: the blank
> editable rows are part of the SAME virtual list, appended below the last
> committed row, and you scroll DOWN into an effectively-infinite supply of them.
> Locked = the list bottoms out at the newest committed row (as today). Unlocked =
> blanks appear below it and top up as you scroll. This was validated against
> prior art (see below); stay on react-virtuoso.

- Extract the modal's brains first: `mapBulkRowToDirty` + row types/constants into
  a client-safe module (or reuse `bulk-paste-utils.ts` if it already stands alone;
  heed the CLAUDE.md client/server boundary trap).
- **The blank rows are react-virtuoso ITEMS, not a pinned footer.** The virtuoso
  `data` = committed rows PLUS (only when unlocked) a maintained pool of trailing
  blank draft rows. LOCKED → committed rows only, so the list bottoms out at the
  newest entry naturally. UNLOCKED → blanks are appended below; on `endReached`,
  if fewer than N (~25) trailing blanks remain past the last-touched draft, append
  N more (capped top-up — never a runaway). Each blank renders through the SAME
  `itemContent` row renderer as committed rows, so columns + the frozen identity
  cells line up perfectly (this also FIXES the pinned section's unsynced
  horizontal scroll). Draft rows visually distinct (dirty-row tint).
- **Recycling-safe edit state is the ONE non-negotiable.** A draft's data lives in
  a PARENT-OWNED `Map<slotId, DraftRow>` keyed by a STABLE slot id — NEVER in the
  row component's local `useState` (virtuoso recycles/remounts off-screen rows;
  local state is lost — confirmed via virtuoso issues #141/#685). Row components
  read/write the Map by id, so scrolling a half-typed row off-screen and back
  rehydrates it. This is the EXACT pattern `production-daily-block.tsx` already
  uses (its parent-owned `drafts` Map keyed by a deterministic positional slot id
  + `data-navid` registry) — follow it. `firstItemIndex` (top prepend for older
  rows) and the bottom blank-append are ORTHOGONAL (confirmed) — appending blanks
  does not touch `firstItemIndex`.
- Reuse the shared grid hooks (`GridCell`, `SelectCell`, `DatePickerCell`,
  `useGridKeyboardNav`, `useGridPaste`, `useCellSelection`, `useClipboardCopy`,
  `useCellDelete`) for full modal parity: typing, Tab/Enter/arrow nav, Excel paste
  with auto-extend (paste taller than the blank pool spawns more blank slots),
  multi-cell clear. Escape cancels ONLY the current cell — never clears rows.
  Same 12 columns / widths. Optionally `increaseViewportBy` around the active edit
  zone as PERF polish only (NOT the correctness mechanism).

### B2. The single "Add rows" / unlock action (one button, refined 2026-07-21)
- ONE control does everything — no separate "jump to latest" affordance for the
  user to click. On click of Add rows / unlock:
  - If NOT at the true bottom of history (`hasNewer === true`, e.g. you jumped to
    an old month): first `reset({kind:'latest'})` to load the newest window +
    scroll to the bottom, THEN reveal the blank rows.
  - If ALREADY at the bottom (`hasNewer === false`): just reveal the blank rows —
    no jump.
  - Either way you end unlocked, at the true append edge, blanks ready. Never
    append drafts to a mid-history window.
- The focus-scope "Add rows in the sheet →" affordance (§E) drives this same
  single action (navigate to endless + trigger the button).

### C. localStorage loss-proofing
- Mirror the draft rows on every change (debounced ~300ms), keyed to surface +
  user id (e.g. `cenapro-ledger-drafts:<user-id>`), storage-versioned. Restore on
  mount (into the zone if unlocked, else the "N drafts kept" hint). Clear ONLY on
  confirmed successful save. Precedent: `dev_mock_role`, next-themes.

### D. Save flow
- A pinned Save bar whenever ≥1 non-blank draft exists: "Save N rows" + a
  secondary "Discard all" (the ONE destructive action → AlertDialog confirm).
- Validate non-blank drafts via `mapBulkRowToDirty`; on errors block the save,
  highlight offending cells/rows, persistent copyable `errorToast` (HARD RULE) —
  never silently drop a row.
- Commit via the EXISTING `saveProductionEvents(dirtyRows, [])` (insert-only; no
  new action). If it throws, drafts remain (state + mirror) for retry.
- After success: clear drafts + mirror, then reconcile the sheet — the saved rows
  must appear in committed history at the bottom WITHOUT a full reload.
  `revalidatePath` alone won't refresh the hook's client-held pages — add a
  `refreshNewest()` / merge to `useLedgerWindow` and call it. Keep the viewport at
  the bottom so the operator sees the rows land. Success toast may auto-dismiss.

### E. Retire the modal
- Delete `bulk-add-modal.tsx` + its mount/trigger in `production-ledger-grid.tsx`;
  grep for stray imports. Keep `bulk-paste-utils.ts` if the entry zone reuses it.
- Focus scope keeps its existing SAFE inline editing + right-click Insert (the
  modal was the only fragile path — do NOT remove those). Where the Bulk Add
  button was in the focus toolbar, put a small affordance that switches to the
  endless sheet + unlock (e.g. "Add rows in the sheet →" → `?scope=endless` +
  unlock), so bulk entry stays discoverable from focus. Decide the exact UX in the
  plan.
- Log the modal data-loss bug in `docs/BUG_LEDGER.md` (root cause: no close-guard
  + reset-on-reopen `useEffect`; fix: modal retired, entry moved to the loss-proof
  draft zone). Move to Fixed with the commit hash once committed.

## Verify yourself (dev server is UNBLOCKED; auth-gated Google OAuth — if you can't log in, say so, rely on `npm run build` + a careful walkthrough, flag live-verify pending)
- `env -u ANTHROPIC_API_KEY npm run build` passes.
- The draft-loss gauntlet (what the modal FAILED): draft rows (typed AND pasted
  from a spreadsheet-shaped clipboard), then (a) Escape → drafts survive; (b)
  click outside → survive; (c) lock→unlock → reappear; (d) reload the page →
  restore from localStorage; (e) Save N rows → rows land in committed history at
  the bottom, drafts + mirror cleared; (f) invalid row → save blocked with a
  persistent Copy-able error; (g) Discard all → confirm dialog → zone resets.
- After a period JUMP, the entry zone is hidden and the "jump to latest" affordance
  appears instead (no mid-history appends).
- Confirm saved rows actually landed in Supabase (query the view) + render after a
  hard reload. DELETE any test rows written to the real table and say so.
- Focus scope: modal gone, inline editing + right-click Insert still work.
- Screenshots: the draft zone with tinted drafts + Save bar; survival after reload.

## Bookkeeping (same changeset)
Update `app/(app)/cenapro/CONTEXT.md` (modal removed, endless-Ledger lock/unlock +
entry zone + localStorage + true-latest caveat + `refreshNewest`) +
`components/shared/grid/CONTEXT.md` if shared primitives changed +
`TIMELINE.md`; append the bug-ledger entry. No commit/push.

## Report back
What was built; every file changed/deleted (paths); decisions beyond the spec
(+ why); the verification results (esp. the Escape/reload survival gauntlet + the
jump-to-latest behavior); anything for Phase 2B (endless pivots) / Phase 3
(committed-row inline edit).
