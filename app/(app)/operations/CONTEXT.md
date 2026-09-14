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

**Status: DATA LAYER ONLY (2026-09-14).** Migration `20260914033037_ops_ledger`, branch
`feat/ops-ledger`. The page and its components are a later pass — see
`.agents/plans/ops-ledger-plan.md` (§1 brief, §2 data layer, §3 UI). The interactive layout
drafts live at `/dev/ops-ledger` (Renzo picked draft **C — Split lens**).

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

## Dependencies

`lib/supabase/server`, `lib/auth` (`canViewPrices`), `lib/supabase/paginate` (`fetchAllRows`),
`types/supabase`. Reads only `view_ops_ledger_*` and `view_rc_movement_campaign_options`.

## See also

- `.agents/plans/ops-ledger-plan.md` — §1 brief, §2 data layer, §3 UI
- `app/dev/ops-ledger/CONTEXT.md` — the three layout drafts and the unification thesis
- `app/(app)/inventory/rc-movement/CONTEXT.md` — the matrix this ledger shares a spine with
- `app/(app)/production/daily/CONTEXT.md` — the shifts/runs/downtime/waste source (L-051/L-051b)
- `CLAUDE.md` → "Views", "Price gating", "Database Rules", "Frozen Panes", "Excel Standard"
