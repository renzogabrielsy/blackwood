# SPEC — Cenapro Production Ledger: The Endless Sheet (2-axis architecture)

This is the SHARED SPECIFICATION for the Cenapro Production Ledger rework. It is
not an executable prompt — the phase prompts (`cenapro-ledger-phase1-*.md`,
`cenapro-ledger-phase2-*.md`, `cenapro-ledger-phase3-*.md`) all read this file
first. Decisions here were made by Renzo (2026-07-21) and are LOCKED. If
implementation reveals a genuine conflict, surface it and ask — do not silently
deviate (a silent architectural shortcut is exactly what this revision corrects).

> **REVISION NOTE (2026-07-21, after Phase-1 v1 review).** The first Phase-1
> build collapsed two independent ideas into one `?focus` toggle: it made
> "endless" mean *read-only flat ledger only* and "Focus" a junk drawer holding
> *everything else* (the editable grid AND the W6/W7 daily views). Renzo
> rejected that coupling. This spec now encodes the correct **two-orthogonal-axes
> + orthogonal editing** model. Some Phase-1 v1 code survives as foundation (the
> keyset server action, the `useLedgerWindow` hook, the endless Ledger renderer);
> the `?focus`-as-silo framing does not.

## The problem being solved (unchanged)

The Bulk Add modal (`bulk-add-modal.tsx`) is fragile: Renzo has repeatedly lost
~20 rows of drafted production entries. Root cause: (1) the Dialog has no
close-guard — Escape / outside-click fire `onOpenChange(false)` unconditionally;
(2) a `useEffect` resets the draft rows to 8 blanks every time `open` becomes
true, so drafts are destroyed on the NEXT OPEN with no recovery. The modal is
being RETIRED; the ledger itself becomes the entry surface.

## The corrected architecture — THREE independent axes

Every combination is valid. Nothing is exclusive to a mode.

1. **View axis** — `?view=ledger | daily-w6 | daily-w7` (KEEP the existing
   switcher / `ViewMode` union / `parseViewMode()` / `plantViewOf()`). *What*
   you are looking at: the flat ledger, or the W6 / W7 daily pivot.
2. **Scope axis** — `?scope=endless | focus` (NEW; `endless` is the default and
   omits the param to keep URLs clean). *How much history* is in view:
   - **Endless** — ONE continuous, virtualized, oldest-first view of the ENTIRE
     history, lazy-loaded bidirectionally with keyset pagination. The Year +
     Batch dropdowns are a JUMP-TO anchor: the first query is already anchored
     at the selected period; you scroll both directions across month boundaries.
   - **Focus** — clamp to the single selected `(batch_year, batch)`. PURELY a
     month-clamp — it carries no exclusive features. This is what gives clean
     per-period totals and the existing sort toggles.
3. **Edit axis** — a lock/unlock, FULLY orthogonal to view and scope. Read-only
   until unlocked; unlocking enables entry + inline edit in ANY view and ANY
   scope. "Endless is read-only" is NOT a permanent identity — it is just the
   locked state.

The old `?focus=1` silo is GONE. `?scope=focus` replaces it as a pure clamp; the
View switcher (ledger/W6/W7) is available in BOTH scopes.

## Locked decisions (Renzo, 2026-07-21)

1. **Full unification in one pass.** All three views (Ledger, Daily W6, Daily W7)
   become endless + cursor-guided. Do NOT ship a siloed intermediate where W6/W7
   are reachable only in one scope. Engineer it in reviewable phases (below), but
   the delivered end state is the coherent 2-axis whole.
2. **Editing works in endless too.** The lock/unlock applies regardless of scope.
   The draft entry zone + inline edit are scope-independent.
3. **Sort order (endless): oldest-first (`recv_date ASC, id ASC`).** Bottom =
   newest = today = where entry happens. Scrolling up walks back through history.
   Focus scope keeps the existing sort toggles (small, fully-loaded slice).
4. **Save model: draft batch + explicit Save**, mirrored to localStorage on every
   change (survives tab close / crash / navigation). No auto-commit per row.
5. **Dropdowns = jump-to anchor** in endless scope; the SAME dropdowns = the
   clamp selector in focus scope. Same control, meaning depends on the scope axis.
6. **Default anchor (endless) = end of the ledger** (newest). Opening `/cenapro/
   production` with no params lands at the bottom, entry edge in view.
7. **Per-day rollups only in endless — NO live cumulative grand-total.** The
   W6/W7 day-blocks keep their per-day "Daily total" footer. There is no running
   total across the infinite scroll (meaningless mid-scroll). Period totals are
   what Focus scope is for. (Confirmed with Renzo — matches his mental model.)
8. **Anchor-first loading is non-negotiable** (every view). The FIRST query is
   already keyset-anchored at the selected period; never load-from-beginning-
   then-teleport.

## W6/W7 endless-pivot mechanics (the hard new part — Phase 2)

The flat Ledger endless is simple (independent rows). The daily views are
PIVOTS, so endless works differently:

- **Paginate by whole prod-days, not rows.** A "page" = the next N *complete*
  production days (ALL events for those prod_dates), so a day's totals/subtotals
  are never computed from a half-loaded day. The keyset cursor is a `prod_date`
  (tiebreak not needed at day granularity, but keep deterministic ordering).
- **Pivot each loaded window client-side** with the existing `buildDateGroups`
  (reuse verbatim), then render the day-blocks into a virtualized, scroll-
  anchored list — the same `firstItemIndex` prepend anchor, now over DAY-BLOCK
  items (each block has internal rowSpans) instead of flat rows. A day-block is
  ONE virtualized item; its internal rows render inside it.
- **Dropdown = jump anchor** → start at the selected month's first prod-day,
  scroll both ways across month boundaries.
- **Rollups stay per-day** (existing daily-total footer). No cross-scroll total.
- **Source filtering unchanged:** W6 = `{TNK 1..4, W6}`, W7 = `{W7}`, FLEC + DVO
  excluded — applied per loaded window before pivoting (existing `SOURCE_SETS`).
- Focus-scope W6/W7 = the EXISTING `production-daily-block.tsx` (month-scoped),
  reused as-is.

## Editing everywhere (Phase 3 — scope-independent)

- **Draft entry zone** replaces the Bulk Add modal (retired). Airtable-style blank
  rows at the ledger's bottom edge (oldest-first → bottom is the append edge),
  reusing the shared grid cell/paste/keyboard hooks. Tinted drafts + a pinned
  "Save N rows" bar through the EXISTING `saveProductionEvents(dirtyRows, [])`
  (no new write action). localStorage mirror (debounced, versioned, keyed to
  user), cleared only on confirmed save.
- **Endless-scope caveat (from Phase-1 v1 review):** after a *period* jump the
  loaded window's tail is NOT the global newest. Drafts must anchor to the TRUE
  latest — provide a "jump to latest" affordance and/or only surface the entry
  zone when `hasNewer === false` (you are genuinely at the bottom of all
  history). Do not append drafts to a mid-history window.
- **Inline edit of committed rows** under the same unlock, in every view/scope.
  The W6/W7 daily block is ALREADY editable in focus (see its CONTEXT) — extend
  that editing to the endless (virtualized) rendering. Virtualization constraint:
  per-row/cell edit state must live in the edit session keyed by row/event id,
  NEVER in component-local state inside a recycled virtual row.
- Retire `bulk-add-modal.tsx`; log the data-loss bug in `docs/BUG_LEDGER.md`.

## Current implementation map (verify line numbers before relying on them)

- **Route:** `app/(app)/cenapro/production/`. Read `app/(app)/cenapro/CONTEXT.md`
  (long — the Production section) and `components/shared/grid/CONTEXT.md` FIRST.
- **Phase-1 v1 artifacts already on disk (foundation to build on):**
  - `actions.ts` → `fetchLedgerPage(input)` + exported `LedgerAnchor`/
    `LedgerCursor`/`LedgerPageInput`/`LedgerPage`. Keyset over
    `cenapro_production_events`, order `recv_date ASC, id ASC`, composite
    `.or('recv_date.<op>.D,and(recv_date.eq.D,id.<op>.I)')`, page size 100,
    `latest`=DESC-then-reverse, `period`=resolve-first-row→forward + head-count
    probe. Reuses the single-string-literal `.select(...)`.
  - `use-ledger-window.ts` → self-contained bidirectional keyset pager (no
    TanStack Query). Owns `firstItemIndex` (decremented in the SAME batch as the
    prepend — the canonical react-virtuoso prepend anchor). Exposes `rows`,
    `firstItemIndex`, `hasOlder/hasNewer`, loading flags, `fetchOlder/fetchNewer`,
    `reset(anchor)`.
  - `production-endless-sheet.tsx` → `TableVirtuoso` endless Ledger renderer +
    `LedgerModeToggle`. Opaque frozen header, never-crush min-width, month
    separators derived 1:1 with rows (no separator items — keeps firstItemIndex
    1:1). Read-only cells reuse EXPORTED helpers.
  - `page.tsx` → currently branches on `?focus`. **MUST be reworked** to the
    `?view` × `?scope` model.
  - `production-ledger-grid.tsx` → EXPORTS `toGridRow`, `rowDirection`,
    `rowDirectionTint`, `rowDirectionFrozenTint`, plus (older) `cccFlecBadgeClass`,
    `plantBadgeClass`, `BADGE_BASE`, `formatKg`, `GridRow`. Reuse; don't
    duplicate. Do NOT rewrite its internals except mechanical extraction.
  - `production-daily-block.tsx` → the existing EDITABLE month-scoped W6/W7 pivot
    (`buildDateGroups`, `SOURCE_SETS`, per-day footer, frozen 5-col identity).
    Reused as-is for focus scope; its `buildDateGroups` powers endless pivots.
- **Source:** `public.cenapro_production_events` VIEW, ~755 rows, 16 cols, NO
  `created_at`, all cols nullable in PostgREST. Cursor `(recv_date, id)` for the
  ledger; `prod_date` (day) for the pivot windows. Write path:
  `saveProductionEvents(dirtyRows, deletedIds)` (delete-then-upsert through the
  view; trigger fills `unique_tag`/`batch_year`; `revalidatePath`). Cenapro has
  NO audit-log trigger.
- **Stack:** Next 16.1.6, React 19.2.3, supabase-js ^2.95.3, Tailwind v4.1.18,
  `react-virtuoso ^4.18.11` (installed in Phase-1 v1). `@tanstack/react-virtual`
  exists but is NOT used for this (no prepend-anchor primitive).

## Design-system rules (from CLAUDE.md — enforced)

Excel Standard density (`table-fixed`, px widths, `px-2 py-1`, `text-xs`,
`font-mono` right-aligned numerics). "Never crush, always scroll" (explicit
min-width = Σ column minimums + `overflow-x-auto`). Frozen surfaces are OPAQUE
(`bg-muted`, `.frozen-*` utilities, no alpha/blur over scrolling content). NEVER
animate table rows / no entrance animation on virtualized rows. Errors ONLY via
`errorToast()` (persistent + Copy). Every changeset updates
`app/(app)/cenapro/CONTEXT.md` + `TIMELINE.md`. Mobile: route must not crash on a
phone and must horizontal-scroll; preserve the existing `MobileCardList` path
where present.

## Phasing (engineering decomposition — one coherent delivery)

> **RESEQUENCED (2026-07-21, Renzo).** The fragile Bulk Add modal is the ORIGINAL
> pain and the whole reason this project exists, so its retirement is pulled
> FORWARD ahead of the endless pivots. The draft entry zone depends only on the
> endless Ledger (Phase 1, done) — not on the pivots or committed-row inline edit
> — so it goes NEXT. New order below.

- **Phase 1 (DONE)** — the axis framework + endless Ledger. `?view` × `?scope`;
  Focus = pure month-clamp; View switcher in both scopes; endless Ledger read-only.
  Prompt: `cenapro-ledger-phase1-endless-sheet.md`.
- **Phase 2A (NEXT) — Draft entry zone + retire the modal.** Lock/unlock on the
  endless Ledger → an Airtable-style draft entry zone at the true-latest bottom
  edge; loss-proof (localStorage mirror); Save via the existing
  `saveProductionEvents`. DELETE `bulk-add-modal.tsx`. Focus keeps its existing
  safe inline editing + right-click Insert (the modal was the ONLY fragile path);
  the focus toolbar points bulk entry at the endless sheet. Inline edit of
  COMMITTED rows on the endless sheet + the focus-scope lock semantics are NOT in
  this phase (they land in Phase 3). Prompt:
  `cenapro-ledger-phase2a-draft-entry-zone.md`.
- **Phase 2B — endless W6/W7 pivots** (day-windowed keyset pagination + pivot per
  window + virtualized day-blocks + scroll anchor). Focus W6/W7 = existing daily
  block. Prompt: `cenapro-ledger-phase2-endless-pivots.md`.
- **Phase 3a (DONE, 2026-07-22)** — inline edit of committed rows on the ENDLESS
  LEDGER: id-keyed `editedRows`/`deletedIds`, unified Save, v2 mirror,
  `refreshWindow()`. (Delivered the ledger half of
  `cenapro-ledger-phase3-editing-everywhere.md`.)
- **Phase 3b (FINAL)** — fully-featured editing on the ENDLESS PIVOTS + the
  dirty-navigation guards (incl. fixing the focus daily block's silent-loss
  bug). Informed by the 2026-07-22 three-agent analysis (focus-pivot gap audit,
  virtualization seam audit, pivot-writeback prior art). Prompt:
  `cenapro-ledger-phase3b-pivot-editing.md` — that prompt supersedes the pivot
  sections of `cenapro-ledger-phase3-editing-everywhere.md`.

Each phase leaves the app fully working; the siloed intermediate is never shipped
(Phase 1 already makes W6/W7 reachable in both scopes via the switcher, even
before their endless rendering lands in Phase 2 — in Phase 1, W6/W7 + endless
scope may fall back to the focus/month rendering with a small "endless coming"
note, OR Phase 1 ships the switcher wired and Phase 2 fills endless W6/W7; decide
in the Phase 1 plan and state it).
