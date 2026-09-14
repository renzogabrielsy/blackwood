# Plant Operations Ledger — three interactive drafts (`/dev/ops-ledger`)

## Purpose

Three **layout drafts** of one screen Renzo asked for on 2026-09-14: a **plant operations
ledger** — one row per calendar day, grouped by **production batch** (the campaign clock),
carrying the columns of his `Q3 2026` Excel tab, with the `EOQ3 2026` rollup on top.

He asked for three interactable webpages, not canvas mockups, and specified that each must
be able to:

1. **toggle which table group is displayed** — column-group chips;
2. **switch back and forth between this ledger and RC Movement** — *"they align perfectly
   actually so we would need to find a way to unite these two things"*;
3. **build group views** — pick which batches/months are in the group (Q3 = July + August +
   September), with a KPI strip or analysis table at the top showing the group's stats;
4. (later, prototyped here) **drop down on a single-row date** to see a breakdown of
   production — the second shift's stats and so on.

**DEV ONLY, and it reads NOTHING.** No Supabase client, no server action, no `view_*`, no
tenant module. Every figure comes from a deterministic in-memory mock. Gated twice, exactly
as `/dev/table-playground` is: `notFound()` in production unless `TABLE_PLAYGROUND` is set,
**and** the path is only added to the middleware's `PUBLIC_PATHS` under the same condition.

## THE UNIFICATION THESIS

> This ledger and `/inventory/rc-movement` are **not two screens**. They are one screen
> showing two different **column groups** over the same **row spine**.

RC Movement is already *days as rows, on the campaign clock*, with five pinned columns —
Date · Day · Fed ₱/kg · Total fed · Produced — and then **one column per opened block** with
kg fed in the cells. The ledger has the identical spine and puts grades, waste streams and a
blocks-used panel there instead. **That is the entire difference between them.**

So all three drafts treat **`blocksFed` ("one column per block") as the sixth entry in the
same toggle registry** as Costs, Production, Grades, Losses and Blocks used — and
**"RC Movement" is a PRESET, not a route** (`_shared/column-groups.ts` → `LENS_PRESETS`).
Each draft states the claim in its own UI copy so Renzo can argue with it, and each takes a
**different position on how literally to fold the two together** (see below).

## Files

```
app/dev/ops-ledger/
├── CONTEXT.md               ← this file
├── page.tsx                 the index: links the three drafts, states the thesis
├── _mock/
│   ├── types.ts             THE PORT — LedgerDay, BlockFeed, ShiftDetail, Campaign,
│   │                        CampaignRollup, OpsLedgerData. No layout imports Supabase.
│   └── data.ts              the static ADAPTER: deterministic generator + OPS_LEDGER_DATA
├── _shared/
│   ├── format.ts            kg · tons · php · phpM · pctFromFraction · hours · count
│   ├── aggregate.ts         GroupDefinition, GROUP_PRESETS, groupRollup()
│   ├── column-groups.ts     COLUMN_GROUPS registry + LENS_PRESETS (the thesis, as data)
│   ├── lens-controls.tsx    LensSwitcher (req. 2) + ColumnGroupChips (req. 1)
│   ├── group-builder.tsx    GroupBuilder popover (req. 3)
│   ├── kpi-strip.tsx        KpiStrip — the group's six headline figures
│   └── day-detail.tsx       ShiftCards + BlocksUsedTable (req. 4) — same content,
│                            three different containers
├── a/{page.tsx, ledger-a.tsx}   Draft A — Excel faithful
├── b/{page.tsx, ledger-b.tsx}   Draft B — Group-first dashboard
└── c/{page.tsx, ledger-c.tsx}   Draft C — Split lens
```

**Nothing outside this directory changed except `middleware.ts`** (one `PUBLIC_PATHS.push`
inside the existing dev-gate block). No file under `components/shared/`, `components/ui/`,
`lib/` or any tenant module was touched.

## What each draft explores

| | Axis | Structure | Trade-off |
|---|---|---|---|
| **A — Excel faithful** | *How little has to change if the sheet stays the sheet?* | Blackwood Table, one campaign behind month tabs; a group is **N stacked tables** under one KPI strip (the workbook's own shape). The day expands into **child ROWS** — one per block (in the eight blocks-used columns) and one per shift. `blocksFed` renders as a **second table below**. | The only draft where the breakdown is in the grid's coordinate space (selectable, totals in the status pill, copies out with its day). But months are separate scroll containers, so nothing is comparable across them. |
| **B — Group-first dashboard** | *What if the GROUP is the unit and the days are the evidence?* | KPI strip → the **EOQ month-by-month table** → **ONE continuous** day ledger with the campaigns as `renderChromeRow` heading rows. `blocksFed` folds into the **same header** — switching lens changes columns and nothing else. Day opens a **side panel**. | Best at "how did Q3 do?" and at comparing months. Costs: ~90 rows in one table, and the breakdown leaves the grid. |
| **C — Split lens** | *What if the day spine and the lens are two PANES?* | Day spine (date · day · fed · produced · yield) in its **own left pane** that never scrolls sideways; right pane is the lens, scrolling horizontally behind a **draggable divider**; the two are **vertically scroll-synced**. Campaigns are **chips**, not a popover. Day expands **inline in both panes at once**. | A 40-column matrix can never push the date off screen, and Ledger ↔ RC Movement reads as a swap rather than a navigation. Costs: a second scroll region, and a divider is not a spreadsheet gesture. |

**C is the one draft NOT built on the Blackwood Table**, deliberately: the grid is one table
with one scrollport, and faking two panes with two grids would give two carets, two selection
rectangles and two status-bar publishers over what the reader sees as one row. It is
hand-built, read-only, and keeps every rule the grid would have enforced (explicit widths,
`min-width = Σ columns`, `overflow-x-auto`, opaque frozen surfaces, no row animations).

## Data (the mock)

`OPS_LEDGER_DATA` is built **once at module scope** and is a pure function of the date
string — the same page renders the same numbers on every machine and in every screenshot.

Four campaigns on the **batch clock, not the calendar** (Renzo's JULY opens 2026-06-30):

| Campaign | Span |
|---|---|
| JUNE 2026 | 2026-05-30 → 2026-06-29 |
| JULY 2026 | 2026-06-30 → 2026-07-30 |
| AUGUST 2026 | 2026-07-31 → 2026-08-28 |
| SEPTEMBER 2026 | 2026-08-29 → 2026-09-27 |

JUNE exists so a group can deliberately **exclude** one (`Q3` = the other three).

Magnitudes are shaped to Renzo's July so the DENSITY is honest: 30–42 t fed on a weekday
(18–27 t on a Saturday), 79.5–86.8% yield, **Sundays blank and still present as rows**, two
shifts, 0–4 h downtime, three grades summing exactly to the day's production, eight waste
streams, and 6–10 blocks drawn from per day summing exactly to the day's fed kg.

Three properties the mock preserves on purpose, because a layout that hides them is lying:

- **A rest day is a ROW.** Dropping blank Sundays would make a month read as 26 days.
- **The eight waste streams do NOT sum to `lossKg`** — most of the loss leaves as moisture
  and volatiles, which nobody weighs. Every draft says so where the numbers are.
- **`resikoKg` is 0 on an open block.** Charcoal still in the pile is not loss yet.

`groupRollup()` **re-sums the DAYS**, never averages the per-campaign rollups: the mean of
three yields belongs to no quarter, and every ₱/kg is weighted by the kilos under it. Stock
is a level, so a group's `rcInventory` is the LAST campaign's, not the sum of three; buying
is a flow, so it sums.

## Key behaviours

- **Price gating is expressed as ABSENCE, never as a blank.** `OpsLedgerData.canViewPrices`
  stands in for `canViewPrices()`; a ₱ column/tile/chip is removed from the coordinate space
  rather than emptied. In the live version the SERVER nulls the field before the payload
  leaves — a draft that reached for the flag itself would teach the wrong shape.
- **Column widths on the Blackwood Table carry the +57px header-chrome budget** and were
  **measured in Chrome against these pages**, not estimated (the table is in
  `a/ledger-a.tsx`). Four columns clipped on the first pass and were widened to their own
  measurement. Verified: zero clipped headers at 1512px.
- **Frozen surfaces are opaque** (`bg-muted` / `bg-background`, never `/90` + blur), with
  `.frozen-col` / `.frozen-row` / `.frozen-corner` / `.frozen-edge` used as documented.
- **No row is animated.** `stagger-children` appears only on the six KPI tiles and the
  index's three draft cards; `animate-fade-in` only on an expansion band. Nothing that
  renders 100+ instances animates.
- **Never crush, always scroll**: every table declares `min-width = Σ column widths` inside
  an `overflow-x-auto` wrapper; the chip rails and campaign rails are `shrink-0` inside
  `overflow-x-auto`. Measured at 375px: **document scrollWidth == innerWidth on all three
  drafts and the index** — no horizontal page overflow anywhere.
- **C degrades on a phone rather than crushing.** Below 768px the split keeps its idea and
  drops the simultaneity: a segmented control swaps which pane is on screen (two panes need
  ~260px each), and the page scrolls instead of the frame.
- **Read-only, structurally.** No `ColumnSpec` declares a `parse` and no `renderEditor` is
  passed anywhere, so `columnAcceptsEdit` is false at every coordinate in A and B; C has no
  inputs at all.

## Verification

`tsc --noEmit` clean · `npm run lint` 16 errors / 111 warnings (baseline 16 / 146; **zero
findings in these files**) · `npm run build` compiled, all four routes emitted · `npx tsx
scripts/verify-table-core.ts` 84 assertions · `npx playwright test` 57 passed.

Rendered in Chromium at **1512 light**, **1512 dark** and **375**, with an expanded/opened day
on each draft and the RC Movement lens on each — 19 screenshots, zero page errors, zero
horizontal overflow.

## Dependencies

`@/components/shared/table` (A and B), `@/lib/table`, `@/lib/hooks/use-table-edits`,
`@/components/ui/{popover,input,sheet}`, `@/lib/utils`, `lucide-react`. Nothing else.

## See also

- `app/(app)/inventory/rc-movement/CONTEXT.md` — the live matrix this thesis is about
- `components/shared/grid/CONTEXT.md` + `lib/table/CONTEXT.md` — the Blackwood Table
- `app/dev/table-playground/` — the other dev-gated fixture, and the gating pattern copied here
- `CLAUDE.md` → "Excel Standard", "Frozen Panes", "Motion & Glass", "Price gating"
