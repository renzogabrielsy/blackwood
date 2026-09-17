# Plant Operations Ledger — `/operations`

> Status: **DATA LAYER BUILT** (2026-09-14, branch `feat/ops-ledger`, migration
> `20260914033037_ops_ledger`). §1 is the brief, §2 is the data layer as shipped and is the
> authority for anyone filling the port. **§3 (UI) is deliberately empty — the frontend agent
> writes it.** The live authority on the data layer is
> `app/(app)/operations/CONTEXT.md` → **Data**; this file records intent and the decisions
> behind it.

---

## §1 — The brief

Renzo keeps a workbook with two tabs per quarter: **`Q3 2026`** (one row per calendar day) and
**`EOQ3 2026`** (the quarter's rollup). The screen is that workbook, live.

**One row per CALENDAR DAY, on the PRODUCTION-BATCH (campaign) clock, rest days included as
blank rows.** Columns in his order:

`DATE · DAY · FED ₱/KG · TTL FED KG · TTL PROD KG · TTL LOSS KG · TTL SHIFTS · TTL DT HOURS`
→ **GRADES** (one column per grade, kg)
→ **LOSSES** (TRML 1 · TRML 2 · RS1A · RS1B · RS2/3 · RS5 · BF · GRITS, kg)
→ **BLOCKS FED** (one column per block the campaign fed, kg — *the RC Movement lens*)

and, on expanding a day:

- **BLOCKS USED** — batch · block loc · date open · date close · state · fed wt · arrival wt ·
  resiko
- the **per-SHIFT breakdown**.

A **GROUP** is a chosen set of campaigns (Q3 2026 = JULY + AUGUST + SEPTEMBER) with a KPI strip
on top — his `EOQ` tab — per campaign **and** for the group as a whole:
`RC FED · PRODUCED · YIELD · LOSS · BLOCK RESIKO LOSS · FED PRICE · ACTUAL FED PRICE ·
PC COST · TRUE PC COST`.

### The unification thesis (from the three drafts at `/dev/ops-ledger`)

> This ledger and `/inventory/rc-movement` are **not two screens**. They are one screen showing
> two different **column groups** over the same **row spine**.

RC Movement is already *days as rows, on the campaign clock*, with one column per opened block.
The ledger has the identical spine and puts grades, waste streams and a blocks-used panel there
instead. The data layer below is built so that claim is *structurally* true, not merely
plausible: `view_ops_ledger_day_block` **is** `view_rc_movement_campaign_cells`, re-keyed.

Renzo picked draft **C — "Split lens"** (a frozen day spine on the left, the lens scrolling in
its own pane on the right, vertically scroll-synced).

---

## §2 — The data layer (BUILT)

Migration **`supabase/migrations/20260914033037_ops_ledger.sql`** — eight views, one group RPC,
two verification probes. Adapter `lib/operations/queries.ts`, port `lib/operations/types.ts`,
proofs `scripts/verify-ops-ledger.ts`.

### 2.1 The governing rule

**Nothing that already has a home is re-derived.** Fed kg, fed ₱/kg, produced kg, the downtime
fold, yield, the shrinkage-adjusted price, block loss and every coverage count are SELECTed
verbatim from the views that own them. What is new here is the **SPINE** (a calendar day inside
a campaign, rest days included) and the **FOLD**.

That is the analytics-phase rule (P1–P4), and it is what the proofs test: a fold that does not
add up to the headline above it, and a "reuse" that quietly re-derives and drifts, are the only
two ways this layer can be wrong.

### 2.2 The objects

| Object | Grain | Rows | ₱ |
|---|---|---|---|
| `view_ops_ledger_campaign_span` | campaign | 32 | — |
| `view_ops_ledger_day` | campaign × calendar day | **686** (≈31/campaign, max 33) | `fed_php_kg` only |
| `view_ops_ledger_day_grade` | campaign × day × grade | 317 (max **48**/campaign) | — |
| `view_ops_ledger_day_block` | campaign × day × block | 2,148 (max **114**/campaign) | — |
| `view_ops_ledger_day_blocks_used` | campaign × day × block | 2,148 (max 114/campaign) | — |
| `view_ops_ledger_shift` | shift | 260 | — |
| `view_ops_ledger_campaign_grades` | campaign × grade | 21 | — |
| `view_ops_ledger_campaign_kpis` | campaign | 32 | 7 columns |
| `fn_ops_ledger_group_kpis(text[])` | one row | 1 | 7 columns |

**Row budget / PostgREST.** No single campaign's lens exceeds 114 rows, so every read is far
under the 1,000-row cap **per campaign** — but `view_ops_ledger_day_block` is 2,148 rows over
all history, so **the page must fetch PER CAMPAIGN and fold**, which is exactly what
`fetchOpsLedger` does (per-campaign reads, run in parallel, each paged through `fetchAllRows`).

**Posture.** All eight views `security_invoker`, `authenticated` SELECT only, `anon` REVOKEd,
**no `service_role`** — the sync worker reads none of them, so `verify-worker-view-grants` stays
at **4 views / 0 findings** (L-044's arrow direction: a consumer is not a dependency). The group
RPC is SECURITY INVOKER, `search_path` pinned, EXECUTE revoked from `PUBLIC` + `anon`, granted to
`authenticated`. Proven by a **real read**: `anon` and `service_role` both get a permission error
from `view_ops_ledger_day`.

### 2.3 The five decisions worth knowing

**1. THE DAY SPINE IS THE UNION OF FEEDING AND PRODUCTION, never feeding alone.** A campaign's
span is `least(first MAIN feed, first shift)` → `greatest(last MAIN feed, last shift)`. Measured
reason: **JULY 2026 last fed on 2026-07-29 and went on producing through 2026-08-01**
(22,862 + 4,620 + 2,466 kg), and **SEPTEMBER 2026 opened its first shift on 2026-08-29, three
days before its first feed**. A fed-only span — which is what `view_rc_movement_campaign_options`
alone would give, and what the RC Movement matrix uses — silently drops real operating days off
both ends. JULY 2026 is therefore a **33-day** ledger, not 30.

**2. `day_drift_kg`, NOT `loss_kg`.** `fed − produced` at DAY grain is drift, not loss: the feed
tank is continuous flow, so a day's fed and produced do not describe the same charcoal. The
column is named for what it is and its DB comment says so. **Real loss is a CAMPAIGN figure** —
`process_loss_kg` (the retort's) and `block_resiko_kg` (the yard's) on
`view_ops_ledger_campaign_kpis`.

**3. NULL IS NEVER 0, everywhere.** A day that fed nothing reads `fed_kg` NULL; a day that
produced nothing reads `produced_kg` NULL; a shift that filed no waste row reads NULL on all
eight streams (`view_production_daily` COALESCEs its waste total to 0 — that is undone here);
`sacks` is NULL before bags were counted. And on the blocks-used expand the same subtraction is
published **twice under two names**: `resiko_kg` (closed — evaporation and resiko, a real loss)
and `balance_kg` (open — charcoal still in the pile, not loss yet), so a UI cannot print one as
the other.

**4. THE GROUP REFUSES TWO NUMBERS IT CANNOT COMPUTE HONESTLY.** A block can be fed by more than
one campaign — **measured: 78 of 523 blocks, up to 5 campaigns each; 5 of Q3-2026's 45 blocks**.
So `Σ weight_lost_kg` over campaigns would charge a shared block's whole-life shrinkage once per
campaign. The group therefore publishes **no resiko KG** (only the fed-kg-weighted ratio) and
**no whole-block `actual_fed_php_kg`** (only the campaign-attributed form, which is weighted by
`campaign_fed_kg_included` — a quantity that *partitions* by campaign, so no kilogram is counted
twice). Block COUNTS are published **de-duplicated** (`blocks_fed_distinct` = 45) beside the
naive sum (`blocks_fed_campaign_sum` = 50), both labelled.

**5. TRUE PC COST IS STRICT NULL UNLESS EVERYTHING IS COVERED — with the partial beside it.**
`php_per_produced_kg_true` is NULL unless every block the campaign fed is CLOSED and fully
priced, and for a group unless *every* campaign is. Q3 2026 is not (SEPTEMBER's blocks are only
78.9% covered), so the group reads **NULL** with `php_per_produced_kg_true_covered` populated and
`campaigns_fully_covered = 2` of `campaign_count = 3` — the UI says *"2 of 3 campaigns fully
covered"* rather than showing a figure that is wrong in a direction nobody can see.

### 2.4 Corrections to the draft port (`app/dev/ops-ledger/_mock/types.ts`)

The draft guessed six things the database disagrees with. The real port is
`lib/operations/types.ts`; each divergence is documented there too.

| Draft | Reality |
|---|---|
| `GRADES` frozen to `['3X50','2X6','4X8']` | **The grade set is DATA.** Read `OpsLedgerData.grades` / `gradesByCampaign` (from `view_ops_ledger_campaign_grades`). `GRADE_DISPLAY_ORDER` governs ORDER only. |
| waste keys `rs3`, `grits` | the columns are **`rs23_kg`** (RS2/3 is filed as one stream) and **`grit_kg`** |
| `ShiftDetail.shift: 1 \| 2` + `window` + `supervisor` | `shift` is a code (**`M`** / **`E`**); there is no stored time window and no supervisor column |
| `ShiftDetail.fedKg` | **does not exist and cannot.** `rc_out` has no shift dimension — feeding is recorded per DATE — so a per-shift fed figure could only be invented |
| `LedgerDay.lossKg`, "every figure is 0 on a rest day" | `dayDriftKg`; and every figure on a rest day is **null**, not 0 |
| `BlockFeed.resikoKg` = 0 while open | **null** while open, with `balanceKg` carrying the pile |
| `CampaignRollup.rcInventoryTons/Php`, `buyingTons/Php` | **absent, deliberately.** Stock is a LEVEL owned by `view_analytics_inventory_eom` and buying a FLOW owned by `view_analytics_rcin_monthly`; both are keyed on the **calendar month**, not the campaign. Fabricating a campaign-clock version of either would create a second definition of the RC inventory price — the exact mistake migration `20260903013948` was written to undo. If the band wants them, join the calendar views and LABEL them as calendar-month figures. |

Two things the draft got right and that are preserved: **a rest day is a ROW**, and **the eight
waste streams do NOT sum to the day's drift** (most of it leaves as moisture and volatiles,
which nobody weighs) — say so where the numbers are.

### 2.5 The adapter

`lib/operations/queries.ts` (server-only).

- **`fetchOpsLedger(campaignKeys: string[]) → OpsLedgerData`** — resolves `canViewPrices()`
  ONCE, reads the campaign rows + grade dimension + group RPC in parallel, then reads the day
  spine and its four lenses **per campaign** in parallel, and RESHAPES: it groups already
  aggregated rows onto the day they belong to. **It does no arithmetic at all** — a `reduce()`
  or a `+` in this file means a number escaped SQL, and `verify-ops-ledger` asserts neither
  appears.
- **`fetchOpsLedgerCampaignOptions()`** — from `view_rc_movement_campaign_options`, filtered
  `campaign_year >= 2025` and ordered newest-first, **the same source and the same filter RC
  Movement's picker uses**, so the two screens can never offer different campaigns.
- **PRICE GATING is structural.** Every ₱ field is `showPrices ? … : null` *before the payload
  leaves the server*: `fedPhpKg` per day, and all seven ₱ fields on each campaign rollup and on
  the group row. `canViewPrices` rides along so the UI can **drop the column from its coordinate
  space** rather than render a blank one (the RC Movement precedent). **Production is the only
  role denied.**

### 2.6 Proofs — measured 2026-09-14 against the live database

`npx tsx scripts/verify-ops-ledger.ts` — 13 static assertions + 30 live. Zero on every
`*_mismatch` is the passing state.

| Proof | Result |
|---|---|
| Σ grade kg per day == `view_ops_ledger_day.produced_kg` | **0 mismatches** over 686 day rows |
| Σ block fed kg per day == `.fed_kg` | **0 mismatches** |
| Σ shift produced / downtime per day == the day's figures | **0 / 0 mismatches** |
| Σ day fed / produced per campaign == the campaign KPI row | **0 mismatches** over 32 campaigns |
| Σ day-grade kg per campaign == `view_ops_ledger_campaign_grades.kg` | **0 mismatches** |
| campaign KPIs vs `view_analytics_batch_cost` (21 columns, `IS DISTINCT FROM`) | **0 mismatches / 32** |
| campaign KPIs vs `view_analytics_production_by_batch` (9 columns) | **0 mismatches / 32** |
| `ledger_days == span_days` | **0 mismatches / 32** |
| a ONE-campaign group == that campaign's row (23 columns) | **0 mismatches / 32** |
| an unknown key is returned in `campaigns_missing` | reported, never dropped |
| Q3 2026 yield == Σproduced/Σfed | gap **0.00000000000000000000** |
| Q3 2026 fed ₱/kg == Σvalue/Σfed | gap **0** |
| Q3 2026 PC cost == Σvalue/Σproduced | gap **0** |
| posture: 8 views, invoker, commented, authenticated-only | 0 anon, 0 service_role |
| anon / service_role denied by a **real read** | both refused |
| money-named columns in the five peso-free views | **0**; `view_ops_ledger_day` has exactly **1** |

**Q3 2026, as the group RPC reports it:** 3 campaigns · 2026-06-30 → 2026-09-12 · **77 ledger
days = 63 active + 14 rest** · fed **1,867,340 kg** · produced **1,441,249 kg** · yield
**77.1819%** · process loss **426,091 kg** · block resiko loss **3.2680%** · 45 distinct blocks
(42 closed / 3 open) against a naive 50 · 63 shifts · 99 runs · 44.733 downtime hours · 42,706
sacks · **61 reported campaign-days over 59 calendar dates — the surplus 2 is exactly the two
changeover days, 2026-08-01 and 2026-08-29** · 2 of 3 campaigns fully covered, so TRUE PC COST is
NULL with the covered partial beside it.

### 2.7 What the UI must not do

1. **Never re-derive a total.** Everything is in the payload; a `reduce` in a component is the
   same bug as a `reduce` in the adapter.
2. **Never hardcode a grade column.** Read `grades` / `gradesByCampaign`.
3. **Never print `resiko` for an open block** — it is `null` there on purpose; print
   `balanceKg` and say what it is.
4. **Never render `dayDriftKg` as "loss".** Label it drift, and put loss in the KPI strip.
5. **Never render `fedPhpKg` or a KPI ₱ for Production.** It is already `null`; drop the column
   entirely, as the RC Movement matrix does.
6. `yieldPct`, `processLossPct`, `blockResikoLossPct`, `campaignFedKgIncludedPct`,
   `coveredFedKgShare` are **FRACTIONS** (×100 at render). `sharePct`, `fedPriceCoveragePct`,
   `sacksCoveragePct` are **PERCENTS** already. Their sources' conventions were kept rather than
   harmonised so a reader can compare this screen with `/analytics` digit for digit.

---

## §3 — UI (BUILT)

Route **`app/(app)/operations/`**, branch `feat/ops-ledger`. Draft **C — Split lens**, ported
off the mock and onto the adapter. `app/dev/ops-ledger/` is untouched and nothing here imports
from it; the drafts' *ideas* were ported, their *files* were not.

### 3.1 The files

| File | Role |
|---|---|
| `page.tsx` | Server Component. `?campaigns=` / `?lens=` → `fetchOpsLedgerCampaignOptions()` + `fetchOpsLedger(keys)` → `OperationsView`. |
| `operations-view.tsx` | Client. URL writes, lens control, EOQ collapse, `campaignsMissing` notice, block drawer. |
| `ops-ledger-table.tsx` | **ONE table, ONE scrollbar**: the frozen left spine, the two sticky header rows, the sticky group footer, the lens columns, the day expand. (Replaced `ops-ledger-split.tsx` on 2026-09-15.) |
| `ops-kpi-strip.tsx` | The EOQ table — a row per campaign + the GROUP row, **eleven columns**, every cell a button, every unit pinned left via `components/shared/unit-value`. |
| `ops-kpi-modal.tsx` | The per-KPI "show me the math" dialog (`KpiDetail`). |
| `ops-color.ts` | The semantic palette (`TONE`, `CAMPAIGN_ACCENTS`). |
| ~~`ops-day-detail.tsx`~~ | **Deleted 2026-09-15 (round 3)** — a day expands into child rows now. |
| `ops-blocks-table.tsx` | The BLOCKS USED table behind the FED PRICE / ACTUAL FED PRICE / RESIKO modals (`fed` · `actual` column sets). |
| `ops-group-picker.tsx` | Selection chips + popover (filter, derived quarter presets, full list). |
| `ops-lens.ts` | Lens registry (`production` · `grades` · `losses` · `blocks`), `DEFAULT_LENS`, `parseLens`, `quarterPresets()`. |
| `ops-format.ts` | The renderers. |

Also changed: `components/navbar.tsx` (a `getBreadcrumb()` entry + `ICTC_MODULES`),
`components/NAVBAR.md`, `app/(app)/operations/CONTEXT.md`.

### 3.2 The decisions the brief left open

1. **The EOQ strip is a TABLE, not the drafts' tile row.** Tiles answer *"how did this period
   do"*; Renzo's EOQ tab answers *"how did these three months COMPARE"*, and three stacked tile
   strips is a comparison the reader has to do in their head. One row per campaign, the GROUP
   row last, nine columns, each cell carrying a coverage caption underneath.
2. **The divider is dragged in PIXELS, not as a fraction of the frame.** The spine's natural
   width is a known constant (692px with ₱, 596 without), so a pixel default makes the pane fit
   it EXACTLY on the first paint and the spine genuinely never scrolls sideways — which is the
   whole claim of this layout. A fraction only approximates it, and approximates it differently
   on every screen. A `ResizeObserver` re-clamps to `[240, frame − 240]`.
3. **Each pane's table ends in an empty auto-width SPACER column.** `table-fixed` +
   `width:100%` distributes leftover pane width proportionally across the declared columns,
   which pulled a three-column grades lens apart into unreadable islands. The spacer absorbs it
   instead. This is the one case the *"never let a `w-auto` column absorb the slack"* rule does
   not bite — the spacer carries no content, and `minWidth = Σ fixed widths` still forces the
   scrollbar when the pane is too narrow.
4. **`?lens=` is in the URL; the expanded day and the block drawer are not.** The lens decides
   what is on screen for everyone who opens the link. The other two are disclosures inside ONE
   reading of one payload — the same category RC Movement keeps in local state — and putting
   them in the address would re-run the server on every chevron click to change nothing the
   server computes. The default lens is spelled as ABSENCE, so a plain address stays clean.
5. **The last campaign cannot be unticked.** An empty `?campaigns=` would silently re-resolve
   to "the newest campaign", i.e. to something the reader did not pick. The chip refuses (with
   a `title` saying why) rather than writing a group that means something else.
6. **The quarter presets are DERIVED from the option list** and a quarter is offered only when
   all three of its campaigns exist — a two-month "Q3" is a different period wearing a
   quarter's name.
7. **Where the payload has no total, the lens footer says so.** Grades DO have a campaign total
   (`gradesByCampaign`) and it is printed. The waste streams and the per-block columns have
   none at either grain, so that footer prints one sentence instead of a fabricated number.
   Summing the visible cells would be exactly the re-derivation §2.7 rule 1 forbids.
8. **Campaign boundaries are a BAND row plus a per-campaign FOOTER row** (rendered only when
   more than one campaign is picked, since with one it would duplicate the sticky group
   footer). Both are drawn in both panes at the same height so the panes stay row-aligned.
9. **The DRIFT column's campaign and group footers print `processLossKg`** — at those grains
   `fed − produced` genuinely IS loss — with a `title` saying so. Only the DAY figure is drift.
10. **The block drawer is `BlockingDetailPanel`, reused** (fourth consumer, after Blocking, RC
    Movement and the digest), opened optimistically with the staleness guard and the panel's own
    copyable error banner. Both the block column headers and the BLOCKS USED batch codes open it.
11. **Not the Blackwood Table.** The grid is one table with one scrollport; two independently
    scrolling panes over a shared row spine is a shape it does not have, and this is a read-only
    ledger with no inline editing, so the grid's whole value proposition is unused. Hand-built,
    keeping every rule the grid would have enforced.

### 3.3 §2.7 compliance

| Rule | How |
|---|---|
| 1 — never re-derive a total | No `reduce` / `+` / division on any render path; column-width bookkeeping only. Absent totals are STATED. |
| 2 — never hardcode a grade | The grades lens maps `OpsLedgerData.grades`; campaign totals come from `gradesByCampaign`. |
| 3 — never print resiko for an open block | `resiko_kg` and `balance_kg` are TWO separately-headed columns (`closed only` / `open only`), each with a `title` explaining its blank. |
| 4 — never render `dayDriftKg` as loss | Column head is `DRIFT`, hover explains continuous flow, the expand repeats it; loss lives in the strip. |
| 5 — never render ₱ for Production | `canViewPrices` removes the spine's ₱ column and the strip's four ₱ columns from the layout. |
| 6 — fractions vs percents | `pctFromFraction` for yield / loss / resiko; `pctFromPercent` for coverage. Two functions, so the two conventions cannot be confused at a call site. |

### 3.4 Verification (2026-09-14)

`npx tsc --noEmit` clean · `npx eslint` on the new directory + the navbar: 0 errors, 0 warnings
· `npm run build` passes with `/operations` emitted.

Rendered in Chromium against a static payload fixture (the live route is behind the login wall
and this session held no session): 1512×950 light + dark, and 375×812. Verified there —
**the two panes' row tops are identical for every row** (read back from the DOM, not eyeballed);
all three lenses; the day expand in both panes with a 320px band on each side; the
price-denied payload rendering 7 spine columns and a 5-column strip; `document.scrollWidth ===
window.innerWidth` at 375px; the phone pane toggle and its combined expansion band; zero page
errors in the console. The fixture harness was deleted afterwards — `git status` shows only the
eight route files, the navbar and the two docs.

---

### 3.5 REFINEMENT PASS (2026-09-15) — Renzo's seven notes on the shipped page

He read `/operations` on production with JULY + AUGUST + SEPTEMBER 2026 under the Losses lens.
Seven changes, and each one removed machinery rather than adding it.

1. **ONE TABLE, ONE SCROLLBAR.** *"There are two vertical scroll bars. There's no point in
   having two if they are synced… no point in making them two different tables when in reality
   they are just beside each other. Better if they coexist."* The split paid for a problem it
   created, and **five mechanisms existed only to hold the two halves together**: the
   scroll-sync handler, its ownership guard, the pixel divider + `ResizeObserver` clamp, the
   phone pane toggle, and the fixed 320px expansion band. All five deleted. The spine became
   FROZEN COLUMNS at cumulative `left` offsets inside the one `<table>`; the expansion band
   sizes to its content, still `sticky left-0` and bounded to `min(1000px, 100vw − 2rem)` so it
   does not spread across the blocks lens's horizontal scroll.
2. **Visible cell borders**, spreadsheet style, both themes — with `border-separate` +
   `border-spacing: 0`, which is MANDATORY here: under `border-collapse` sticky cell backgrounds
   render transparent and the scrolling cells bleed through the frozen spine. Gridlines are
   therefore reconstructed per cell, exactly as the RC Movement matrix does it.
3. **The stray 2026-08-29 row above the JULY band — fixed.** Root cause: both panes keyed day
   rows `key={d.date}` and the expand state was a bare date. A **changeover date belongs to two
   campaigns** (08-01 = JULY's last + AUGUST's first; 08-29 = AUGUST's last + SEPTEMBER's
   first), so React saw duplicate keys and reconciled one into the wrong band. Rows and the
   expanded identity are now `campaignKey:date`, and `buildRows` groups days by campaign in the
   campaigns' own chronological order instead of trusting row order.
4. **The EOQ rollup is exactly nine columns**: `RC Fed · Produced · Yield · Loss (%) · Waste
   Loss (kg + %) · Fed Price · Actual Fed Price · PC Cost · True PC Cost`. *"Too wordy"* — the
   nine sub-captions are gone.
5. **…because every cell is now a BUTTON that opens the math.** `OpsKpiModal` prints the
   definition in words and in symbols, every input beside its published value, the result, and
   the coverage — including WHY a `True PC Cost` is null and what the covered partial is. The
   captions were not deleted, they were moved somewhere that can afford to be complete. **`a ÷ b
   = c` is three published fields printed side by side, never a division**: §2.7 rule 1 holds in
   the modal builders as strictly as it does in the table.
6. **A semantic colour system** (`ops-color.ts`): sky FED · emerald PRODUCED/YIELD · amber
   DRIFT/LOSS · rose WASTE · violet MONEY · zinc spine chrome, on three surfaces only — the
   column-group header bands, the KPI/headline values, and a light tint on the scrolling lens
   columns. Frozen surfaces take the OPAQUE half of each tone; only non-frozen cells take the
   translucent one. The eight waste VALUE columns stay neutral so the losses lens is not a wall
   of red. Campaign bands take a rotating accent from hues the semantic palette does not use.
7. **A fourth lens, `production` (grades + the eight waste streams under two group headers), and
   it is the DEFAULT.** Built from the SAME column builders the grades and losses lenses use, so
   the three can never disagree about a figure. `?lens=grades` / `?lens=losses` / `?lens=blocks`
   are unchanged; only the default moved, and the default is still spelled as ABSENCE.

Also: the Losses and Production footers now print REAL per-campaign and per-group stream totals
from `rollups[].waste` / `group.waste` (shipped with the data layer the same morning). Whether a
total EXISTS is a flag separate from its value, because `null` is a legitimate total and
collapsing "not published" into "published as null" is how a footer starts lying. The blocks
lens still has no total at either grain and still says so.

### 3.6 Verification (2026-09-15)

`npx tsc --noEmit` clean · `npx eslint "app/(app)/operations"` 0 errors 0 warnings ·
`npm run build` passes with `/operations` emitted.

Driven in Chromium against a temporary three-campaign fixture carrying BOTH changeover dates in
two campaigns each (mounted under `/dev/table-playground/`, which is public outside production;
deleted afterwards, `git status` clean of it). Measured there:

- **exactly ONE element with `scrollHeight > clientHeight`** (`.min-h-0.flex-1.overflow-auto`);
  two `<table>`s in the page — the EOQ strip and the ledger.
- **row order correct and no stray row**: JULY 07-28…08-01 → JULY footer → AUGUST 08-01…08-29 →
  AUGUST footer → SEPTEMBER 08-29…09-01 → SEPTEMBER footer. Each changeover date appears ONCE
  PER CAMPAIGN inside its own band. **Zero React key warnings and zero console errors**, across
  a lens switch round trip.
- all four lenses: group headers read `DAY · PRICE · FED · PRODUCED · DRIFT · SHIFT` + `GRADES`
  / `WASTE STREAMS` / `GRADES + WASTE STREAMS` / `BLOCKS FED`; the losses group footer printed
  the eight real stream totals; the blocks footer printed its one-line note.
- the KPI modal opens from a cell and renders the eight streams, the total, the denominator, the
  coverage and the two caveats; the `True PC Cost` modal explains its own blank.
- price-denied payload: spine drops FED PRICE, strip renders `Campaign · RC Fed · Produced ·
  Yield · Loss · Waste Loss`, **no ₱ glyph in either table**.
- light AND dark, 1512×950; and 375×812 where `document.scrollWidth === innerWidth === 375`,
  one vertical scroller, spine cells `position: static` (the spine un-freezes below 768px).

---

### 3.7 REFINEMENT PASS 2 (2026-09-15) — Renzo's four notes after *"looking good!"*

He read the refined `/operations` on production. Four changes; the first two are one idea (give
the ledger back its vertical space) and the last two are one idea (say what the day actually is).

1. **THE EOQ STRIP SPLIT `ACTUAL FED PRICE` INTO THREE COLUMNS.** *"The KPI is wide enough to
   separate resiko cost and resiko loss as their own separate columns. This would make the KPI
   thinner and give more vertical space for the breakdown table."* One 138px cell was stacking
   three figures, and because a table row is as tall as its tallest cell that ONE cell set the
   height of **every** row in the strip at three lines. Split, the order is `RC Fed · Produced ·
   Yield · Loss · Waste Loss · Fed Price · Actual Fed Price · Resiko Cost · Resiko Loss ·
   PC Cost · True PC Cost` — eleven columns, and `upliftPhpKg` / `blockResikoLossPct` each get
   their own header and their own modal (the actual-price modal kept the price and the coverage;
   the resiko-cost modal owns `Actual − Delivered` and the 0-or-negative caveat; the resiko-loss
   modal owns the yard's shrinkage and, for the group, why no resiko KG exists). *Measured: rows
   34px where they were ~60, the whole strip 159px for three campaigns + GROUP.*
   **RESIKO LOSS IS NOT A ₱ COLUMN** — a weight ratio the adapter never nulls — so it is not
   `price`-flagged and Production keeps it, in the amber LOSS hue rather than the violet MONEY
   one. The gate now drops FIVE columns, not four.
2. **THE UNIT MOVED TO THE LEFT OF EVERY STRIP CELL**, and `UnitValue` moved with it:
   `app/(app)/analytics/unit-value.tsx` → **`components/shared/unit-value.tsx`** (platform layer
   — it already carried zero tenant knowledge; the glyph is a prop), with a one-line re-export
   left at the old path so none of its six analytics call sites moved. Glyphs `t` · `%` · `kg` ·
   `₱/kg`; the column headers dropped their unit sub-labels, because a unit stated on every row
   at a fixed x does not also need a header line. **An absent figure drops the glyph with the
   number** — `% —` claims a percentage that does not exist.
3. **THE LEDGER'S `DRIFT` COLUMN IS GONE AND FOUR RATIOS TOOK ITS PLACE:** `WASTE`
   (`totalWasteKg`) · `WASTE %` (`wastePct`) · `YIELD %` (`yieldPct`) · `LOSS %` (`lossPct`),
   under two group bands — rose `WASTE`, amber `OUTPUT RATIOS`. `dayDriftKg` is **no longer
   rendered anywhere** (the day-expand's note quoted it too, and was rewritten). DRIFT was a
   kilogram figure whose entire header tooltip existed to say *"this is not what it looks
   like"*; the caveat now sits on the two columns it applies to — *"Day-level, indicative — the
   feed tank is continuous flow; the campaign figure is the real one"* — and WASTE / WASTE %
   carry none, because a day's swept-up waste and a day's production DO describe the same shift.
   Footers print the published `wasteKg` / `wasteLossPct` / `yieldPct` / `processLossPct`, never
   a fold of the cells. The spine went 692 → **916px with ₱ / 820 without**, so its un-freeze
   breakpoint went 767 → **1023px** — the rule was always "un-freeze while the spine is within
   ~10% of the frame", and at 800px a 916px spine would have left nothing for the lens.
4. **"of fed kg" → "of produced kg"** everywhere the waste denominator was described: the strip's
   header comment, the losses-lens hint, the day-expand's waste note. (The data layer had already
   moved in `20260915032016`; this is the copy catching up.) The stale live figures in
   `CONTEXT.md` (0.121155 / 0.114719, measured against fed kg) are now labelled as the retired
   definition beside the current 0.152369 / 0.146174.

**Verification (2026-09-15, round 2).** `npx tsc --noEmit` clean · `npx eslint "app/(app)/operations"
components/shared/unit-value.tsx "app/(app)/analytics/unit-value.tsx"` 0 errors 0 warnings ·
`npm run build` passes with `/operations` emitted. Driven in Chromium against a temporary
three-campaign fixture (both changeover dates, each in two campaigns) mounted at
`app/dev/table-playground/ops/`, deleted afterwards:

- strip headers read exactly `CAMPAIGN · RC FED · PRODUCED · YIELD · LOSS · WASTE LOSS ·
  FED PRICE · ACTUAL FED PRICE · RESIKO COST · RESIKO LOSS · PC COST · TRUE PC COST`, cell text
  `"t\n781.2"`, `"%\n79.52"`, `"kg\n94,652\n%\n15.24"`, `"₱/kg\n45.33"` — unit left, digits
  right; rows **34px**, strip **159px**.
- the three new modals open from their own cells and carry their own definitions; the GROUP
  RESIKO LOSS modal states the no-group-kg rule.
- spine reads `DATE · DAY · FED PRICE · TTL FED · TTL PROD · WASTE · WASTE % · YIELD % · LOSS % ·
  SHIFTS · DT HRS` under `DAY · PRICE · FED · PRODUCED · WASTE · OUTPUT RATIOS · SHIFT`; **no
  DRIFT**; group footer `218,401 · 14.62% · 78.48% · 21.52%`; both ratio headers carry the
  indicative `title`.
- **exactly ONE element with `scrollHeight > clientHeight`**, two `<table>`s, zero React key
  warnings and zero application console errors across a lens round trip (all four lenses).
- price-denied payload: strip `Campaign · RC Fed · Produced · Yield · Loss · Waste Loss ·
  Resiko Loss`, spine drops FED PRICE and the whole PRICE band, **no ₱ glyph in the document**.
- light AND dark at 1512×950; at 375×812 `document.scrollWidth === innerWidth === 375`, one
  vertical scroller, spine cells `position: static`.


---

### 3.8 REFINEMENT PASS 3 (2026-09-15) — Renzo's five notes after round 2

Read on production with JULY + AUGUST + SEPTEMBER 2026. Every change **removes** something.

1. **EVERY COLUMN HEADER IS ONE LINE, UNIT INCLUDED.** *"Can't those sub headers in the columns
   (where the units are) be stored on the same line as the column title? … For all views in
   general in this page."* `kg` · `₱/kg` · `h` · `%` now sit on the label's own baseline in
   muted small type; a block column carries its `block_loc` inline with the batch code the same
   way; the modal tables are built that way from the start. **The label header row went 40px →
   26px.** One column had to grow with it — `FED PRICE ₱/kg` clipped by a measured 2px at 96, so
   `W_FEDPHP` is **102** and the spine is **922px with ₱ / 820 without**. The un-freeze
   breakpoint did not move (1023px); the rule is unchanged. *Measured after the change: not one
   header in the spine or in either lens clips.*

2. **THE EOQ CAMPAIGN CELL LOST ITS DATE RANGE.** *"Kind of needless."* It is — the ledger
   directly beneath states every date, and the campaign BAND row repeats the span. The GROUP row
   keeps one line (`3 campaigns`), because how many campaigns are in the group is what that row
   IS and nothing else on screen says it. Label column 170 → 150px.

3. **EXPANDING A DAY INSERTS CHILD ROWS, NOT A PANEL.** *"An identical row in the format of the
   parent row but ONLY showing the SHIFTS groups… There's no need for those sections above the
   table with the rc fed breakdown for the day. Child rows should be self explanatory. Too wordy
   anyway. No reason for the fed table in the dropdown to also be horizontally scrolled."* The
   whole expansion PANEL is gone — shift cards, the RECORDED WASTE block, the day-grain BLOCKS
   USED table, and the `sticky left-0` band that carried them — and with them
   **`ops-day-detail.tsx`** and the day-grain **`blocksUsed`** read/type (the view stays in the
   database; nothing reads it, because the block table a reader wants is the CAMPAIGN's and a
   block's all-time fed total cannot be attributed to one campaign). A day opens into **one
   ordinary `<tr>` per shift, in the same columns**, same frozen treatment, same gridlines.
   **A shift row leaves blank everything a shift does not own**: `rc_out` has no shift dimension,
   so FED PRICE / TTL FED / YIELD % / LOSS % are blank rather than repeated or invented. TTL
   PROD, WASTE, WASTE %, DT HRS, the grade split and the eight streams are published per shift
   and are printed; the DT HRS `title` carries everything L-051/L-051b stored (reason, MC's own
   ranges, the ranges the plant ran THROUGH, the shift-length rule), which is what the deleted
   panel was for. **A day with no shift is not expandable.** Child rows key
   `campaignKey:date:shiftId` — the round-1 changeover-date lesson, one grain down.

4. **FOUR MODALS BECAME A TABLE, AND NO MODAL OPENS WITH A PARAGRAPH.** *"It should take out the
   how it is defined entirely… those two KPI pop ups should portray the data in table form so
   the user can distinguish and get a quick look and a breakdown of why the price is the way it
   is and what the actual price is and why."* The `HOW IT IS DEFINED` block is deleted from
   **every** modal (title → one-line formula → inputs → result → the caveats that explain a
   NULL), and FED PRICE · ACTUAL FED PRICE · RESIKO COST · RESIKO LOSS render the new
   `ops-blocks-table.tsx` in a `sm:max-w-4xl` dialog:
   `BATCH · BLOCK LOC · DATE OPEN · DATE CLOSE · STATE · FED WT kg · BLOCK PRICE ₱/kg`, plus
   `ARRV WT kg · RESIKO kg · RESIKO LOSS % · ACTUAL PRICE ₱/kg · RESIKO PRICE ₱/kg` on the
   actual-price set. **FED WT is `campaignFedKg` / `groupFedKg`, never the block's all-time
   total.** RESIKO is null on an open block and the BALANCE shows instead, muted; RESIKO LOSS
   reads `resikoPct` (the published closed-only twin) gated on `isClosed` as well, so it can
   never disagree with the kilos beside it. A row outside the price set is tinted and says why
   (`still open` · `an unpriced delivery` · `a sun-drying outflow`) — `inPriceSet` is read, never
   re-derived. A counts line above and the rollup's own totals in a sticky footer below: **the
   table never counts its own rows and never sums its own cells.** Header and footer are sticky,
   so both are SOLID `bg-muted`, never the dialog's glass.

5. **THE BLOCKS FED LENS GOT ITS FOOTERS.** Now that `campaignFedKg` / `groupFedKg` are
   published per (campaign|group × block), each block column prints a real per-campaign total and
   a real group total instead of the *"no total is published for this lens"* note — a LOOKUP,
   never a fold of the cells. The note survives only for an empty lens's placeholder column, and
   the rule it states still binds.

**Verification (2026-09-15, round 3).** `npx tsc --noEmit` clean · `npx eslint
"app/(app)/operations" lib/operations` 0 errors 0 warnings · `npm run build` passes with
`/operations` emitted · `npx tsx scripts/verify-ops-ledger.ts` static half green. Driven in
Chromium against a temporary three-campaign fixture (both changeover dates each in two
campaigns; days with 0/1/2/3 shifts; four blocks per campaign covering closed-and-priced, open,
closed-but-unpriced and sundry), mounted at `app/dev/table-playground/ops3/` and **deleted
afterwards** — `git status` carries no trace of it. Measured there:

- header rows **22px + 26px** (was 22 + 40); every header one line
  (`FED PRICE₱/kg`, `TTL FEDkg`, `DT HRSh`, `3X50kg`, `JAN-26-BLK2D-2A`), **zero clipping**
  across the spine and all four lenses; spine **922px**.
- strip rows **34px**, first cell `JULY 2026` with **no date line**, GROUP cell `GROUP ⏎
  3 campaigns`.
- **8 chevrons for the 8 days that have shifts**, none on the rest day and none on the day that
  was fed but filed no shift. Expanding 2026-07-31 inserts **3 rows** reading
  `↳ Shift M |  |  |  | 13,000 | 1,580 | 12.15% |  |  |  | 0.50 | 9,100 | …` — FED PRICE / TTL
  FED / YIELD / LOSS / SHIFTS blank, **0 tables inside the ledger**, `document.scrollWidth ===
  innerWidth`.
- FED PRICE modal: 7 columns, 4 rows, footer `₱ PAID 35,413,609.20 · RC FED 781,240 kg · PRICED
  COVERAGE 100.0% · FED PRICE ₱45.33/kg`. ACTUAL FED PRICE modal: 12 columns, the open block
  showing its balance `42,180` with a blank RESIKO LOSS, the three excluded rows each carrying
  their own reason, counts line and six-figure footer.
- blocks lens: per-campaign footers `123,500 · 127,000 · 130,500` and the group footer
  `247,000 · 254,000 · 261,000` — published `campaignFedKg` / `groupFedKg`, not sums.
- **exactly ONE element with `scrollHeight > clientHeight`** after a round trip through all four
  lenses; two `<table>`s; **zero React key warnings and zero console errors**.
- price-denied payload: strip `CAMPAIGN · RC FED · PRODUCED · YIELD · LOSS · WASTE LOSS ·
  RESIKO LOSS`, spine drops FED PRICE, the RESIKO LOSS modal's table drops the three ₱ columns,
  and **`document.body.innerText` contains no `₱` at all** (the one prose mention was reworded to
  "NO PESO VALUE" precisely so that assertion means something).
- frozen spine at 1440px (`position: sticky`, `left: 32px`) **on the child rows too**, with an
  OPAQUE background in dark mode; light AND dark; at 375px `scrollWidth === innerWidth === 375`,
  one vertical scroller, spine `position: static`.

### 3.9 REFINEMENT PASS 4 (2026-09-16) — Renzo's three notes after *"looking great"*

Read on production, on a 1080p 24" monitor, with JULY + AUGUST + SEPTEMBER 2026.

1. **THE MODALS MUST USE THE ROOM THEY HAVE.** *"The modal is causing shrinkage and overflowing
   of the table UIs. The space can be MUCH better utilized considering how much space we have on
   my 1080p 24-inch monitor. It should also occupy the space that is available so it can be
   viewed on any device."* Two independent faults produced one symptom. (a) `sm:max-w-4xl` is
   **896px** while the ACTUAL FED PRICE table is **1,298px** of declared columns, so the table
   scrolled sideways inside a dialog with ~900px of monitor empty either side. (b) Round 3 moved
   the unit onto the header's own line and did not re-size the columns for it, so
   `BLOCK PRICE ₱/kg` and `RESIKO LOSS %` ellipsised at *any* dialog width. Fixed together:
   **`ops-modal-size.ts`** owns `width = min(96vw, Σ column widths + 44, 1720px)` +
   `max-h-[92vh]`, and **the Σ is never a literal** — `blocksTableWidth(variant, canViewPrices)`
   and `productionTablesWidth()` are exported from the components that declare the columns, so a
   column that grows widens the dialog with it (a hand-kept number is exactly how the truncation
   survived three rounds). The columns themselves were re-sized as
   `measured label + 4px gap + unit + 16px padding`. The dialog is a flex COLUMN with the header,
   the formula line, the result bar and the caveats PINNED and the table the only scroller, and
   the table is **`flex-auto`, never `flex-1`** (a `flex-basis: 0%` child in an auto-height,
   merely-clamped container measures as empty and collapses). `KpiDetail.result` became optional
   for the PRODUCTION modal, and `transition-none` was added because `duration-200` with
   `transition-property`'s initial value of `all` would otherwise ANIMATE the width — a layout
   property, which CLAUDE.md forbids.

2. **PRODUCED · YIELD · LOSS · WASTE LOSS ARE ONE INTERRELATED FAMILY.** *"Hovering over one of
   them highlights all 4 of those KPIs. Since those 4 are interrelated, what pops up should be a
   table where we can see all 4 of that data."* Four columns stay four columns; what is new is
   `KpiColumn.family`. Hover or FOCUS on any of the four lights all four **in that row** (per-row,
   because the relationship is a statement about one campaign), and clicking any of them opens
   ONE modal — **`ops-production-table.tsx`** — carrying `RC FED · PRODUCED · YIELD · LOSS ·
   PROCESS LOSS · WASTE · WASTE %` for every campaign in the strip plus the GROUP row, the three
   formulas on one line above, the eight waste streams in a second table with `WASTE SHIFTS`
   coverage, and the narrowed-denominator caveats underneath. `KpiDetail` building moved from
   render time to CLICK time in the same change (eleven `KpiDetail`s per row, each holding a whole
   React table element, were being constructed on every render and never looked at).

3. **RC FED OPENS THE RC MOVEMENT MATRIX.** *"RC Fed should pop up to a modal of RC movement. I
   don't know how you would make it efficient and not heavy for the page, but rendering the RC
   Movement table in a modal based on which campaign RC Fed you click just makes so much sense."*
   The unification thesis, made clickable. **The Classic matrix embeds as it stands** — its props
   are `{ data, onCampaignChange?, onNavigateToBatch? }` and it holds no router hook, so
   `ops-rc-movement-modal.tsx` is a SECOND HOST and the matrix is not edited, forked or copied.
   (The v2 grid could not be used: it writes `?campaign=` with `router.replace` and would rewrite
   `/operations`'s address.) `next/dynamic({ssr:false})` keeps its chunk off the first load; the
   data comes from the SAME server action the RC Movement page calls, fetched on demand and cached
   per campaign; the GROUP cell gets campaign TABS rather than three stacked grids; ₱ stays gated
   inside `fetchRcMovementMatrix`, which the host passes through untouched.
   **One CSS finding worth keeping:** `backdrop-filter` makes an element the containing block for
   `position: fixed` descendants, so the canonical dialog glass pinned the matrix's
   (non-portalled) `BlockingDetailPanel` to the dialog box instead of the viewport — measured
   x=1299 · right=1819 · y=44. A transform does the same, and `zoom-in-95`'s single `from`
   keyframe can hold `scale3d(.95)` past the animation and outrank an inline reset. This one
   dialog is therefore opaque, centred with `inset:0` + `margin:auto`, and carries
   `transform/translate/filter/animation: none`. The KPI modals keep the glass — they hold no
   fixed descendant.

**Verification (2026-09-16, round 4).** `npx tsc --noEmit` clean · `npx eslint
"app/(app)/operations"` 0 errors 0 warnings · `npm run build` passes · `/operations` client JS
**972.2 kB → 979.9 kB over the same 36 chunks**, with the three chunks carrying the matrix's own
identifiers proven absent from that set. Driven in Chromium against a temporary three-campaign
fixture (18 blocks across the four row kinds — closed-and-priced, open, closed-but-unpriced,
sundry — one campaign reporting no production and filing no waste), mounted at
`app/dev/table-playground/ops4/` and **deleted afterwards**; `git status` carries no trace of it.
Measured there:

- **1920×1080, ACTUAL FED PRICE: 12 columns, `scrollWidth === clientWidth === 1298`, ZERO clipped
  headers and zero `…`**, dialog 1342×494, `document.body.scrollWidth === 1920`. Every modal sizes
  to itself: 782 (FED PRICE) · 1342 (ACTUAL) · 1146 (PRODUCTION) · 560 (inputs list).
- hovering YIELD on the JULY row lights **exactly** the four production cells and nothing on any
  other row; dispatching `focusin` on the LOSS button lights the same four.
- the PRODUCTION modal renders both tables (8 + 11 header cells), SEPTEMBER 2026 blank on every
  production figure and every stream (**NULL, never 0**), result bar
  `77.18% · 22.82% · 14.62%`, both narrowed-denominator caveats printed.
- the RC FED modal: dynamic chunk fetched on first click, three campaign tabs, tab switch
  re-fetches and re-renders, matrix frozen panes intact, and the block drawer at **x=1400 ·
  right=1920 · y=0 · 520×1080 — exactly the viewport**.
- **1366×768** — the 18-row GROUP modal clamps to exactly **707px = 92vh** with the table the only
  vertical scroller and the header/formula/result/caveats pinned; **375×812** —
  `document.scrollWidth === 375`, dialog 360 wide, only the table container scrolls sideways.
- LIGHT and DARK both rendered; **price-denied payload**: the strip drops its five ₱ columns, the
  blocks table drops its three, and `document.body.innerText` contains no `₱` at all — inside the
  RC FED modal included.

### 3.10 REFINEMENT PASS 5 (2026-09-16) — Renzo's seven notes after *"getting better and better"*

Read on production with JULY + AUGUST + SEPTEMBER 2026. The data half of three of these landed
the same morning (migration `20260916030358_ops_ledger_day_fed_blend_quarters_arrival`): the
day's projected fed blend, the block lab panel, the MIDPOINT quarter columns and the blocks-table
footer totals. This pass is the UI on top of it, plus four presentation notes.

1. **THE FED CELL OPENS THE DAY.** *"Per cell in the Fed column, it should be clickable like the
   KPI and once clicked show a table of the blocks that were fed on that day, like a sidebar. And
   it should show me the stats of what was fed — a table / mini KPI strip that shows me the
   projected MC, BD, Ash etc. of the final product. Not to be taken as truth but a good figure to
   see."* New **`ops-fed-day-sheet.tsx`**: an OPAQUE right-hand `Sheet` (it slides over the
   scrolling ledger — "Frozen Panes", and the `supports-[backdrop-filter]` twin has to be
   overridden too, since a variant-prefixed class is its own utility group). Head = the seven
   weighted stats from `day.fedBlend`, three decimals on the two BDs and two elsewhere, unit
   pinned left via the platform `UnitValue`, a coverage caption whenever `<stat>Kg < fedKg`, and a
   permanent *"Projected from what was fed — not a lab result"* line. Body = `day.blocksFed` with
   the blend as the footer; the batch cell opens `BlockingDetailPanel`. **A day that fed nothing
   gets no button**, the same rule the expand chevron already follows.
2. **QUARTERS BY DATE, LATEST QUARTER AS THE DEFAULT.** *"It is not showing the current Q3 2026
   group because it isn't complete yet. It should show it and default to it since it is the
   latest. Quarters are based on date, not on batch."* `quarterPresets()` gained the quarter's own
   span and chronological (`firstDate`) key order; new **`latestQuarterKeys()`** is what
   `page.tsx` resolves an absent `?campaigns=` to — **all three campaigns of Q3, not the newest
   one**. The picker's list is now GROUPED UNDER QUARTER HEADINGS, a row prints
   `firstDate → lastDate` rather than the dead `totalFedKg` (0 on every row — the span view is a
   calendar spine), and the selected chips take a real tonnage from `rollups[].fedKg`.
3. **THE BLOCKS-TABLE FOOTER ALIGNS WITH ITS COLUMNS.** *"Footers I don't really like. It should
   align with the columns. Also add the same kind of pop in the colour as the rest of the table —
   don't overly colour it, old people are reading this as a report, legibility is king."* A real
   `<tfoot>` row from `campaignBlocksFooter()` / `groupBlocksFooter()`, one published rollup field
   per column. Header takes the palette's OPAQUE `head` tint, the footer an opaque `bg-muted` cell
   with the TRANSLUCENT `cell` tint on an inner layer; numbers stay neutral `font-mono`. The GROUP
   leaves ARRV and RESIKO blank and says why (a shared block would double-count — the refusal the
   group RPC already makes). Priced coverage moved to the counts line rather than being dropped.
4. **PRODUCTION MODAL, LEANER.** *"Take out process loss, take out the description headings — too
   wordy."* PROCESS LOSS column, both section captions and the long notes are gone; one formula
   line and one caveat line remain.
5. **WASTE SHIFTS OUT.** *"What is waste shifts? That needs to be taken out."* Column and prose
   gone; `OpsProductionRow` lost `wasteShiftCount` / `shiftCount` so it cannot return by accident.
6. **THE RESULT BAR IS TILES.** *"It seems weird keeping them the same colour."* `KpiDetail.result`
   became `results: KpiResultTile[]` — `YIELD · LOSS · WASTE %` in emerald / amber / rose, label
   and unit pinned left, value large; a single-result modal renders ONE tile through the identical
   component.
7. **PRINT THE PRICE SUMMARIES.** *"When clicking on one campaign, have the option to print a
   summary of the selected campaign. If clicking on the group row, give the option to print all 3
   SEPARATELY… Make sure the printed summary is NOT WORDY."* `printCard` + `GroupPrintStage` /
   `GroupPrintPage` MOVED to **`components/shared/print/`** (platform: zero tenant knowledge), with
   one-line re-exports left in `/analytics` so nothing there moved; the stage gained an optional
   `showHeader` (default = today's analytics behaviour). New **`ops-print-sheet.tsx`** renders one
   page per campaign — title · span · counts · rows · aligned footer · result, black on white, no
   prose — and `KpiDetail.actions` carries the button (campaign) or the menu (group:
   `Print all N separately` + one entry each).

**TWO CSS FINDINGS WORTH KEEPING.** (a) `printCard` flattens ancestors with `transform: none`, but
Tailwind v4 centres a dialog with the INDIVIDUAL `translate` property, which that does not reset —
the sheet landed at `left: -960` on a 1920px viewport. (b) It could not be fixed in the print
stylesheet: **Lightning CSS folds `translate`/`rotate`/`scale` into a `transform` shorthand**, so
the rule compiled to `transform: translate3d(0,0,0)…` and did nothing — measured in the served CSS
with the resets both before and after `transform: none`. The stage is therefore PORTALLED to
`<body>`, which removes the translated ancestor instead of arguing with the compiler, and
`app/globals.css` was left untouched.

**Verification (2026-09-16, round 5).** `npx tsc --noEmit` clean · `npx eslint "app/(app)/operations"
components/shared/print "app/(app)/analytics/print-card.ts" "app/(app)/analytics/group-print.tsx"`
0 errors 0 warnings · `npm run build` passes. Driven in the Browser pane against a temporary
four-campaign fixture (three in `2026-Q3`, one in `2026-Q2`; blend data on fed days including one
day with a no-lab block; blocks in all four row kinds; one campaign reporting no production and
filing no waste) mounted at `app/dev/table-playground/ops7/` and **deleted afterwards** — `git
status` carries no trace. Measured there:

- **12 FED buttons** for 3 campaigns × 4 fed days — none on a rest day or on the day that produced
  without feeding. The sidebar prints all seven stats, `from 26,192 of 31,992 kg` on every one of
  them for the partial day, and the no-lab block reads blank across the panel.
- The picker: `Quarters Q3 2026 (3) · Q2 2026 (1)`, then headings `Q3 2026 — 2026-06-30 →
  2026-09-15` over JULY / AUGUST / SEPTEMBER in that order and `Q2 2026` over JUNE. The bare
  address resolved to all three Q3 campaigns.
- **ACTUAL FED PRICE at 1920×1080: twelve footer `left` offsets identical to their headers'**,
  `scrollWidth === clientWidth === 1298`, dialog 1342. The GROUP footer reads
  `GROUP · 1,867,340 · — · — · 4.50% · 45.90 · 47.90 · 2.00`.
- The PRODUCTION modal: 7 + 10 header cells (no PROCESS LOSS, no WASTE SHIFTS), no section
  headings, one caveat line, and three tiles `YIELD 79.52 · LOSS 20.48 · WASTE 15.24` in three
  hues.
- **PRINT**, with the print media queries re-scoped to `all` and the teardown timers frozen: one
  campaign → 1 page and `document.body.innerText` is the sheet alone; the group's
  `Print all 3 separately` → **3 pages**, `break-after` = `page · page · auto`, `window.print()`
  called once, STATE rendered as plain text and the sheet at `left: 0` full width.
- **1366×768** (dialog clamps, table the only scroller) and **375×812**
  (`document.scrollWidth === 375`, sheet full width, only the inner table scrolls sideways);
  LIGHT and DARK both rendered; **price-denied**: strip = `RC Fed · Produced · Yield · Loss ·
  Waste Loss · Resiko Loss`, the blocks table nine columns, **no `₱` glyph anywhere in the
  document**, sidebar included — and no print button exists, because neither price column does.

### 3.11 REFINEMENT PASS 6 (2026-09-17) — Renzo's four notes after *"looking cool"*

Read on production with JULY + AUGUST + SEPTEMBER 2026, hours after the RC Movement block
footer had been given its two labelled clocks. No data-layer change: every figure on every
new surface is a field the payload already carried.

1. **THE OUTPUT RATIOS GROUP IS ON A SWITCH.** *"Would be nice to have an option to toggle on
   and off the visibility of the column group 'output ratios', since the more accurate stat
   for loss and yield is the overall average when a batch closes. EOQ remains as is."* A
   `Ratios` toggle beside the lens tabs, state in **`?ratios=off`** with ON spelled as
   ABSENCE. `SpineCol.ratio` is the twin of `SpineCol.price`, so the two columns are **absent
   from the coordinate space, not blanked** — the frozen `left` offsets, `minWidth`, both
   footers and the expanded child rows all follow. **`NARROW_MQ` became
   `narrowQuery(spineWidth)` = `round(spineWidth / 0.9) − 1`**: the spine now has FOUR widths
   (922 / 820 / 770 / 668), the hardcoded 1023 was right for one of them, and the derived rule
   reproduces it exactly and gives 910 / 855 / 741 for the rest. The EOQ strip is untouched.
2. **THE BLOCK FOOTER IS THREE VALUES.** *"It is best that the footer remains just these
   values (top to bottom): kg fed (fed for the batch/campaign and not lifetime), php/kg (not
   actual), loss. The other values currently on that footer can be viewed on hover anyway."*
   `FED` (`campaignFedKg`) · `₱/KG` (delivered) · `LOSS %`, on **both** RC Movement grids and
   therefore inside `/operations`' RC FED modal, which hosts the Classic matrix. The `life`
   line, the `all campaigns` caption and the always-on `actual` line moved onto the hover card
   / the cell `title`, which were already printing them. `W_BLOCK` was **re-measured**, not
   left alone: 124 → **116** on the Classic matrix (`ACTUAL 1,234.56` is 93.44px against a
   `declared − 19` budget; 108 would have wrapped it), v2's 148 unchanged because it is set by
   its HEADER floor; `TOTALS_H` 62 → **46**, still a floor.
3. **THE `Actual ₱` SWITCH.** *"Being able to toggle on/off the ability to see the actual price
   of the block in the footer would be really cool."* ONE component,
   `rc-movement/actual-price-toggle.tsx`, rendered by three hosts because three surfaces show a
   block footer. The route keeps the state in **`?actual=on`** (OFF spelled as absence); the
   `/operations` modal keeps it in local state and passes the matrix the boolean **without a
   callback**, so the matrix renders no control of its own — which is what keeps
   `rc-movement-matrix.tsx` free of every router hook, the property that made it embeddable.
   ABSENT (never disabled) for a price-denied reader, and the footer line is gated a second
   time on `showActualLine = showFedPrice && showActualPrice`.
4. **PRINT THE WHOLE PAGE, ONE SECTION PER SHEET.** *"Have a print button on the main page…
   first the EOQ Roll Up in one page, then the 1st month in one page… Legibility is key, so
   just the key data. Output ratios group should be off by default when printing since it is
   redundant. Each month page should also have a little table giving the EOM rollup for that
   month."* New **`ops-page-print.tsx`** on the platform `GroupPrintStage` / `GroupPrintPage` /
   `printCard`, portalled to `<body>`. Page 1 = the EOQ rollup (only when there IS a group);
   pages 2..N = one per campaign, its KPI strip — **which IS the month's EOM rollup**, so it is
   printed once rather than twice — over the day ledger in KEY COLUMNS only. The eleven strip
   columns come from **`opsKpiPrintTable()`**, exported by `ops-kpi-strip.tsx` off its own
   `COLUMNS`, as plain data rather than as a render.

**FOUR MEASUREMENTS THAT DECIDED SOMETHING.**

- **The eight waste streams do not fit the printed ledger and were left out.** At 8pt a stream
  column needs ~56px and a grade column ~58px; A4 landscape at 10mm is **~1047px** of printable
  width and the nine spine columns are **600px** with two grades, so the streams (448px) put a
  two-grade campaign at 1048 and a four-grade one 117px over. The day's WASTE kg / WASTE %
  carry the total; the split is on screen under the Losses lens.
- **No spacer column on paper** — the opposite of the screen ledger. Paper does not scroll, so
  `width: 100%` + `table-fixed` makes the declared widths a RATIO and the columns fill the
  sheet instead of leaving ~40% blank. At a 1047px sheet both tables lay out at 1031px with
  `scrollWidth === clientWidth` and zero clipped headers.
- **The `@page` rule is injected and removed.** `globals.css` already sets A4 landscape at
  12mm and `@page` takes no class, so it governs every print in the app. The 10mm margin and
  the `[data-ops-print]` break rules live in a `<style>` appended at print time and removed
  when the stage unmounts (on `afterprint`). `app/globals.css` was NOT touched, and
  `/analytics` prints are unaffected.
- **A one-campaign selection prints ONE page.** With no GROUP row the EOQ page would be a
  single row identical to the campaign page's own strip.

**Verification (2026-09-17, round 6).** `npx tsc --noEmit` clean · `npx eslint
"app/(app)/operations" "app/(app)/inventory/rc-movement" components/shared/print
scripts/verify-rc-movement-grid.ts` 0 errors 0 warnings · `npm run build` passes ·
`npx tsx scripts/verify-rc-movement-grid.ts` **14 assertions** (was 13; the two-clock check was
rewritten to the three-value contract, the `Actual ₱` switch got its own, and the width check
now pins BOTH grids' `W_BLOCK`). Driven in the Browser pane against a temporary three-campaign
fixture (both changeover dates, a rest day, a day that produced without feeding, and a matrix
payload with campaign-vs-lifetime figures and two blocks with no actual price) at
`app/dev/table-playground/ops8/` — **deleted afterwards; `git status` carries no trace.**
Measured there: the ratios toggle removes/restores the two columns with correct offsets
(SHIFTS 780 → 628) and 21 cells on every row kind; the breakpoint moves (at 900px, OFF stays
frozen and ON un-freezes); the block footer reads three lines on both grids and two when
price-denied, with the hover card still printing `Fed (all camp.) 69,013 kg · In · MC · Ash ·
Actual fed · Uplift · Lost · Opened`; the modal composition renders exactly ONE toggle; the
print stage yields 4 pages / `page·page·page·auto` / one `window.print()` / 8pt cells / no
`YIELD %`, and 1 page for a single campaign; price-denied prints carry no `₱` in text or
markup. 1920 / 1366 / phone widths, light and dark.
