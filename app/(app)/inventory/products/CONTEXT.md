# Products — finished-product (flecon) inventory

**Status (2026-09-07): DATA LAYER ONLY.** The schema, views, sync report and types are live
and carrying real data. **There is no page yet** — `page.tsx`, the server actions and the
components are the next agent's work. This file documents the data half so that agent does
not have to re-derive any of it; fill in the Files / Key Behaviors / Dependencies sections
as the UI lands.

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

## See Also

- `workers/sync/specs/products.md` — extraction rules, the rename ladder, findings, and the
  measured sheet defects. **Read this before changing anything about the data.**
- `supabase/migrations/20260907060924_products_inventory.sql` (+ `…062522_…row_hash…`,
  `…063310_…disagreement_columns`) — the schema, with the reasoning in DB comments.
- `app/(app)/inventory/CONTEXT.md` — the inventory route map.
- `components/shared/grid/CONTEXT.md` — the Blackwood Table primitive, and the **57 px
  header-chrome budget** any column width must account for.
