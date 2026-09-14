# Plant Operations Ledger (`/operations`)

## Purpose

Renzo's `Q3 2026` + `EOQ3 2026` workbook tabs, live. **One row per CALENDAR DAY on the
PRODUCTION-BATCH (campaign) clock, rest days included as blank rows**, with three day-grain
LENSES hanging off that spine (grades · the eight waste streams · one column per block fed), a
per-day expand (BLOCKS USED + the per-SHIFT breakdown), and a KPI strip on top — per campaign
and for a chosen GROUP of campaigns (Q3 2026 = JULY + AUGUST + SEPTEMBER).

> **THE UNIFICATION THESIS.** This screen and `/inventory/rc-movement` are **not two screens**;
> they are one screen showing two different **column groups** over the same **row spine**. The
> data layer makes that structurally true rather than merely plausible:
> `view_ops_ledger_day_block` *is* `view_rc_movement_campaign_cells`, re-keyed.

**Domain module (charcoal tenant).** Campaign-shaped, charcoal-shaped. Never imported by
platform components.

**Status: LIVE (2026-09-14).** Data layer — migration `20260914033037_ops_ledger`; UI — the
files below, branch `feat/ops-ledger`. Renzo picked draft **C — Split lens** from the three
layout drafts at `/dev/ops-ledger`, which are MOCK-ONLY and stay exactly where they are: no
file here imports from `app/dev/**`. See `.agents/plans/ops-ledger-plan.md` (§1 brief,
§2 data layer, §3 UI).

---

## Data

### The port and the adapter

| File | Role |
|---|---|
| `lib/operations/types.ts` | **THE PORT** — `OpsLedgerData`, `OpsLedgerDay`, `OpsShift`, `OpsDayBlockFeed`, `OpsDayBlockUsed`, `OpsCampaignRollup`, `OpsGroupRollup`, `OpsCampaignGrade`, `OpsCampaignOption`, plus `WASTE_STREAMS` and `GRADE_DISPLAY_ORDER`. Supersedes the draft port at `app/dev/ops-ledger/_mock/types.ts`; every divergence is annotated in place. |
| `lib/operations/queries.ts` | **THE ADAPTER** (server-only). `fetchOpsLedger(campaignKeys)` → one `OpsLedgerData`; `fetchOpsLedgerCampaignOptions()` → the picker. |

### The SQL objects (migration `20260914033037_ops_ledger`)

All eight views are `security_invoker`, `authenticated` SELECT only, `anon` REVOKEd, and
**deliberately NOT granted to `service_role`** — the sync worker reads none of them, so
`verify-worker-view-grants` stays at 4 views / 0 findings (L-044: a consumer is not a
dependency). Each view's plain-language definition lives in its DB `COMMENT`.

| View | Grain | Key columns | Rows |
|---|---|---|---|
| `view_ops_ledger_campaign_span` | campaign | `campaign_key`, `campaign_label`, `first_date`, `last_date`, `span_days`, `first_fed_date`, `feed_days`, `shift_count` | 32 |
| **`view_ops_ledger_day`** | campaign × calendar day | `calendar_date`, `weekday`, `is_weekend`, `is_rest_day`, `fed_kg`, `sundry_kg`, **`fed_php_kg` (₱)**, `produced_kg`, `day_drift_kg`, `blocks_fed_count`, `shift_count`, `shift_hrs_total`, `downtime_hours`, `downtime_incident_count`, `downtime_shift_count`/`_with_duration`/`_reason_only`, `run_count`, `sacks`, the eight waste columns, `total_waste_kg`, `production_reported` | **686** (≈31/campaign, max 33) |
| `view_ops_ledger_day_grade` | campaign × day × grade | `grade`, `kg`, `sacks`, `run_count` | 317 (max 48/campaign) |
| `view_ops_ledger_day_block` | campaign × day × block | `batch_id`, `batch_code`, `block_loc`, `fed_kg`, `sundry_kg` | 2,148 (max **114**/campaign) |
| `view_ops_ledger_day_blocks_used` | campaign × day × block | `first_fed_date` (date open), `close_date`, `is_closed`, `status`, `day_fed_kg`, `total_fed_kg`, `total_out_kg`, `delivered_kg`, `weight_lost_kg`, `loss_pct`, **`resiko_kg`/`resiko_pct`** (closed only), **`balance_kg`** (open only), `has_sundry_outflow`, `has_unpriced_delivery` | 2,148 |
| `view_ops_ledger_shift` | shift | `shift` (`M`/`E`), `shift_hrs`, `shift_hrs_source`, `dt_hrs`, `dt_mins`, `downtime_hours`, `productive_hrs`, `dt_reason`, `dt_ranges`, `dt_incident_ranges`, `has_incident`, `produced_kg`, `run_count`, `sacks`, the eight waste columns, `waste_remarks`, **`runs` (jsonb array)** | 260 |
| `view_ops_ledger_campaign_grades` | campaign × grade | `grade`, `kg`, `share_pct` (0–100), `campaign_produced_kg` | 21 |
| **`view_ops_ledger_campaign_kpis`** | campaign | the EOQ row — see below | 32 |

**`fn_ops_ledger_group_kpis(p_campaign_keys text[])`** — SECURITY INVOKER, `search_path`
pinned, EXECUTE revoked from `PUBLIC` + `anon`, granted to `authenticated`. One row: the group
KPI strip.

**THE THREE VERIFICATION PROBES** (migration `20260914065453_ops_ledger_verify_per_campaign`) —
all SECURITY DEFINER, STABLE, `search_path` pinned, EXECUTE revoked from `PUBLIC` + `anon` +
`authenticated` and granted to **`service_role` only**. They exist because the views are
authenticated-only, so neither key a script can hold may read them; each returns jsonb with
**no ₱ value** (gaps that must be 0, counts, booleans).

| Probe | Scope | What it answers |
|---|---|---|
| `fn_ops_ledger_verify_campaign(text)` | **ONE campaign** | the four day folds, day totals vs the KPI row, the grade fold, `ledger_days` vs `span_days`, both reuse comparisons, and the one-campaign GROUP identity |
| `fn_ops_ledger_verify_group(text[])` | **≤ 12 keys — RAISES above that** | the group vs a direct Σ over those campaigns' own KPI rows; block de-duplication, coverage, day split, changeover surplus |
| `fn_ops_ledger_verify_posture()` | catalog only | invoker/comment/grant posture, the three probes are `service_role`-only, `legacy_verify_fn_count = 0`, the money-column counts — **plus one 32-row read of `view_ops_ledger_campaign_span`**, whose only job is to hand the script the campaign keys |

> **PER CAMPAIGN ONLY. NEVER A WHOLE-HISTORY PROOF. 5 s GUARD ON EVERY HAND-RUN STATEMENT.**
> On **2026-09-14** the original probe `fn_ops_ledger_verify()` — one call that `count(*)`'d and
> cross-checked every `view_ops_ledger_*` view over all of history — hung the Supabase instance
> (OOM) and **took the live site down until a dashboard restart**. It was dropped
> (`20260914064415_drop_fn_ops_ledger_verify`) and its sibling `fn_ops_ledger_verify_groups` (32
> group-RPC calls in one statement) was deleted before it ever applied. The rule is now
> structural, not a convention: the campaign probe takes ONE key, the group probe RAISES above
> 12, and the script loops **strictly sequentially** (`for … await`, never `Promise.all`).
> **Every predicate is on `production_batch` + `campaign_year`, never on the computed
> `campaign_key`** — the latter cannot be pushed down into the views, and that pushdown is the
> whole reason a per-campaign read costs tens of milliseconds. When checking anything by hand:
> `set local statement_timeout = '5s';` first, and **one campaign per statement**.

**Measured per-campaign, JULY 2026, each under a 5 s guard:**

| read | ms | rows |
|---|---:|---:|
| `view_ops_ledger_campaign_span` (filtered) | 18 | 1 |
| `view_ops_ledger_shift` | 43 | 28 |
| `view_ops_ledger_day_block` | 36 | 94 |
| `view_ops_ledger_day` | 47 | 33 (5 rest) |
| `view_ops_ledger_day_grade` | 7 | 48 |
| `view_ops_ledger_day_blocks_used` | 23 | 94 |
| `view_ops_ledger_campaign_grades` | 26 | 3 |
| `view_ops_ledger_campaign_kpis` | 85 | 1 |
| `fn_ops_ledger_group_kpis(Q3 2026)` | 147 | 1 |
| `view_ops_ledger_campaign_span` (unfiltered) | 9 | 32 |

**ONE REAL DIVERGENCE THE NEW POSTURE PROBE CAUGHT ON ITS FIRST RUN:**
`view_ops_ledger_campaign_kpis` — the ₱-bearing view — carried **no `reloptions` at all** on the
live DB, i.e. it was **not** `security_invoker` and had been running as its OWNER for every
caller, although §10 of the ledger migration declares it. Repaired by
`20260914065558_ops_ledger_campaign_kpis_security_invoker` (`ALTER VIEW … SET` does not touch
grants, so the authenticated-SELECT / anon-REVOKE / no-`service_role` posture is unchanged).

### The eight things to know before touching this

**1. THE DAY SPINE IS THE UNION OF FEEDING AND PRODUCTION.** `first_date` = the earlier of the
campaign's first MAIN feed and its first production shift; `last_date` = the later of its last.
**Measured:** JULY 2026 last fed 2026-07-29 and produced through 2026-08-01 (22,862 + 4,620 +
2,466 kg); SEPTEMBER 2026 opened a shift on 2026-08-29, three days before its first feed. A
fed-only span — which is what `view_rc_movement_campaign_options` gives on its own — loses real
operating days at both ends. JULY 2026 is a **33-day** ledger.

**2. `day_drift_kg` IS DRIFT, NOT LOSS.** The feed tank is continuous flow, so a day's fed and
produced do not describe the same charcoal. Real loss is a CAMPAIGN figure: `process_loss_kg`
(the retort's) and `block_resiko_kg` (the yard's), both on the KPI view. **Never label the day
column "loss".**

**3. NULL IS NEVER 0.** No feed → `fed_kg` NULL. No production → `produced_kg` NULL. No waste
row → all eight streams NULL (`view_production_daily` COALESCEs its waste total to 0; that is
undone here). `sacks` NULL before bags were counted. And the same subtraction is published twice
under two names on the blocks-used expand — **`resiko_kg`** (closed: evaporation and resiko, a
real loss) and **`balance_kg`** (open: charcoal still in the pile) — so a UI cannot print one as
the other.

**4. A REST DAY IS A ROW.** 148 of the 686 day rows are rest days. Dropping blank Sundays would
make a month read as if it had 26 days.

**5. NOTHING IS RE-DERIVED.** `fed_kg` sums `view_rc_movement_campaign_cells` (which owns FED =
`destination = 'MAIN'` and the changeover-day split); `fed_php_kg` is
`view_rc_movement_campaign_day_price.wtd_fed_price` verbatim; `produced_kg` is
`view_rc_movement_campaign_production_daily_total` verbatim — the same figure the RC Movement
matrix prints; the hours and waste fold `view_ops_ledger_shift`, which folds
`view_production_daily` (the owner of the `dt_hrs + dt_mins/60` fold); the KPI row is a straight
SELECT from `view_analytics_batch_cost` + `view_analytics_production_by_batch`.

**6. THE GROUP REFUSES TWO NUMBERS IT CANNOT COMPUTE HONESTLY.** A block can be fed by more than
one campaign — measured **78 of 523 blocks, up to 5 each; 5 of Q3-2026's 45**. So the group
publishes **no resiko KG** (only the fed-kg-weighted ratio) and **no whole-block
`actual_fed_php_kg`** (only the campaign-attributed form, weighted by `campaign_fed_kg_included`,
which *partitions* by campaign). Counts come de-duplicated (`blocks_fed_distinct` = 45) beside
the naive sum (`blocks_fed_campaign_sum` = 50), both labelled.

**7. TRUE PC COST IS STRICT NULL UNLESS EVERYTHING IS COVERED.** `php_per_produced_kg_true` is
NULL unless every block a campaign fed is CLOSED and fully priced, and for a group unless every
campaign is. Q3 2026 is not — SEPTEMBER's blocks are 78.9% covered — so the group reads NULL with
`php_per_produced_kg_true_covered` populated and `campaigns_fully_covered = 2` of 3.

**8. FRACTIONS vs PERCENTS, kept as their sources have them.** FRACTIONS (×100 at render):
`yield_pct`, `process_loss_pct`, `block_resiko_loss_pct`, `campaign_fed_kg_included_pct`,
`loss_pct`, `resiko_pct`, `covered_fed_kg_share`. PERCENTS (0–100) already: `share_pct`,
`fed_price_coverage_pct`, `sacks_coverage_pct`. They were deliberately **not** harmonised, so a
reader can compare this screen with `/analytics` digit for digit.

### PRICE GATING (server-side, structural)

**The ONE ₱ column on the day spine is `fed_php_kg`.** The KPI view carries seven:
`fed_php_kg`, `fed_value_php`, `actual_fed_php_kg`, `campaign_weighted_actual_fed_php_kg`,
`uplift_php_kg`, `php_per_produced_kg_delivered`, `php_per_produced_kg_true`. The group RPC
carries the same seven plus `php_per_produced_kg_true_covered`.

`fetchOpsLedger` resolves the canonical `canViewPrices()` from `@/lib/auth` **once** and sets
every one of those to `null` **before the payload leaves the server**, then passes
`canViewPrices: boolean` down. **Production is the only role denied** (an impersonating
Owner/Admin/Dev viewing as Production is denied too — the gate reads `getUserRole()`). The UI
must **drop the ₱ column from its coordinate space**, not render it blank — the RC Movement
precedent.

Everything else — the shift expand, the grade lens, the block lens, the blocks-used expand and
`view_ops_ledger_campaign_grades` — carries **no money-named column at all** and none is
derivable, so those surfaces are safe for every role.

### Row budgets / PostgREST

No single campaign's lens exceeds **114 rows**, so every read is far under PostgREST's 1,000-row
cap *per campaign*. But `view_ops_ledger_day_block` is **2,148 rows over all history**, so the
page must **fetch PER CAMPAIGN and fold** — which is what `fetchOpsLedger` does (per-campaign
reads in parallel, each paged through `fetchAllRows`). A whole-history read would truncate
silently.

### Proofs

`npx tsx scripts/verify-ops-ledger.ts` — **68 assertions** (15 static + 53 live); zero on every
`*_mismatch` is the passing state. Measured 2026-09-14, **all 32 campaigns, one RPC call each,
strictly sequential**: every fold and both reuse comparisons 0 mismatches on 32/32, the
one-campaign-group identity 0/32, `day_rows == span_days` on 32/32, **686 ledger days / 148 rest
days**, the Q3 yield / fed-rate / PC-cost gaps exactly 0, anon and `service_role` refused by a
real read, `legacy_verify_fn_count = 0`. **Slowest single campaign 853 ms (JANUARY 2026)**,
16.3 s wall for the whole sequential loop including round-trips — the script FAILS any call over
**5,000 ms**, so the 2026-09-14 shape cannot come back unnoticed. Full table in
`.agents/plans/ops-ledger-plan.md` §2.6.

---

## Files

| File | Role |
|---|---|
| `page.tsx` | **Server Component.** Resolves `?campaigns=` / `?lens=`, reads the campaign options and the ledger, renders `OperationsView`. Owns nothing else — the ₱ gate lives in the adapter and the title in the navbar. |
| `operations-view.tsx` | `'use client'` — the CONTROLS. Writes the URL (`router.replace` inside a transition), owns the lens segmented control, the EOQ collapse, the `campaignsMissing` notice and the block detail drawer. |
| `ops-ledger-split.tsx` | The ledger itself: two scroll-synced panes, a draggable divider, the frozen header/footer, the three lenses' columns and the per-day expansion band. |
| `ops-kpi-strip.tsx` | The `EOQ` tab — one row per campaign plus the GROUP row, nine columns, with the coverage captions. |
| `ops-day-detail.tsx` | What a day opens into: `OpsShiftCards` (left pane) and `OpsBlocksUsedTable` (right pane). |
| `ops-group-picker.tsx` | The GROUP builder — selection chips + a popover holding the full campaign list, a filter box and the derived quarter presets. |
| `ops-lens.ts` | The lens registry (`grades` · `losses` · `blocks`), `parseLens`, and `quarterPresets()` — quarters DERIVED from the option list, never hardcoded. |
| `ops-format.ts` | `kg` · `tons` · `php` · `pctFromFraction` · `pctFromPercent` · `hours` · `count` · `shortDate`. Renderers only. |

---

## Key Behaviors (UI)

**THE URL IS THE STATE.** `?campaigns=JULY-2026,AUGUST-2026,SEPTEMBER-2026` (comma-separated
campaign keys, upper-cased and de-duplicated on read, written back in the campaigns' own DATE
order) and `?lens=grades|losses|blocks` (the default is spelled as ABSENCE, so a plain address
stays clean and the param's presence always means something). Both are written with
`router.replace` inside a `useTransition`, so the server page re-reads and the payload comes
back already folded — no client fetch and no second copy of the resolution logic. The outgoing
ledger stays mounted at `opacity-50` while the new one resolves (compositor-only, nothing
reflows). **Absent `?campaigns=` = the newest campaign**, resolved from the same
`view_rc_movement_campaign_options` list, same filter and same order as RC Movement's picker.

**THE EXPANDED DAY AND THE BLOCK DRAWER ARE DELIBERATELY NOT IN THE URL.** Both are
disclosures inside ONE reading of one payload — the category RC Movement also keeps in local
state — and putting either in the address would re-run the server on every chevron click to
change nothing the server computes.

**AN UNKNOWN CAMPAIGN KEY IS NOT AN ERROR.** The group RPC returns it in `campaignsMissing`
rather than dropping it; the view prints a muted notice naming the keys and renders the
campaigns that did resolve. A mistyped or retired key must never read as a silently smaller
quarter. When NOTHING resolves the page says so and points at the bare `/operations` URL.

**SPLIT LENS.** The LEFT pane is the day spine — `DATE · DAY · FED ₱/KG · TTL FED · TTL PROD ·
DRIFT · SHIFTS · DT HRS`, one row per calendar day, **rest days included as blank rows**. It
never scrolls sideways: a frozen column can still be pushed off screen, a pane cannot. The
RIGHT pane is the chosen lens, scrolling horizontally on its own behind a divider that is
**dragged in PIXELS, not as a fraction of the frame** (a deliberate change from the draft — the
spine's natural width is a known constant, so a pixel default makes it fit EXACTLY on the first
paint, which is the entire claim of this layout). A `ResizeObserver` re-clamps it so neither
pane can be squeezed below 240px. The divider is keyboard-operable (←/→).

**THE TWO PANES ARE ONE ROW SPINE.** They render the identical row sequence at identical
explicit heights (header 36 · campaign band 28 · day 32 · campaign footer 28 · group footer 34
· **expansion band a CONSTANT 320**) and are vertically scroll-synced with an
ownership guard so the two `onScroll` handlers cannot write to each other forever. *Verified in
Chrome: the two panes' `tbody > tr` tops are identical for every row.* The band's height is a
constant precisely because letting each side size to its own content would de-sync every row
below the expanded one — the failure mode a split view has and a single sheet does not.

**THE THREE LENSES.** `grades` (one column per grade — read from `OpsLedgerData.grades`,
**never a hardcoded list**), `losses` (the eight `WASTE_STREAMS` in the sheet's order), `blocks`
(one column per block fed — **this lens IS the RC Movement matrix**). A block column header
carries no sort/filter chrome; it IS the affordance and **opens that block's
`BlockingDetailPanel`**, through the same `fetchBlockDataForBatch` + optimistic-open contract
RC Movement and the digest's Open Blocks band use. Batch codes in the BLOCKS USED expand open
the same drawer. "Edit All" from the drawer pushes `/inventory?tab=…` explicitly, because there
is no inventory tab provider on this route.

**NO ARITHMETIC ANYWHERE IN THE COMPONENTS.** No `reduce`, no `+`, no ratio on any render path
— the only sums left are column-width bookkeeping, which is layout. Day figures come from
`OpsLedgerDay`, campaign footers from `OpsCampaignRollup`, the sticky group footer from
`OpsGroupRollup`, grade campaign totals from `gradesByCampaign`. **Where a total does not exist
in the payload the footer SAYS SO** — the waste streams and the per-block columns have no
campaign or group total, so that footer prints one sentence instead of a fabricated number.

**DRIFT IS NEVER CALLED LOSS.** The day column is `DRIFT KG`, its header carries the
continuous-flow explanation on hover, and the day-expand repeats it beside the waste streams
(which do NOT sum to it). The CAMPAIGN and GROUP footers in that same column print
`processLossKg` — at those grains fed − produced genuinely IS loss — and say so in a `title`.

**PRICE GATING IS ABSENCE, NOT A BLANK.** `canViewPrices` drops `FED ₱/KG` from the spine's
coordinate space (the frozen-width arithmetic reads the flag) and the four ₱ columns from the
EOQ strip. The server already nulled the fields; this is the render guard. *Verified against a
price-denied payload: the spine renders 7 columns and the strip 5.*

**TRUE PC COST IS NEVER FILLED IN.** Null unless every block is closed and priced; the cell
prints `—` with the coverage caption that says why (`17 of 20 closed · 16 priced`), and for the
GROUP the always-computed `phpPerProducedKgTrueCovered` rides beside it, labelled `covered`.
The group's BLOCK RESIKO cell prints the weighted RATIO and no kg, captioned `ratio only
(shared blocks)` — a block can be fed by several campaigns.

**EXCEL STANDARD / NEVER CRUSH.** `table-fixed` with explicit pixel widths everywhere,
`px-2 py-1`, `text-xs`, 32px rows, `font-mono tabular-nums` right-aligned numerics, ₱ in
accounting format (symbol pinned left). Every table declares `min-width = Σ of its column
widths` inside an `overflow-x-auto` (or the pane's own `overflow-auto`) wrapper. Each pane's
table ends in an **empty auto-width SPACER column** so leftover pane width is absorbed there
instead of being distributed across the data columns — the one case the "never let a `w-auto`
column absorb the slack" rule does not bite, because the spacer carries no content and the
`minWidth` still forces a scrollbar when the pane is too narrow. *Measured at 375px: document
`scrollWidth === innerWidth`.*

**FROZEN SURFACES ARE OPAQUE.** Header cells and the group-footer cells carry a solid
`bg-muted` with `.frozen-row` / `.frozen-row-bottom` + `.frozen-edge-top`; the spine pane
carries `.frozen-edge` on its right edge. The pinning classes go on the CELLS, never on the
`<tr>` — Tailwind's preflight sets `border-collapse: collapse`, under which sticky on a row is
the browser-dependent form.

**MOTION.** No row animates and nothing is staggered. The only animation is
`animate-fade-in` on the expansion band and `animate-fade-up` on the empty state; the campaign
switch is an opacity transition on a mounted sheet.

**PHONE (< 768px).** The split keeps its idea and drops the simultaneity: a segmented control
swaps which pane is on screen and the two keep one shared scroll position. The spine's
expansion band carries BOTH halves of the breakdown there, since the lens pane is not visible.
`narrow` starts `false` on server and client and is set in an effect, so the first client
render matches the server's.

**ERRORS.** The block drawer is opened optimistically and a failed fetch keeps it open with the
panel's own persistent, copyable inline banner plus Retry (the project HARD RULE on error
surfaces) — never a silently empty drawer. The `campaignsMissing` notice is deliberately NOT an
error: nothing failed.

---

## Dependencies

**Data layer:** `lib/supabase/server`, `lib/auth` (`canViewPrices`), `lib/supabase/paginate`
(`fetchAllRows`), `types/supabase`. Reads only `view_ops_ledger_*` and
`view_rc_movement_campaign_options`.

**UI:** `lib/operations/{types,queries}`, `lib/utils` (`cn`), `components/ui/{popover,input}`,
`lucide-react`, and two files from the inventory module —
`app/(app)/inventory/_shared/blocking-detail-panel` (the shell-agnostic drawer, already shared
by Blocking, RC Movement, the inventory tab shell and the digest's Open Blocks band) and
`app/(app)/inventory/blocking/actions#fetchBlockDataForBatch` + its `BlockData` type. Both are
TENANT code, as this module is. **Nothing is imported from `app/dev/**`**, and the drafts there
are untouched. The Blackwood Table is deliberately NOT used — see the header comment in
`ops-ledger-split.tsx`.

**Registered in the navbar:** `getBreadcrumb()` (`Operations` · *Plant operations ledger — day
rows on the campaign clock, with the EOQ rollup*) and `ICTC_MODULES`, next to Analytics.

## See also

- `.agents/plans/ops-ledger-plan.md` — §1 brief, §2 data layer, §3 UI
- `app/dev/ops-ledger/CONTEXT.md` — the three layout drafts and the unification thesis
- `app/(app)/inventory/rc-movement/CONTEXT.md` — the matrix this ledger shares a spine with
- `app/(app)/production/daily/CONTEXT.md` — the shifts/runs/downtime/waste source (L-051/L-051b)
- `CLAUDE.md` → "Views", "Price gating", "Database Rules", "Frozen Panes", "Excel Standard"
