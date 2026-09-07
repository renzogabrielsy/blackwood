# Products — finished-product (flecon) inventory

**Status (2026-09-07): SHIPPED.** The schema, views and sync report landed first (they are
documented under **Data** below, unchanged); the page at **`/inventory/products`** landed on
the same branch and is documented under **Files** and **Key Behaviors**.

> **NO PESO ANYWHERE IN THIS MODULE.** There is no cost, price or value column on any table,
> view or function below, and none is derivable from them. So — unlike RC IN, Blocking,
> RC Movement and most of `/analytics` — **nothing here needs `canViewPrices()`**, nothing
> needs nulling before a payload leaves the server, and every read is safe for **every**
> role including Production. If a price is ever added, that changes and this note must go.

---

## Purpose

Renzo keeps a link-shared Google Sheet with **one tab per product grade**, tracking finished
charcoal as it moves through stages (`PROD → AYAG → MAGNET → FINAL`, plus `BLENDED`,
`SUNDRY`, `RECLASS`, and `OLD PROD` on Kuraray) in units of **flecons** ("flecs"). What he
asked for, verbatim:

> summarize the products I have on hand (type of grade, amount of flec, kg per flec and
> total volume on hand in tons); show me a running tally as seen in the google sheet;
> automatically add grades in the inventory if there is a new sheet detected (should be
> smart enough to know that a sheet wasn't detected as new because of a rename or anything).

The sync's `products` report reads that sheet every run. **The app never writes here** — the
worker is the sole writer, through three `service_role`-only RPCs.

## Data

### Tables (`public`) — read-only to the app

| Table | Grain | Notes |
|---|---|---|
| `product_grades` | one row per product = one sheet tab | `code` is the canonical identity (`upper`, trimmed, whitespace-collapsed sheet name), UNIQUE and CHECKed. `sheet_name` is the tab as currently typed. `aliases[]` holds former names. `thresholds` jsonb `{ash_max, me50_under, vm_max}`. No hard delete, ever. |
| `product_grade_openings` | `(grade_id, stage)` | The tab's `FLECON STARTING BALANCE` row + its `AS OF` date. |
| `product_movements` | one signed movement | `flec_delta`, `kg_delta`, `remarks`, `source_row`, `row_hash`, `sheet_running` (the sheet's own figures, cross-check only). |

`authenticated` has **SELECT only**; `anon` has nothing. Prefer the views — a page should not
need the base tables at all.

### The four views (all `security_invoker`, `authenticated` SELECT, `anon` revoked)

**`view_product_onhand` — one row per grade. THE page's headline source.**
`prod_flecs`, `old_prod_flecs`, `ayag_flecs`, `magnet_flecs`, `final_flecs`, `blended_flecs`,
`sundry_flecs`, `reclass_flecs`, **`other_flecs`** (a catch-all so a stage invented in a
future tab cannot vanish), `total_flecs`, `shippable_flecs` (= FINAL), `vans_ready`
(= FINAL / 44, the sheet's own formula — reproduced exactly on all five grades),
`kg_per_flec`, `kg_per_flec_distinct_count`, `total_kg`, `total_tons`, `final_kg`,
`final_tons`, `opening_flecs`, `ledger_kg_net`, `movement_count`, `movements_missing_kg`,
`first_movement_date`, `last_movement_date`, `stage_count`, `opening_as_of`, `thresholds` +
the three unpacked threshold numbers, `aliases`, `sheet_running_disagreement_count`,
`date_out_of_order_count`, and the `active` / `sort_order` a list should order by.

**`view_product_stage_balance` — grade × stage.** THE definition of a product balance:
`opening_flecs + SUM(flec_delta)`. Use it for a per-stage breakdown; `view_product_onhand`
is this view pivoted.

**`view_product_ledger` — every movement, with the running balance of EVERY stage as of that
row**, computed in SQL (conditional window sums ordered by `transaction_date, source_row`).
This is the "running tally as seen in the google sheet". **Never recompute a running balance
in TypeScript.** Also carries `sheet_running` (verbatim), `computed_running`,
`agrees_with_sheet` and `date_out_of_sheet_order`.

**`view_product_portfolio` — ONE row**, the whole position across ACTIVE grades:
`total_tons`, `total_flecs`, `final_flecs`, `vans_ready`, `grade_count`,
`active_grade_count`, `grades_without_rate`, `movement_count`, `last_movement_date`.

### Live figures (2026-09-07, after the first ingestion)

| Grade | Stages held | Total flecs | kg/flec | Total tons | FINAL | Vans ready |
|---|---|---|---|---|---|---|
| 8X50 | FINAL 59 | 59 | 550 | 32.450 | 59 | 1.3409 |
| 6X50 | PROD 157 · AYAG 3 · MAGNET 25 · FINAL 187 | 372 | 570 | 212.040 | 187 | 4.2500 |
| 2X6 | FINAL 65 · BLENDED 20 | 85 | 570 | 48.450 | 65 | 1.4773 |
| Kuraray 3x50 | OLD PROD 110 · FINAL 36 | 146 | 590 | 86.140 | 36 | 0.8182 |
| 4X8 | FINAL 35 | 35 | 575 | 20.125 | 35 | 0.7955 |
| **Portfolio** | | **697** | — | **399.205** | **382** | **8.6818** |

808 movements. Every one of those stage balances equals the number the tab itself prints in
its header block, exactly.

### RPCs — `service_role` only; the app must not call them

`fn_upsert_product_grade`, `fn_rename_product_grade`, `fn_replace_product_grade`, plus
`fn_product_grade_fingerprint(jsonb)` (a check copy of the worker's fingerprint;
`authenticated` may EXECUTE it but a page has no reason to).

---

## Six things a UI must get right

1. **`kg_per_flec` MOVES and can be NULL.** It is per grade and it changes over time
   (8X50 550, 6X50 550→570, 2X6 550→570, Kuraray 590, 4X8 575), so it is read back from the
   latest movement that states both numbers — **never hardcode 550**. When it is NULL,
   `total_kg` / `total_tons` are NULL too: "we do not know the fill" and "it weighs nothing"
   are different answers, so render a blank, not a zero. `kg_per_flec_distinct_count > 1`
   means the grade has used more than one rate — worth a quiet footnote, not an alarm.

2. **`vans_ready` is FINAL ÷ 44 and is deliberately fractional.** The sheet prints
   `1.340909091`; rounding it to "1 van" throws away the half a van that is the operational
   point. Show one or two decimals.

3. **`other_flecs > 0` means a stage exists that has no column here.** It is the catch-all
   that stops a new stage disappearing out of `total_flecs`. If it is ever non-zero, surface
   it rather than dropping it — and then add the column.

4. **DO NOT paint the ledger red from `agrees_with_sheet`.** It is false on **448 of 808**
   rows today and that is the SHEET, not the app: the tab's own printed running cells
   disagree with a cumulative sum of the tab's own delta column (measured in sheet order:
   8X50 0/33, 6X50 14/331, 2X6 153/216, 4X8 94/101, Kuraray 117/127). Which side is right is
   settled independently — the tab's **header-block totals agree with our arithmetic on all
   twelve non-zero (grade, stage) pairs exactly**. Use
   `view_product_onhand.sheet_running_disagreement_count` to say it **once per grade**
   ("the sheet's own running column drifts on N rows"), and leave the per-row column for a
   detail/debug view.

5. **`date_out_of_order_count`** flags rows dated earlier than the row above them — four 2X6
   rows are dated `2025-07-29` at sheet rows 229–232, almost certainly a `2026` year typo.
   It is deliberately **not corrected** and affects no balance. Mention it; do not fix it.

6. **`kg_delta` is NULL on one real row and must not render as 0.** `movements_missing_kg`
   gives the coverage per grade.

## Sync behaviour a UI may want to reflect

The `products` report runs with the parallel writers each sync. Its findings appear in the
Sync panel and the Excel report under section **`products`**:
`product_grade_added` (info) · `product_grade_renamed` (info when the content fingerprint is
identical, `attention` + a badge + the measured % when inferred from row overlap) ·
`product_grade_ambiguous` (attention — two candidates matched so **nothing** was renamed) ·
`product_sheet_missing` (attention — a tab is gone; **nothing is deleted or deactivated**) ·
`source_tabs_unreadable` (the shared L-048 channel).

An inactive grade (`active = false`) can only be set by hand — the sync never deactivates
anything — so a page listing grades should filter on `active` and offer no automatic
retirement.

## Files

| File | Role |
|------|------|
| `page.tsx` | Async **Server Component**. Reads `?grade=`, makes ONE adapter call (`getProductsData`) and hands the whole `ProductsData` to the client shell inside a `<Suspense>` (the shell reads `useSearchParams`). Thin: the navbar owns the title, so nothing is rendered here. No tab shell — a standalone inventory route like Blocking and Movement. |
| `components/products-view.tsx` | **The client shell.** Owns the page container, the portfolio line, the sync chips, the grade rail and the `?grade=` URL contract. Renders no number it was not given. |
| `components/grade-tabs.tsx` | The **BIG** grade rail — 60px cards, name at 15px semibold, `FINAL n flec · v vans` in mono 11px beneath. Horizontally scrollable. |
| `components/products-header.tsx` | The **flec-first** header strip: shippable-flec hero, vans, the stage strip, the thresholds/dates column, and the once-per-grade source notes. Also exports `shortDate`. |
| `products-ledger-grid.tsx` | The **running tally** on the Blackwood Table — read-only, sort + filter on. Also exports `STAGE_DOT` / `stageDot`, which the header strip reuses so the two surfaces cannot disagree about a stage's colour. |
| `../../../../lib/products/types.ts` | The **PORT** — `ProductsData` and everything in it. No React, no Supabase. |
| `../../../../lib/products/queries.ts` | The **ADAPTER** — `server-only`. `getProductsData(gradeParam)` + the pure, exported `resolveGrade`. |
| `../../../../scripts/verify-products-grid.ts` | **25 assertions, must stay green.** The measured header/cell width tables, the no-peso scan, the URL contract, the two source-defect rules, and a guard that the throwaway dev fixture was deleted. Run: `npx tsx scripts/verify-products-grid.ts`. |

**There is no `actions.ts`.** The page makes one read and takes no action; the sync worker is
the sole writer of every table underneath it, through three `service_role`-only RPCs the app
must never name.

## Key Behaviors

### `?grade=<code>` is the selection

Deep-linkable, refresh-safe, browser Back returns to the previous grade — the `?block=`
pattern from `blocking-route-view.tsx`. It is matched case-insensitively against the CODE
first (the canonical identity, so `?grade=KURARAY%203X50` works) and then against the
display / sheet name (so `?grade=Kuraray%203x50` works too). **A value naming no grade — a
typo, a retired code, a stale bookmark — resolves to the first active grade rather than
half-selecting anything**, exactly as `?grid=` and `?month=` do elsewhere. Every other param
in the URL survives a grade change (`URLSearchParams` copy, one key touched).

**The selection is OPTIMISTIC, and the split is the point.** This route is dynamic, so
writing the param costs a server round-trip. `ProductsData.grades` already carries every
active grade's full summary, so the **rail and the header strip repaint on the same frame as
the click** and only the LEDGER waits — dimmed `opacity-50` (compositor-only, nothing
reflows) while `selectedCode !== serverCode`. The ledger itself is always rendered for the
**server-selected** grade, never the optimistic one: showing one grade's rows under another
grade's name for the length of a round trip would be worse than waiting.

### The header strip is FLEC-FIRST

Renzo, on the approved Option A mockup: *"I would prefer the header info to be more flecon
amount forward (the final and shippable flecon bag amounts, with the total vans as an
additional info and the total tons as some kind of subtext). Also make the grade tabs
bigger."*

So the hero is **shippable flecs** (`final_flecs`) at 34px — the biggest type on the page,
asserted as such against every size the two presentation files declare. **Vans ready** sits
beside it at 22px as secondary, with `× 44 flec / van`. The **tonnage**, which the mockup
led with, is muted 11px subtext under the hero. Then the stage strip: one cell per stage
with a **non-zero balance**, flecs large and tons small, each with its stage dot.

### The running tally, on the Blackwood Table

`scope="endless"` with **`enableSort` + `enableFilter` switched on explicitly**. That scope
defaults both OFF because an endless grid's window is usually the SERVER's keyset — this
sheet has no such window (no pager, no `startReached`, no `firstItemIndex`; the adapter
hands it the selected grade's whole ledger), so the caveat the default protects against
cannot arise. Month headings and their spacers hide on their own while either axis is
active (`applyTableView`), which is correct: a heading naming a run of adjacent rows is a
lie the moment a sort destroys the run.

**The running lanes are per grade.** They are the stages that grade has ever used — read
from `view_product_stage_balance`, so a stage with movements and a zero balance (6X50's
SUNDRY, 10 movements) still gets a lane and `OLD PROD` appears on Kuraray and nowhere else.
A column of blanks on the other four grades would be a coordinate space with a phantom in it.

**The eight running lanes declare `sortable: false` + `filterable: false`**, and that is
about meaning before pixels: sorting a running balance reorders the very sequence that makes
it a running balance. They therefore pay the BARE 17px header chrome rather than 57, which
is also what lets all eight share one 92px width.

**Column widths pay the chrome budget** (CLAUDE.md → *"The header owes chrome, not just its
label"*). Measured in Chrome at the real computed fonts and pinned in the verify script:
labels at `500 11px Geist` + `letter-spacing 0.275px` uppercase — `DATE` 29.52 · `TYPE` 29.60
· `FLEC` 28.70 · `KG` 15.92 · `REMARKS` 55.37 · the widest stage name `OLD PROD` 59.75. The
`DATE` lane is the one sized by its CELL rather than its header: `2026-09-05` at
`700 12px Geist` is 73.78 and an out-of-order row adds a ⚠, so 105.5 governs against a header
floor of 86.52. (`DATE` measures 29.52 here and 29.52 in `verify-rc-movement-grid.ts`,
measured independently months apart — which is what says the two tables agree about the font.)

### The footer totals the LOADED rows, and says so

Sort and filter live inside `BlackwoodTable`, and no seam hands a consumer the rows that
survived them — so a footer claiming to total *"what is shown"* would be wrong the instant a
filter is on. It reads **`Σ N movements loaded`** with the deltas, and the note lane says
*"Totals cover every loaded row — a filter changes what is listed, not what is totalled."*
The platform's own view strip renders immediately beneath and reports **"N of M rows"**
whenever a filter is active, so the difference is never hidden; it is stated by the surface
that actually knows it.

It is deliberately **not a balance** either: a balance is `opening + Σ delta`, which is
`view_product_stage_balance`'s definition and what the header strip reads. Printing a
"balance" here that ignored the opening would be a second, wrong definition of the number
this page exists to show.

### The two source defects are quiet, and said ONCE

Neither is an error in the app and neither is painted red (CONTEXT → *Six things* #4 and #5).

- **Sheet-running drift** — a muted `~` on the row, and the count in the header note. **A
  marker that would land on EVERY row is not drawn at all**: on 6X50 it is 14 of 331 and the
  mark is exactly the right instrument; on 2X6 it is 216 of 216, where it singles out
  nothing and the count is the whole message. The note then reads *"…on every one of its 216
  rows — so no per-row mark is drawn"*. Same reasoning as a month heading naming the only
  month present.
- **Out-of-order dates** — the date renders muted with a ⚠ and a `title`; the count is in the
  header note. Nothing anywhere rewrites a `transaction_date`, and no `new Date()` is
  constructed on this page at all (dates are sliced from `yyyy-MM-dd`), because parsing a
  stored date back to ask its month is where a timezone moves a row to the previous day.

Two more notes ride in the same block when they apply: **`other_flecs > 0`** (a stage with no
column here — counted in the total by SQL, so it is surfaced rather than silently lost) and
**`kg_per_flec_distinct_count > 1`** (the rate has moved; the figure shown is the latest).

### The sync chips

If the latest finished run raised `products`-section findings, they render as one chip row
above the tabs, linking to `/sync/cases?run=<id>`. It is the **same `flattenRunFindings` over
the same latest-run read** that `app/(app)/sync/needs-you.ts` makes, filtered to
`section === 'products'` on the server — so a chip can never disagree with the panel about
what the run said. **PRIVILEGED only** (Owner / Admin / Dev via `getUserRole()`, so the
dev-impersonation cookie is respected), because every action a chip could offer already
exists in `/sync` and only those roles can take it. It **fails quiet**: every failure path
returns no chips, since a missing chip costs a click into the panel while a fabricated one
sends somebody hunting for work that is not there.

### The reads

One `Promise.all` — `view_product_onhand` (ordered by `sort_order`), the `(grade_id, stage)`
projection of `view_product_stage_balance`, `view_product_portfolio`, the `products`
`ingestion_watermarks` row, and `auth.getUser()`. Then the **ledger for the selected grade
only** (331 rows at the widest today against 808 in total) through `fetchAllRows`, so a grade
that one day outgrows PostgREST's 1000-row cap pages rather than being silently truncated to
its OLDEST 1000 rows. Ordered `transaction_date DESC, source_row DESC` — newest first, which
is what an operator checks.

**Only ACTIVE grades are listed.** The sync never deactivates anything — `active = false` can
only be set by hand — so that filter honours a human decision rather than performing an
automatic retirement.

A ledger failure is **surfaced, never thrown**: `ProductsData.error` fires a persistent
`errorToast()` (Copy button, HARD RULE) *and* renders an inline banner with its own Copy
button, because a toast the operator dismissed leaves no trace of why the tally is empty.

### The ONE piece of arithmetic on this page

`flecs × kg_per_flec / 1000`, for a per-stage tonnage. It is the formula
`view_product_onhand` itself publishes (`total_tons`, `final_tons`) applied to a balance the
DATABASE computed — a unit conversion of a published number, never a second definition of a
balance. The verify script pins it by proving the conversion reproduces the view's own
`final_tons` on all five grades and that the results sum to the portfolio row.

## Dependencies

- `@/lib/supabase/server` — `createClient()` for the five reads
- `@/lib/supabase/paginate` — `fetchAllRows()` for the ledger (DUP-1)
- `@/types/supabase` — `Tables<'view_product_onhand' | 'view_product_ledger' | 'view_product_stage_balance' | 'view_product_portfolio'>`
- `@/lib/auth` + `@/types/auth` — `getUserRole()` / `PRIVILEGED_ROLES`, for the sync chips ONLY (there is no price gate here)
- `@/lib/sync/findings` — `flattenRunFindings`; `@/app/(app)/sync/types` — `SyncRunResult` (type-only)
- `@/components/shared/table` — `BlackwoodTable`, `TableSummaryRow`, `TableChromeRowApi`
- `@/lib/table` — `needsGroupSpacer`, `pinnedOffsets`, `ColumnSpec` / `GridRow` / `RowKind` / `TableSettings`
- `@/lib/hooks/use-table-edits` — the module's single writer port (held idle; this grid never writes)
- `@/lib/toast` — `errorToast()` (persist + Copy, HARD RULE); `@/components/ui/button` — the banner's Copy
- `@/lib/utils` — `cn()`
- `next/navigation` — `useRouter` / `usePathname` / `useSearchParams` for `?grade=`
- `app/globals.css` — the `--bw-year-*` data-viz series the stage dots read

## See Also

- `workers/sync/specs/products.md` — extraction rules, the rename ladder, findings, and the
  measured sheet defects. **Read this before changing anything about the data.**
- `supabase/migrations/20260907060924_products_inventory.sql` (+ `…062522_…row_hash…`,
  `…063310_…disagreement_columns`) — the schema, with the reasoning in DB comments.
- `app/(app)/inventory/CONTEXT.md` — the inventory route map.
- `components/shared/grid/CONTEXT.md` + `lib/table/CONTEXT.md` — the Blackwood Table
  primitive, and the **57 px header-chrome budget** any column width must account for.
- `app/(app)/inventory/flecon-bags/CONTEXT.md` — the closest sibling surface (a per-type
  balance strip over a movement ledger), and the other module in the app with no ₱ in it.
- `components/NAVBAR.md` — the breadcrumb and the Inventory sub-group entry.
