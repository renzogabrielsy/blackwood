# PROMPT — Cenapro Ledger Phase 1 (REVISED): Axis framework + endless Ledger

## Before anything else
1. Read `TIMELINE.md`, `CLAUDE.md`, then
   `.agents/prompts/cenapro-ledger-endless-sheet-spec.md` (the 2-axis spec — read
   the REVISION NOTE; its decisions are locked).
2. Read `app/(app)/cenapro/CONTEXT.md` (Production section) and
   `components/shared/grid/CONTEXT.md`.
3. Read the Phase-1 v1 code already on disk: `page.tsx`, `actions.ts`
   (`fetchLedgerPage`), `use-ledger-window.ts`, `production-endless-sheet.tsx`
   (incl. `LedgerModeToggle`), `production-view.tsx`, `period-picker.tsx`, and
   skim `production-ledger-grid.tsx` (its `ViewModeSwitcher` / `?view=` handling)
   + `production-daily-block.tsx`.
4. **Enter plan mode, present the plan, get approval, then execute.** Delegate to
   the senior-frontend-engineer subagent (opus). Verify output on disk after.

## Goal
Replace the `?focus` SILO with the correct two-axis model:
- **View axis** `?view=ledger|daily-w6|daily-w7` — keep the existing switcher.
- **Scope axis** `?scope=endless|focus` — NEW; `endless` default (omit param).
  `endless` = the infinite cursor-guided sheet; `focus` = clamp to the selected
  `(batch_year, batch)` — a PURE month-clamp, no exclusive features.
The View switcher must be available in BOTH scopes. Editing stays OFF this phase
(read-only; the lock/unlock lands in Phase 3) — but do NOT bake "endless =
read-only" in as an identity; leave clean seams for Phase 3.

## Build
1. **URL model.** Introduce `?scope` (`parseScope()` → `'endless'|'focus'`,
   default endless, invalid/absent → endless; `endless` omits the param). Keep
   `?view` + `?year` + `?batch`. Retire `?focus` (map a legacy `?focus=1` →
   `?scope=focus` for back-compat, mirroring how `?view=daily` → `daily-w6`).
2. **`page.tsx` rework.** Branch on BOTH axes:
   - Always fetch the period list.
   - `scope=focus` → the EXISTING month-scoped path: `fetchProductionEvents(period)`
     → `<ProductionView>` (which already honors `?view` for ledger/W6/W7 and is
     fully editable today). Unchanged behavior inside focus.
   - `scope=endless` + `view=ledger` → server-prefetch the first anchored window
     via `fetchLedgerPage` → `<ProductionEndlessSheet>` (the built renderer).
   - `scope=endless` + `view=daily-w6|daily-w7` → Phase 2 builds the endless
     pivot. THIS phase: decide + state in the plan one of (a) render the existing
     month-scoped daily block with a small "endless coming in a later pass" note,
     or (b) fall back to focus rendering for W6/W7 endless. Either keeps the app
     coherent; Phase 2 fills the true endless pivot. Do NOT leave W6/W7
     unreachable in endless.
3. **Unified toolbar controls.** The View switcher (ledger/W6/W7) + a Scope
   toggle (Endless/Focus) + the period dropdowns render in BOTH scopes and all
   views (a lone survivor spans full width). The dropdowns: in endless =
   jump-to anchor; in focus = the clamp selector — SAME control. Preserve
   `view`/`year`/`batch` across a scope toggle. Reuse/extend `LedgerModeToggle`
   into a proper axis toolbar (rename if clearer, e.g. `LedgerControls`).
4. **Endless Ledger reuse.** `production-endless-sheet.tsx` + `useLedgerWindow` +
   `fetchLedgerPage` are the foundation — keep them. Dropdown jump = `router.replace`
   → server re-prefetch → anchor-keyed remount (the approved single-seeding-path).
   No sort toggles in endless; sort toggles remain in focus only.
5. **Do NOT touch** `bulk-add-modal.tsx`, the grid's editing internals, or the
   write path this phase (beyond mechanical shared-helper extraction).

## Verify yourself (real dev server — it is now UNBLOCKED; `env -u ANTHROPIC_API_KEY npm run dev` via preview_start; auth-gated so coordinate/Renzo may need to log in — if you cannot authenticate, say so and rely on `npm run build` + a code walkthrough, flagging live-verify pending)
- `env -u ANTHROPIC_API_KEY npm run build` passes.
- All SIX view×scope combinations render (no dead-ends): ledger/W6/W7 × endless/focus.
- endless+ledger opens at the bottom (newest); dropdown jumps anchor correctly;
  scroll up loads older with no viewport jump; scroll down streams newer.
- focus (any view) reproduces today's exact grid/daily-block incl. editing + sort.
- Toggling Endless↔Focus preserves view/year/batch. Legacy `?focus=1` still works.
- Bulk Add modal still works (untouched). Narrow viewport horizontal-scrolls.
- Screenshots: endless+ledger at bottom, an anchored old-period, focus+W6.

## Bookkeeping (same changeset)
Update `app/(app)/cenapro/CONTEXT.md` (the 2-axis model, `?scope`, retired
`?focus`, the reused endless pieces) + `TIMELINE.md` (supersede the Phase-1 v1
entry — note the reframe). No commit/push.

## Report back
What was built; every file changed (paths); how you handled endless+W6/W7 this
phase (option a/b); the build result (exact); verification (or pending + why);
anything for Phase 2 (endless pivots).
