# 2026-09-25 — SESSION WRAP: Blocking lenses & prints, blend analysis, sync L-053/L-054, decision-model research

> **Read this one first.** It wraps one long session (2026-09-18 → 2026-09-25) that already produced
> eight per-round handoffs (§7). Those hold the detail; this is the map, the current state and the
> open decisions. Continues `2026-09-17-session-wrap-operations-ledger-excel-print.md`.

## 1. TL;DR
- Shipped, all on `main` and deployed: the **Operations Excel export** and **RC Movement colour print**
  (09-18); the whole **Blocking "Highlight" lens system** — Price, Age, Supplier lenses, legend bar,
  settings popover, four-section header strip, per-lens prints with yard map, market context and
  supplier price-vs-volume pages (09-19 → 09-23); **blend proposal analysis pages** (natural-breaks
  price groups, quality, age) with supplier/age columns and a yard map in the print (09-21 → 09-23).
- Two real **sync bugs** found from Renzo's own flag report and fixed on the worker (Fly **v33**):
  **L-053** the worker invented long month names (`SEPTEMBER-26-BLK12`) → short convention;
  **L-054** MC's scratch sums under the RC DELIVERIES table were read as 500,000 kg deliveries and
  stopped only by a NOT NULL column → positive-signal row rules.
- Research delivered (no code): **Jev / Laya decision models** — recommendation Laya self-hosted in
  shadow mode on Sync Review; the blocker is labelled verdicts (84 of 94 held cases are only
  "investigated"). Start logging verdicts before anything else.
- **Next concrete action:** apply the L-054 stray-row guard to `workers/sync/src/reports/gsheet/extract.ts`
  (~line 263 — same unguarded split-row copy), then Renzo's three pending calls (§5).

## 2. What shipped (branch → merge)
| Round | Branch | Merge | Handoff |
|---|---|---|---|
| Ops Excel export + RC Movement print | `feat/ops-excel-export`, `feat/rc-movement-print` | `0d16043`, `569dbac` | `2026-09-18-ops-excel-export-and-rc-movement-print.md` |
| Price lens | `feat/blocking-price-lens` | `3778e19` | `2026-09-19-blocking-price-lens.md` |
| Age lens | `feat/blocking-age-lens` | `f4e0265` | `2026-09-19-blocking-age-lens.md` |
| Strip, legend bar, blend supplier/age, stuck-lens fix | `feat/blocking-strip-legend-blend-facts`, `fix/blocking-strip-wrap` | `d685a9b`, `288bd4d` | `2026-09-21-blocking-strip-legend-bar-blend-facts.md` |
| Blend analysis pages + lens print | `feat/blend-analysis-pages` | `373560e` | `2026-09-21-blend-analysis-pages-and-lens-print.md` |
| Supplier lens, terse captions, page breaks, warehouse-grouped lens print | `feat/blocking-supplier-lens` | `c8f160b` | `2026-09-22-supplier-lens-and-print-fixes.md` (+§7 yard map, §8 ₱/KG + palette) |
| Yard map page; ₱/KG column; print palette | `feat/lens-print-yard-map`, `fix/lens-print-palette-supplier-price` | `55d5832`, `d5e8dd7` | same file |
| Market context, supplier price-vs-volume, per-warehouse price pages | `feat/lens-print-context` | `f3be4e3` | `2026-09-22-lens-print-context.md` |
| Blend print yard map | `feat/blend-print-yard-map` | `bd22115` | same file §7 |
| L-053 short month prefix + 3 renames | `fix/sync-short-month-prefix` | `86d34d9` (Fly v32) | same file §8 |
| L-054 stray rows | `fix/sync-stray-rows-l054` | `71d3346` (Fly v33) | same file §9 |

Migrations applied this session: `20260919025729` price lens · `20260919133042` age lens ·
`20260921034512` blend block facts + typed cut line · `20260921084500` natural breaks + blend analysis ·
`20260922011759` supplier lens · `20260922051500` supplier weighted price · `20260922093000` price
lens warehouse subtotals · `20260922094500` market context + supplier market. Verify scripts:
`verify-blocking-{price,age,supplier}-lens.ts` (95 / 49 / 90), `verify-blend-block-facts.ts` (42),
`verify-blend-analysis.ts` (71), `verify-blocking-lens-ui.ts` (228), `verify-blend-analysis-ui.ts` (97),
`verify-ops-excel.ts` (27), `verify-rc-movement-grid.ts` (23), `verify-findings.ts` (100).

## 3. Critical learnings (the ones a fresh context cannot reconstruct)
1. **A worker that invents names must invent them in the house convention** (L-053). The email
   extractor's `MONTH_ABBR_VALUES` held FULL month names; derived codes diverged from typed ones and
   the Sheet's SUMIFS went blank on D-12D, hiding 39,570 kg behind a "residual". `shortMonthPrefix()`
   in `lib/months.ts` is now the one table; MARCH/APRIL stay long because the data does.
2. **A NOT NULL constraint is not a validation rule** (L-054). "Missing supplier" and "weight outside
   range" were WARNINGS; the wet-sack split rule copied a truck onto weight-only rows 14 rows away.
   Now: own-cell supplier + plate, split only on the NEXT row, date-only forward-fill, 0 < kg ≤ 60,000,
   `lab_results = {}` never `null`. **The Average row is NOT an end-of-table marker** — real trucks sit
   below it in AUGUST 2026.
3. **The blocking cross-check skips a non-numeric Sheet balance in silence** (`blockBalance.ts`,
   `sKg` null → no B1 diff and dropped from the Sheet sum). Documented, deliberately NOT fixed — Renzo
   chose the root cause over a louder alarm.
4. **Two `router.replace` calls in one tick race** and remount whatever a `useOptimistic` URL param
   gates; a request that lives only inside a debounce timer is cancelled by that remount; guard replies
   by request SIGNATURE, not a monotonic counter; an eternal spinner needs a watchdog + Copy/Retry.
5. **A `flex-wrap` row's max-content is its ONE-LINE width** — a section that always renders stacked
   must be BUILT stacked or it starves its neighbours (the header strip 4+1 / 3+1 wrapping).
6. **Test the statistical method on the owner's real data** — mean ± SD is wrong for a bimodal blend;
   natural breaks (Jenks) found the ₱42 | ₱47 gap. `numeric[]` subscripts are not O(1): search in
   `double precision`, publish in `numeric`.
7. **The grid COALESCEs lab stats to 0** — `0.00 ash` is a blank; treat ≤ 0 as unmeasured and publish
   both the honest and the snapshot figure. Each lab stat needs its OWN coverage weight.
8. **Paint by meaning**: cost = emerald→rose, age = sky→fuchsia, supplier = 12 categorical hues; a
   print palette must be light with black ink (≥ 7:1) — and equal-luminance categorical hues print as
   ONE grey on a mono printer (stated, not hidden).
9. **Print pipeline traps**: `ResponsiveContainer` sizes a frame late under `printCard` → hand-drawn
   SVG; `printCard` clears marks on `afterprint` AND after 1000 ms and headless Chromium fires
   `afterprint` on a no-op `window.print()` → stub both; a map sharing a data-sized page is legible
   only by luck → own page with its own measured reserve; a raw NUL byte in source diffs as nothing.
10. **Agent hygiene** (in memory now): stopped agents cannot be resumed but their worktree can be
    picked up by a fresh agent at the absolute path; briefs must forbid `git stash` and stored-credential
    workarounds (one agent used the CLI keychain token for the Management API — outcome fine, unasked);
    fixture adapters need ~300 ms latency; `preview_start` serves the MAIN checkout.
11. **Supplier dominance vs apportionment**: a block belongs to its DOMINANT supplier (tint), kilos are
    APPORTIONED by share (ratio bar); `view_blocking_block_suppliers.kg` is DELIVERED kilos, not balance.
    A per-supplier ₱/kg is the price of the blocks a supplier dominates, never that supplier's charcoal.

## 4. Current state
### 4.1 Working and proven
Every gate green at every merge (tsc, build, lint baseline 16 pre-existing errors in `workers/sync/test/**`
and untouched files). Worker tests 1,082; parity 12/12 with 79 expected deviations + two DORMANT
registered (L-053 long names, L-054 stray rows). Fly **v33** healthy. Vercel on `main` `71d3346`.
Renzo confirmed on the live app: lenses tint, strip holds, prints look right ("all have been good so far",
"looking great").

### 4.2 Known issues / unverified
- **`gsheet/extract.ts` ~line 263 has the SAME unguarded split-row copy** L-054 fixed in the email
  extractor (only its lab writes were fixed). Next action.
- Cross-check blind spot on a blank Sheet balance (§3.3) — documented, not fixed.
- 15 `AUGUST-26-…` batches (BLK1–9, 11, 13, 14, FEED2–4) still carry the long prefix the worker
  invented; the alias keeps them working. `AUGUST-26-FEED2` sits beside `AUG-26-FEED2` (the L-042
  phantom-weight leftover — `FEEDING # 2` batches still hold 18,650 kg; cleanup never approved).
- Two migration files carry a local-name / remote-version skew (`blocking_age_lens`,
  `blend_block_facts_…`); harmless until `db push` bookkeeping complains.
- Supplier map prints as one grey in mono (equal-luminance palette by design).
- Nothing in the lens/print rounds was exercised by an agent on the real signed-in page; Renzo's use is
  the verification.
- Carried from 09-17: the untraced AUGUST 12,314 kg fed drop (`rc_out` has no audit trigger); EOQ strip
  price bases; group PC-cost coverage rule; Checks-tab `SUM`-of-nothing reading; proposal print is 8
  sheets with every page on.

### 4.3 Housekeeping
Merged worktrees under `.claude/worktrees/agent-*` can be removed. A task chip exists for the NUL bytes
in `app/dev/table-playground/lens-fixture-lab.ts` (git stores it as binary).

## 5. Open decisions (Renzo)
1. Rename the 15 `AUGUST-26-…` batches to `AUG-26-…`?
2. Keep `MARCH`/`APRIL` long (data-driven) or force `MAR`/`APR`?
3. Spread supplier-map luminance for mono printers?
4. Decision models: start logging agent-report verdicts (a hook) and Sync Review verdicts so Laya has
   training labels; GPU spend for a first fine-tune (Fly GPU hour or Kaggle) when data exists.
5. Everything in §4.2 carried from 09-17.

## 6. Next concrete action
`workers/sync/src/reports/gsheet/extract.ts` around line 263: port the L-054 rules — a row is a delivery
only if its OWN cells carry supplier AND plate; a split row inherits its truck only from the very NEXT
row with its own sacks/remark; only the date forward-fills; `0 < weight_kg ≤ 60,000` else
`weight_out_of_range`; stray weights → `stray_row` findings (builders already exist in
`lib/sync/findings.ts`, reuse them). Reuse `workers/sync/src/reports/deliveries/extractionNotes.ts` and
`lib/labResults.ts`. Replay the stored Sheet workbooks (`sync-inbox/<runId>/gsheet/…`) before/after to
prove byte-identity minus strays. Tests, parity registration, worker build + container gate, then
`npm run deploy` (Fly v34). Spec: `workers/sync/specs/deliveries.md` §13.

## 7. The per-round handoffs this wraps (newest first)
`2026-09-22-lens-print-context.md` (+§7 blend yard map, §8 L-053, §9 L-054) ·
`2026-09-22-supplier-lens-and-print-fixes.md` (+§7 yard map, §8 ₱/KG + palette) ·
`2026-09-21-blend-analysis-pages-and-lens-print.md` · `2026-09-21-blocking-strip-legend-bar-blend-facts.md` ·
`2026-09-19-blocking-age-lens.md` · `2026-09-19-blocking-price-lens.md` ·
`2026-09-18-ops-excel-export-and-rc-movement-print.md`.

## 8. Git state
`main` @ `71d3346` = `origin/main`, tree clean apart from the standing machine-local diffs
(`.claude/agent-memory-local/**`, `supabase/.temp/cli-latest`). Every feature branch kept, unmerged
nothing. Fly worker **v33**. This file + the TIMELINE row are committed right after writing.
