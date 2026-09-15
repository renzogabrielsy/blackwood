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
| `ops-kpi-strip.tsx` | The EOQ table — a row per campaign + the GROUP row, nine columns, every cell a button. |
| `ops-kpi-modal.tsx` | The per-KPI "show me the math" dialog (`KpiDetail`). |
| `ops-color.ts` | The semantic palette (`TONE`, `CAMPAIGN_ACCENTS`). |
| `ops-day-detail.tsx` | `OpsShiftCards` + `OpsBlocksUsedTable`. |
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
