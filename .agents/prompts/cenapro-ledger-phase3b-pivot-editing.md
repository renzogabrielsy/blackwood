# PROMPT — Cenapro Ledger Phase 3b: Fully-Featured Endless Pivot Editing

Target executor: **Opus 4.8, effort HIGH.** This is the final phase of the Cenapro
Production Ledger rework and the most intricate build in the arc. It was preceded
by a three-agent analysis pass (2026-07-22): a feature/gap audit of the existing
focus-mode pivot editing, an architecture/seam audit of the endless pivot
renderer, and prior-art research (Sigma input tables, Anaplan breakback, AG Grid
group editing, Airtable grouped views). Every design decision below is informed
by those findings and APPROVED by Renzo — do not re-litigate; if implementation
reveals a genuine conflict, surface it and ask.

## Before anything else
1. Read `TIMELINE.md`, `CLAUDE.md`, then
   `.agents/prompts/cenapro-ledger-endless-sheet-spec.md` (the 2-axis spec).
2. Read `app/(app)/cenapro/CONTEXT.md` (Production section — long, read the
   `production-daily-block.tsx` and endless-sheet/pivots rows carefully) +
   `components/shared/grid/CONTEXT.md`.
3. Read the code, in this order:
   - `production-endless-pivots.tsx` — the read-only virtualized day-block
     renderer you are making editable (nested-table day-blocks, rowSpan identity,
     filler padding to `MIN_DAY_ROWS`, per-day footers).
   - `use-daily-pivot-window.ts` — the day-window pager (firstItemIndex in
     day-block units; has `reset(anchor)` but NO refresh yet).
   - `production-endless-sheet.tsx` — Phase 3a's PROVEN editing architecture on
     the flat ledger: parent-owned `editedRows: Map<eventId,…>` + `deletedIds:
     Set`, parent-owned `draftRows`, unified Save, localStorage v2 mirror,
     Resume/Discard prompt, unlock toggle, `refreshWindow()`. This is the
     pattern you transplant.
   - `production-daily-block.tsx` — the focus-mode editable pivot: `CellEditor`
     + `cellAccessors` registry (explicit commit), `InsertPopover`,
     `BaggingMetaPopover`, `IdentitySuggestInput`, `columnDisposition`,
     `CellSlot.eventIds` collision locks, the `${prodDate}#slot-{i}` draft
     slot-id scheme, `draftToDirtyRows`. You reuse its pieces but NOT its
     state-locality (see Hard Constraints).
   - `actions.ts` — `saveProductionEvents`, `fetchDailyPivotWindow`.
4. **Enter plan mode, present the plan, get approval, then execute.** Delegate
   implementation to the senior-frontend-engineer subagent (model: opus, effort
   high). Verify subagent output on disk after every completion report.

## Goal
Unlocking the ENDLESS W6/W7 pivots makes them a fully-featured production data
editor — everything the focus pivot can do, plus the capabilities it always
lacked — with the same loss-proofing standard the rest of the rework
established: nothing the operator types can ever be silently destroyed.

## The capability set (what "fully featured" means — ranked by operator value)

1. **Weight edit / clear-to-delete / type-into-blank-to-insert** on real pull
   rows — parity with the focus pivot (Excel click-to-select → type-to-edit,
   explicit commit on Tab/Enter/click-away, Esc reverts; clear stages a DELETE
   with confirm; a typed blank cell opens the column-aware InsertPopover).
2. **New pulls via filler rows** — parity: typeahead identity cells
   (Shift/Grade/Source), typed Recv date, weights; complete identity required;
   one INSERT per filled weight column.
3. **Fix a mis-tagged pull (NEW — closes the audit's #2 gap).** A row-level
   "Edit pull" action (right-click context menu on a real leaf row) opens a
   compact editor (popover or small inline form) for the pull's identity:
   shift, grade, source, recv_date (+ warehouse/side/flec for bagging events).
   On save the affected events UPDATE and the day re-pivots — the row
   RE-BUCKETS into its correct group position after refresh (the AG Grid
   `refreshAfterGroupEdit` pattern). Do NOT attempt live inline editing of the
   merged rowSpan identity cells — the analysis flagged that as structurally
   unsound in the nested-table renderer; the row-level editor is the approved
   design.
4. **Per-row context menu** — Edit pull (above), Delete pull (stages DELETE of
   the row's events, struck-through until save), Duplicate pull (stages a copy
   as a draft). Reuse the shared `GridContextMenu`/`useGridContextMenu`.
5. **Add day (append-edge only) + REMOVE day (NEW — closes the audit's #4
   gap).** "Add day" appends an empty outlined day-block at the NEWEST edge
   only (the analysis showed mid-window insertion fights the pager; append-only
   is the approved scope). An added-but-empty day gets a small remove (✕)
   affordance; a day with only unsaved drafts can be removed with a confirm
   (drafts discarded); committed days are deleted via "Delete day" in a
   day-footer menu → stages DELETE of all that day's events (confirm required,
   shows the event count).
6. **Undo/redo over the unsaved buffer (NEW — closes the audit's #7 gap).**
   Ctrl/Cmd-Z / Ctrl/Cmd-Y (and toolbar buttons) walk an action stack of the
   pending changes (cell sets, inserts, deletes, pull edits, day adds/removes)
   — unlimited depth until Save commits, per the prior-art consensus (Sigma /
   spreadsheet model: undo is pre-save; the audit trail is the record after).
   Undo NEVER touches committed data — it only rewinds the dirty buffer.
7. **Correct per-row batch/batch_year (NEW — closes the audit's #3 gap).** A
   new pull's `batch` derives from ITS OWN prod_date's month name (JANUARY…)
   and, where the writeback contract documents the override, the row's year —
   NOT from a global selected period. A December entry made in January can no
   longer land in the wrong period. Check
   `.agents/notes/daily-block-writeback-contract.md` for the documented
   `batch_year` mechanics; if the dirty-row shape can't express it, extend
   `ProductionEventDirtyRow` + `saveProductionEvents` coercion minimally (still
   never send `unique_tag`).
8. **Loss-proofing (the house standard).** All pending pivot state (edits,
   deletes, drafts, day adds) mirrors to localStorage (extend/namespace the v2
   mirror scheme), restores via the Resume/Discard prompt, and survives
   lock/unlock. ADDITIONALLY (closes the audit's #1 — the severe one): dirty
   state must GUARD navigation — `ViewModeSwitcher`, `ScopeToggle`, and the
   period picker must warn/block (or the mirror must make the switch safe) when
   the pivot has unsaved changes. Apply the same guard to the FOCUS daily block
   (its silent-loss bug is the worst finding of the audit — fixing it there is
   in scope; a lifted shared dirty signal + the existing `disabled`/hint
   pattern is sufficient, no need to port the mirror to focus).
9. **Unified Save.** One toolbar Save ("N new · N mod · N del", matching 3a's)
   builds ONE payload — draft inserts + pull edits (UPDATEs) + deletes — via
   the existing `saveProductionEvents(dirtyRows, deletedIds)`. Validation
   failures block save, highlight the offending cells/rows, persistent copyable
   `errorToast`. Post-save: refresh the window (below) with the viewport
   preserved.
10. **Bagging Tab-flow polish (closes the audit's #5 gap).** After the
    BaggingMetaPopover confirms/cancels, focus RETURNS to the grid at the next
    logical cell (resume the Tab run) instead of stranding the operator.
11. **Collision-locked cells stay locked** (cells whose pivot key maps to >1
    event) — but the lock tooltip gains a "open in Ledger" hint/link (deep-link
    to the endless ledger anchored near that date).

## Hard constraints (from the architecture audit — non-negotiable)

- **No row-local edit state anywhere.** Virtuoso recycles day-blocks; any
  keystroke held in a row/cell component's `useState` WILL be lost on scroll.
  ALL pending state is parent-owned at the top-level pivot component: edits +
  deletes keyed by **event id**; new-pull drafts keyed by **`${prodDate}#slot-i`**
  (the focus block's scheme — parent-owned it survives day-block remounts);
  popover/editor open-state keyed by cell/slot id, never a captured DOM node.
  The focus block's `FillerRow` local-state approach must NOT be copied — its
  content moves parent-side; rows become pure presentation (the `DraftRowCells`
  pattern).
- **One global `cellAccessors` registry + nav state** at the pivot top level
  (register/unregister on mount is fine — it's recycle-tolerant — but the
  registry itself must not live per-day-block).
- **Keyboard nav order is DATA-derived, not DOM-derived.** Build the navigable
  cell-id order from the pivoted `groups` (+ draft slots), not
  `querySelectorAll` — DOM walking stops at the virtualization boundary. When
  the nav target isn't mounted, scroll it into view first, then focus (the
  endless sheet's `pendingScroll` indirection is the model).
- **Popovers must survive scroll**: if the owning day-block leaves the render
  window while a popover is open, commit-or-cancel deterministically — never
  orphan.
- **Collision-lock safety by construction**: cell→eventIds always derives from
  the fresh `buildDateGroups` re-pivot (never cache it across prepends).
- **`refreshWindow()` on `useDailyPivotWindow`** (new): post-save, re-read the
  loaded day-window in place (fresh server read, no stale-overlay merge),
  re-anchor near the pre-save viewport day (model on the endless sheet's
  `pendingScrollToIdRef`). A pull edit that changes prod_date/recv_date simply
  re-buckets on refresh; if it leaves the window, accept it (no crash, no
  viewport jump).
- Locked mode stays byte-for-byte the read-only renderer. Design-system rules
  as ever: opaque frozen surfaces, NO row/entrance animations (chrome only),
  Excel density, never-crush, `errorToast()` only.

## Out of scope (explicitly — do not build)
- Live inline editing of merged rowSpan identity cells (the row-level Edit-pull
  editor is the approved substitute).
- Mid-window "add day" insertion (append-edge only).
- DB-side provenance tagging + audit-log triggers for `cenapro.production_event`
  (audit gaps #8/#9): backend migration work, NOT this phase. Note it in the
  report as the recommended follow-up (supabase-backend-engineer job).
- Any change to the FOCUS daily block beyond the dirty-navigation guard (#8
  above) — its editor keeps working as-is; deep unification can come later.
- The boss-sheet parity items (RECV CCC bucket, tank-composition string) —
  accepted simplifications, still out.

## Verify BEFORE reporting (dev server runs via `.claude/launch.json`; the route
is behind Google OAuth — if you cannot sign in, say so explicitly, rely on
`env -u ANTHROPIC_API_KEY npm run build` + a rigorous walkthrough, and flag
live-verify PENDING; never fabricate a driven test)
- Build passes (exact result in the report). Lint clean on changed files.
- Walkthrough/live gauntlet: weight edit + clear-delete + blank-insert parity;
  new pull via filler; Edit-pull re-buckets a changed grade/shift after save;
  Delete pull + Delete day (confirm + counts); add day at the edge + remove;
  undo/redo across a mixed action sequence, then Save commits exactly the
  net state; a half-typed filler scrolled far off-screen and back keeps its
  keystrokes (the recycling test); reload mid-edit → Resume prompt counts
  everything; view/scope/period switches while dirty are guarded (BOTH endless
  pivot and focus daily block); collision cells locked with the ledger hint;
  per-day totals stay per-day; locked mode unchanged. If test rows were written
  to the real table, delete them and say so.
- Screenshots (if authenticated): mixed dirty day-block (edited + deleted +
  draft rows visible), the Edit-pull editor, the undo toolbar, the guard on a
  dirty view-switch.

## Bookkeeping (same changeset)
`app/(app)/cenapro/CONTEXT.md` (the endless pivots' full editing model, the
navigation guards, the focus-block guard) + `components/shared/grid/CONTEXT.md`
if shared primitives changed + `TIMELINE.md`. Append any newly-discovered bugs
to `docs/BUG_LEDGER.md`. No commit/push without Renzo's say-so.

## Report back
What was built (capability-by-capability against the numbered list); every file
changed (paths); how the parent-owned state + data-derived nav + refreshWindow
work; decisions made beyond this prompt (and why); exact build result;
verification results or live-verify-pending; the recommended backend follow-up
(provenance/audit migration); anything left for a polish pass.
