# 2026-08-17 — Universal Table Stage 1D: the side-by-side method WORKS, slices 1 and 2 landed

> Third session of the day. `2026-08-17-universal-table-plan-and-phase-0.md` planned the work and
> shipped Phase 0 to `main`. `2026-08-17-universal-table-phase-1-and-the-side-by-side-method.md`
> built the module, failed Stage 1D twice, and prescribed the strangler-fig method.
> **This session executed that method and it worked on the first try, twice.**

---

## TL;DR

**Stage 1D is half done and every gate is green.** Three commits on `feat/universal-table`:
the v2 grid built beside the live ledger (`6dcf030`), two additive platform seams (`eb926ee`),
and editing + the save path (`7696528`). **`deliveries-ledger.tsx` is byte-identical throughout**
— production never moved.

**The method was the whole blocker, exactly as the last handoff argued.** Two prior attempts at an
atomic 3,000-line rewire produced zero lines of rewire. Three slices under the side-by-side method
produced 1,700 lines of working grid, and every one of them was committable on its own.

**v2 can now be typed into and saved** on real receipts at `/cenapro/deliveries?grid=v2`, with
undo/redo, tiling paste and the jump keys — none of which the live ledger has. Still missing: the
toolbar, the column filters, the row context menu and the three dialogs. **That is slice 3.**

**Renzo has not yet reviewed it side by side.** That review is the gate on slice 3, and it was
deliberately not pre-empted.

---

## What shipped

| Commit | Work |
|---|---|
| `6dcf030` | **Slice 1** — `deliveries-grid-v2.tsx` (1,147 lines): column specs, two row families with `occupies()`, the flatten, day heading + `Σ DAY TOTAL` through `renderChromeRow`, both scopes, `firstItemIndex`. Read-only. `page.tsx` picks on `?grid=v2`, defaulting to the old ledger. |
| `eb926ee` | **Seams 4 & 5** — per-cell `addressable`, and `renderHeaderSlot`. |
| `7696528` | **Slice 2** — editing, drafts, undo/redo, paste, the save path, the Save button. New pure `grid-v2-save.ts` (483 lines). Four more platform seams. |

Plus three `chore(memory)` commits from the git guardian (`c35198d`, `373e41b`, `0f5a8be`).

Branch tip `0f5a8be`, pushed. **`main` @ `ff8b583` — Phase 0 only, unchanged all session.**

---

## Critical learnings

**1. The side-by-side method is validated. Do not go back to atomic for a file this size.**
Two attempts × "green or revert" on ~3,000 lines = zero lines written, twice. Three slices ×
"the old file is still the production path" = a working grid. The safety came from **isolation**,
never from atomicity — and the proof is that slice 1 shipped a grid that could not be typed into,
which under the old constraint would have been an unshippable half-thing.

**2. A seam is only ever found by a consumer that needs it — now five times over.** The last
handoff found three (`firstItemIndex`, `renderChromeRow`, `apiRef`). This session found six more,
built five, and **declined one with a written reason**. None was findable by design review; every
one was invisible until a real screen could not be expressed. **This is now the module's dominant
development mechanic** — do not try to design the remaining seams up front, migrate a consumer and
let it tell you.

**3. `occupies()` conflated two questions, and the fix was the SAME granularity lesson as BUG-024.**
A slot either rendered *and* took the caret, or did not exist. RC Deliveries has three computed
columns — the row ordinal, `TTL PRICE`, `PAID?` — that show a value the caret must never stop on,
so slice 1 had to choose, chose content, and bought **three dead Tab stops per row**. A slot may
now carry `addressable?: boolean`, read **only** by the caret-placing paths (nav resolver, jump
keys, `goToRow`); render, tint, selection, paste and the aggregate pill still read `cellExists`.
Additive by construction — the predicate is `slot !== null && slot.addressable !== false`, never
`=== true`, so a family that never mentions the field answers byte-identically to before.

**4. Name a field for the QUESTION it asks, not the answer it used to give.**
`TableNavGeometry.exists` became `addressable`. The two predicates have identical signatures, so
mis-wiring them is a behaviour change **no type can catch**. Renaming made the mistake unwritable
and a scan asserts the wiring. Generalise this: when a boolean splits in two, rename both halves.

**5. THE DRAW-IDENTITY DECISION — the load-bearing choice of this session.** The module keys edits
**per cell**; the ledger's dirty state is *"a `sampleDrafts` entry exists for this receipt"*. The
mismatch bites because **`addSample` inserts AFTER an index and renumbers every draw below it** — so
a positionally-keyed edit map silently re-points every edit beneath the insertion onto the wrong
draw. A moisture figure filed against the wrong sub-sample, saved cleanly, no error anywhere.

The fix is **identity, not migration**: a draw's cells are keyed `D<id>#<the draw's own uuid>`,
never its position. That makes the renumber a **non-problem by construction** rather than something
to remember. Slice 1's `#${index}` is gone and a source scan refuses its return; the assertion
holds **both** schemes side by side so the discarded alternative stays visible. `drawKeyOf` falls
back to `p<position>` — the stored ordinal, not the array index — so even the fallback survives a
reorder.

Two more pieces of that model, each a bug if omitted:
- **`dirtyReceiptIds` folds every dirty row id onto its parent receipt.** Without it a receipt whose
  only change is a lab reading on its third draw never appears under its own id — it would not look
  dirty, would not be counted, would not be saved, and the typing would vanish at the next remount
  **with no error anywhere**.
- **The save reassembles the FULL draw block** because the RPC replaces it; posting only the touched
  draws would delete the rest. `position` is re-derived from block **order**, never read back off
  the stored row — that is what keeps identity and ordering separate.

**6. A bug in PRODUCTION, found by building the replacement.** The live ledger's `toSamplePayload`
runs a lab value through `num()`, so a non-numeric entry posts a **silent NULL inside a save that
reports success**. v2 refuses it by name. Not fixed in the old file — it is untouched by design —
so this is live today and will be cured by the cutover.

**7. `canViewPrices` gating survived the port untouched**, because the money is nulled server-side
in the payload and v2 re-derives nothing. Worth stating: the port did not have to re-implement the
price boundary, which is what makes the boundary sound.

---

## Current state

- Branch `feat/universal-table` @ `0f5a8be`, pushed. `main` @ `ff8b583`, live, untouched.
- **`deliveries-ledger.tsx` (5,575 lines), `actions.ts`, `types.ts`, `use-deliveries-window.ts`
  and `types/supabase.ts` are byte-identical.** Verified per-file with `git diff --quiet`, not
  inferred from a diffstat.
- **No database work anywhere in this effort** — no SQL, no migration, no `types/supabase.ts`.
- Gates, **re-run independently by the orchestrator after every slice**, not taken on an agent's
  word: `tsc` clean · `npm run build` clean · `npm run lint` at its exact **166 problems /
  28 errors** baseline (all pre-existing in `workers/sync/test/**`) · `verify-table-core`
  **34 → 39 → 44** · `verify-rc-deliveries-cells` **120 → 129** · `verify-grid-keyboard-nav` **6** ·
  `verify-rc-formula` **19** · `verify-qc-draw-cells` **36** · **Playwright 33/33**.

### Open decision #1 from the last handoff is CLOSED

**`TABLE_PLAYGROUND` is not set in Vercel production.** Verified directly against the project's
production environment (nine variables, none of them that one), not from the repo. `/dev/table-
playground` is dark on the live site and this branch is safe to merge on that count.

---

## What v2 can and cannot do

**Can, and the live ledger cannot at all:** undo/redo across every mutation · paste one value tiled
into a selection · paste a block taller than the sheet and grow rows for it · Ctrl+Arrow / Home /
End / PageUp / PageDown · column resize.

**Can, at parity:** cell editing (Enter / F2 / double-click / type-over), the two-stage Escape,
Delete on a cell or range, drag-select + Ctrl+C, the 20 blank draft rows and "Add N more rows",
and Save — receipts, their moisture draws and brand-new receipts, through the existing
`saveDeliveries` unchanged.

**Cannot yet (slice 3):** the toolbar (scope toggle, month picker, issue lenses, search), the
per-column filter popovers, the row context menu — **and therefore add/remove draw, revert row,
fill MOIST from draws, copy row** — and the history / assign-cheque / delete dialogs. Also no
unsaved-work axis guard, because v2 writes no URL yet so nothing can navigate away.

### Three known divergences, all recorded in the CONTEXT files

1. **The ledger has THREE hit tiers, v2 has two.** The ledger's `cellExists` is
   `addressable || (ttl on a receipt row)`, so `#` and `PAID?` render **no hit area** and a click
   does nothing. In v2 a click parks the caret there (arrows up/down are then no-ops in that lane;
   Tab and left/right still move). Matching it needs a **second** per-cell flag — "may a pointer
   land here" — which no consumer has asked for, so per the module's own rule it was not built.
   **This is the first thing to settle in Renzo's side-by-side review.**
2. **Cosmetic drift:** the module's header is `text-[11px]` vs the ledger's `text-[10px] font-bold`;
   summary-row cells carry their own padding/border so the month footer sits a pixel or two off;
   the day-total row has an explicit 28px height where the ledger sized to content.
3. **The duplicate-peer and import-flag popovers are `title` text**, not buttons — they need the
   context menu / dialog layer from slice 3.

### The status rail is not missing, it MOVED

The ledger's data-quality rail is an inset box-shadow on one specific `<td>`, and the module has no
per-cell class seam (`rowClassFor` is per `<tr>`, and a `<tr>`-level shadow is painted over by the
frozen cell's opaque background). v2 draws the rail **inside the `#` column's `format`** as an
`absolute inset-y-0 left-0` bar — legal because `cls.inner` is `absolute inset-0` and therefore a
containing block. **A seam was considered and declined**; the workaround is good enough. Noted so
the next reader does not "fix" a rail that is already there.

---

## Open decisions

1. **Divergence 1 above** — does a click landing on `#` / `PAID?` bother Renzo enough to add the
   pointer flag? Only he can answer; slice 3 does not depend on it.
2. Whether to keep `?grid=v2` as a permanent escape hatch after cutover. Standing recommendation
   from the last handoff: **no** — delete it, or it becomes a second grid nobody maintains.
3. Phase 1's §7 questions in `.agents/prompts/universal-table-module.md` remain open; none block
   slice 3.

---

## Next concrete action

**Renzo's side-by-side review first.** The branch push builds a Vercel preview; on it, open
`/cenapro/deliveries` and `/cenapro/deliveries?grid=v2` and make the same edits in both. Settle
divergence 1 and the cosmetic drift in one pass rather than three.

**Then slice 3**, whose scope is exactly what is listed as "cannot yet" above. Note the ordering
trap: **add/remove draw lives behind the context menu**, so the structural half of the draw model
arrives in slice 3 — the identity model that makes it safe is already built and asserted, which was
deliberate.

**Then the cutover**, one small commit: flip the default (or drop the param), delete
`deliveries-ledger.tsx`, delete the alias layer in `types.ts`, re-point the 16 source scans in
`verify-rc-deliveries-cells.ts` at the module, update the CONTEXT files. That commit is small
enough to review properly — which the atomic version never was.

---

## One process note worth keeping

The git guardian **refused an instruction from this orchestrator and was right to.** Told to stage
`.claude/agent-memory-local/` on the grounds that it was "the project's convention", it checked,
found those files had only ever ridden along *incidentally* inside unrelated commits swept up by
past `git add .` runs, and left them out. The orchestrator's standing note has been corrected.
`git add .` still applies to source changes; that path is a standing exclusion.
