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
| `lib/operations/types.ts` | **THE PORT** — `OpsLedgerData`, `OpsLedgerDay`, `OpsShift`, `OpsDayBlockFeed`, `OpsDayBlockUsed`, **`OpsCampaignBlock`**, **`OpsGroupBlock`**, `OpsCampaignRollup`, `OpsGroupRollup`, `OpsCampaignGrade`, `OpsCampaignOption`, plus `WASTE_STREAMS` and `GRADE_DISPLAY_ORDER`. `OpsCampaign.blocks` and `OpsGroupRollup.blocks` carry the blocks-used table. Supersedes the draft port at `app/dev/ops-ledger/_mock/types.ts`; every divergence is annotated in place. |
| `lib/operations/queries.ts` | **THE ADAPTER** (server-only). `fetchOpsLedger(campaignKeys)` → one `OpsLedgerData`; `fetchOpsLedgerCampaignOptions()` → the picker. |

### The SQL objects (migration `20260914033037_ops_ledger`, + `20260915021820_ops_ledger_campaign_waste`)

All eight views are `security_invoker`, `authenticated` SELECT only, `anon` REVOKEd, and
**deliberately NOT granted to `service_role`** — the sync worker reads none of them, so
`verify-worker-view-grants` stays at 4 views / 0 findings (L-044: a consumer is not a
dependency). Each view's plain-language definition lives in its DB `COMMENT`.

| View | Grain | Key columns | Rows |
|---|---|---|---|
| `view_ops_ledger_campaign_span` | campaign | `campaign_key`, `campaign_label`, `first_date`, `last_date`, `span_days`, `first_fed_date`, `feed_days`, `shift_count` | 32 |
| **`view_ops_ledger_day`** | campaign × calendar day | `calendar_date`, `weekday`, `is_weekend`, `is_rest_day`, `fed_kg`, `sundry_kg`, **`fed_php_kg` (₱)**, `produced_kg`, `day_drift_kg`, `blocks_fed_count`, `shift_count`, `shift_hrs_total`, `downtime_hours`, `downtime_incident_count`, `downtime_shift_count`/`_with_duration`/`_reason_only`, `run_count`, `sacks`, the eight waste columns, `total_waste_kg`, `production_reported`, **`waste_pct` / `yield_pct` / `loss_pct` (2026-09-15, FRACTIONS)** | **688** (≈31/campaign, max 33) |
| `view_ops_ledger_day_grade` | campaign × day × grade | `grade`, `kg`, `sacks`, `run_count` | 317 (max 48/campaign) |
| `view_ops_ledger_day_block` | campaign × day × block | `batch_id`, `batch_code`, `block_loc`, `fed_kg`, `sundry_kg` | 2,148 (max **114**/campaign) |
| `view_ops_ledger_day_blocks_used` | campaign × day × block | `first_fed_date` (date open), `close_date`, `is_closed`, `status`, `day_fed_kg`, `total_fed_kg`, `total_out_kg`, `delivered_kg`, `weight_lost_kg`, `loss_pct`, **`resiko_kg`/`resiko_pct`** (closed only), **`balance_kg`** (open only), `has_sundry_outflow`, `has_unpriced_delivery` | 2,148 |
| `view_ops_ledger_shift` | shift | `shift` (`M`/`E`), `shift_hrs`, `shift_hrs_source`, `dt_hrs`, `dt_mins`, `downtime_hours`, `productive_hrs`, `dt_reason`, `dt_ranges`, `dt_incident_ranges`, `has_incident`, `produced_kg`, `run_count`, `sacks`, the eight waste columns, `waste_remarks`, **`runs` (jsonb array)**, **`waste_pct` / `grade_kg` (2026-09-15)** | 260 |
| **`view_ops_ledger_campaign_block`** | campaign × block | `batch_code`, `block_loc`, **`campaign_fed_kg`**, `campaign_sundry_kg`, `campaign_feed_days`, `first_fed_date` (date open), `close_date`, `is_closed`, `status`, `total_fed_kg`, `total_out_kg`, `delivered_kg`, `weight_lost_kg`, `loss_pct`, `resiko_kg`/`resiko_pct`/`balance_kg`, `is_fully_priced`, **`in_price_set`**, and **four ₱** (`delivered_php_kg`, `priced_delivered_php_kg`, `actual_fed_php_kg`, `uplift_php_kg`) | **523** (19/campaign for JULY 2026) |
| `view_ops_ledger_campaign_grades` | campaign × grade | `grade`, `kg`, `share_pct` (0–100), `campaign_produced_kg` | 21 |
| **`view_ops_ledger_campaign_kpis`** | campaign | the EOQ row — see below; **+ the eight waste streams, `waste_kg`, `waste_shift_count`, `waste_loss_pct` (2026-09-15; its denominator became PRODUCED kg the same day)** | 32 |

**`fn_ops_ledger_group_kpis(p_campaign_keys text[])`** — SECURITY INVOKER, `search_path`
pinned, EXECUTE revoked from `PUBLIC` + `anon`, granted to `authenticated`. One row: the group
KPI strip. **It was DROPped and re-CREATEd on 2026-09-15** to append the waste columns (a
`RETURNS TABLE` cannot be `CREATE OR REPLACE`d), which LOSES its grants — re-applied in the same
migration and proven live every run: `authenticated` true / `anon` false / `service_role` false.

**`fn_ops_ledger_group_blocks(p_campaign_keys text[])`** (2026-09-15) — same posture,
`authenticated` only. The BLOCKS USED table for a GROUP: **one row per DISTINCT block**, so a
block fed by two of the group's campaigns is ONE row carrying `campaign_count = 2` and both
`campaign_keys`. Its row count IS `blocks_fed_distinct` and Σ `group_fed_kg` IS the group's
`fed_kg` — both proven every run. `group_feed_days` COUNTS DISTINCT DATES rather than summing
the per-campaign day counts, because a changeover date belongs to two campaigns. It is a
FUNCTION and not a view for the same reason the group KPI row is: a group is a chosen set of
keys, not a stored dimension.

**THE THREE VERIFICATION PROBES** (migration `20260914065453_ops_ledger_verify_per_campaign`) —
all SECURITY DEFINER, STABLE, `search_path` pinned, EXECUTE revoked from `PUBLIC` + `anon` +
`authenticated` and granted to **`service_role` only**. They exist because the views are
authenticated-only, so neither key a script can hold may read them; each returns jsonb with
**no ₱ value** (gaps that must be 0, counts, booleans).

| Probe | Scope | What it answers |
|---|---|---|
| `fn_ops_ledger_verify_campaign(text)` | **ONE campaign** | **the CAMPAIGN × BLOCK table (`campaign_block_fold_mismatch` — Σ `campaign_fed_kg` vs the KPI row's `fed_kg`; `campaign_block_count_mismatch` — row count vs `blocks_fed`)**, the four day folds, **the WASTE fold (`waste_fold_mismatch`, 0/1) and the PER-STREAM fold (`waste_stream_fold_mismatch`, a count 0..8 — a total can agree while two streams are swapped)**, day totals vs the KPI row, the grade fold, `ledger_days` vs `span_days`, **the DAY-RATIO self-consistency check (`day_ratio_mismatch`) and the campaign denominator (`kpi_waste_pct_mismatch`, 0/1)**, both reuse comparisons, and the one-campaign GROUP identity (waste columns included) |
| `fn_ops_ledger_verify_group(text[])` | **≤ 12 keys — RAISES above that** | **the GROUP BLOCKS table (`gap_group_blocks_fed_kg`, `gap_group_blocks_distinct`, both exactly 0)**, the group vs a direct Σ over those campaigns' own KPI rows (**`gap_waste_kg` included — exact by construction, since a shift has one campaign**); block de-duplication, coverage, `campaigns_waste_reported` / `waste_shift_count`, day split, changeover surplus |
| `fn_ops_ledger_verify_posture()` | catalog only | invoker/comment/grant posture (**9 views since 2026-09-15**), **`campaign_block_money_named_columns` — the EXACT SET of money-ish names on the new view, not a count**, the three probes are `service_role`-only, `legacy_verify_fn_count = 0`, the money-column counts — **plus one 32-row read of `view_ops_ledger_campaign_span`**, whose only job is to hand the script the campaign keys |

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
| `view_ops_ledger_campaign_kpis` | 85 → **33** | 1 |
| `fn_ops_ledger_group_kpis(Q3 2026)` | 147 → **135** | 1 |
| **`view_ops_ledger_campaign_block`** (filtered) | **28** | **19** |
| **`fn_ops_ledger_group_blocks(Q3 2026)`** | **42** | **46** |
| `view_ops_ledger_campaign_span` (unfiltered) | 9 | 32 |

**What the 2026-09-15 DAY RATIOS cost: nothing measurable.** `waste_pct` / `yield_pct` /
`loss_pct` divide columns the row already carries, so they add no join and no scan. JULY 2026 on
the day view: **1,074 → 1,071 shared buffers** (95.5 ms → 12.8 ms, the drop being cache, not the
change). The campaign view, whose `waste_loss_pct` swapped denominator from `fed_kg` to
`produced_kg` — a column it was already selecting — went **2,662 → 2,656 buffers** (155.1 → 127.7
ms), and the Q3 group RPC **3,046 → 3,019 buffers** (125.7 → 134.8 ms). The per-campaign probe
costs **280 ms / 10,982 buffers** (AUGUST 2026) to **581 ms / 12,599** (SEPTEMBER 2025)
server-side; the wall-clock the script prints is round-trip-dominated and moves with instance
load, which is why the budget is a generous 5 s.

**What the 2026-09-15 waste columns cost, measured under the same 5 s guard.** The campaign
fold alone (`sum()` over `view_ops_ledger_shift` filtered to JULY 2026) is **3.570 ms / 30
shared buffers**; the whole new view body as a plain query is **67.291 ms / 2,130 buffers**
against the old view's **54.647 ms / 2,100** — **+12.6 ms and +30 buffers**. The group RPC on
Q3 2026 measured **135 ms** after the change (147 ms before). The `ms` column above now reads
settled wall-clock from a `clock_timestamp()` pair rather than the original `EXPLAIN` summary,
which is why `campaign_kpis` reads lower than the figure it replaced; the shape is unchanged.

**ONE REAL DIVERGENCE THE NEW POSTURE PROBE CAUGHT ON ITS FIRST RUN — AND IT CAME BACK.**
`view_ops_ledger_campaign_kpis` — the ₱-bearing view — carried **no `reloptions` at all** on the
live DB, i.e. it was **not** `security_invoker` and had been running as its OWNER for every
caller, although §10 of the ledger migration declares it. Repaired by
`20260914065558_ops_ledger_campaign_kpis_security_invoker` (`ALTER VIEW … SET` does not touch
grants, so the authenticated-SELECT / anon-REVOKE / no-`service_role` posture is unchanged).

> **THE MECHANISM, learned properly the second time (2026-09-15): `CREATE OR REPLACE VIEW`
> KEEPS THE GRANTS BUT RESETS `reloptions`.** Appending the nine waste columns knocked
> `security_invoker` off this same view again — caught within a minute by asking
> `pg_options_to_table(reloptions)` straight after applying, while the grants were all still
> intact (`authenticated` SELECT true, `anon` false, `service_role` false), **which is exactly
> why a grant check cannot find it**. Repaired by `20260915021924_ops_ledger_campaign_kpis_security_invoker_restore`.
> **THE RULE: any migration that `CREATE OR REPLACE`s a `view_ops_ledger_*` view must re-assert
> `alter view … set (security_invoker = true)` — in that file or a later one.** Now enforced
> statically by `scripts/verify-ops-ledger.ts` (it scans every migration file, pairs each
> replacement with a re-assertion at or after its version) and live by
> `fn_ops_ledger_verify_posture()`'s `not_security_invoker = 0`.

### The nine things to know before touching this

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
undone here), and the same holds at the CAMPAIGN and GROUP grain — a campaign none of whose
shifts filed a waste row reads NULL on all nine kg columns and on `waste_loss_pct`, never 0.
`sacks` NULL before bags were counted. And the same subtraction is published twice
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
`yield_pct`, `process_loss_pct`, `block_resiko_loss_pct`, **`waste_loss_pct`**,
`campaign_fed_kg_included_pct`, `loss_pct`, `resiko_pct`, `covered_fed_kg_share`. PERCENTS (0–100) already: `share_pct`,
`fed_price_coverage_pct`, `sacks_coverage_pct`. They were deliberately **not** harmonised, so a
reader can compare this screen with `/analytics` digit for digit.

**9. WASTE LOSS IS A CAMPAIGN COLUMN, AND IT IS NOT PROCESS LOSS (2026-09-15).**
`view_ops_ledger_campaign_kpis` and `fn_ops_ledger_group_kpis` carry the eight RECORDED streams
(`trml1_kg`, `trml2_kg`, `rs1a_kg`, `rs1b_kg`, `rs23_kg`, `rs5_kg`, `bf_kg`, `grit_kg`), their
total **`waste_kg`**, **`waste_shift_count`** (the shifts that filed a waste row — the coverage
behind the total) and **`waste_loss_pct` = `waste_kg ÷ produced_kg`, a FRACTION** (point 8's
convention; ×100 at render). The group adds **`campaigns_waste_reported`** and
**`produced_kg_waste_reported`**. On the port: `OpsCampaignRollup.waste` / `.wasteKg` /
`.wasteShiftCount` / `.wasteLossPct`, and the same on `OpsGroupRollup` plus
`.campaignsWasteReported` / `.producedKgWasteReported`. **No ₱ column, none derivable — the whole
band is safe for Production and is not gated.**

- **THE DENOMINATOR IS PRODUCTION OUTPUT, NOT FED KG (Renzo, 2026-09-15 — migration
  `20260915032016_ops_ledger_day_ratios_waste_over_produced`).** What the plant sweeps up off the
  screens and trommels came OUT of the retort and was then rejected, so it is a property of the
  OUTPUT; dividing it by what went IN mixes it with the moisture and volatiles `process_loss_pct`
  already accounts for. **JULY 2026 moved from 0.121156 to 0.152369** (94,651.5 kg over 621,201 kg
  produced) and Q3 2026 from 0.114719 to **0.146174**. Only the EXPRESSION changed: same column
  name, same position, same type, so it stayed a `CREATE OR REPLACE`. It is NULL — never 0 — when
  produced is NULL or 0, and **measured, 0 of the 10 waste-reporting campaigns lose their ratio**.
  `kpi_waste_pct_mismatch` (campaign) and `gap_waste_pct` (group) are what would catch it
  reverting.

- **THEY DO NOT SUM TO `processLossKg`.** Most of what the retort loses leaves as moisture and
  volatiles that nobody weighs; this is what was swept up and put on a scale. It is a recovery /
  housekeeping figure, never a second process-loss number, and the DB `COMMENT`s say so.
- **ONE ARITHMETIC AT TWO GRAINS.** The campaign fold sums `view_ops_ledger_shift`, the SAME
  relation the day spine folds — so the EOQ cell and the LOSSES lens footer cannot disagree, and
  `waste_fold_mismatch` + `waste_stream_fold_mismatch` prove it on all 32 campaigns. The GROUP
  sums the CAMPAIGN view's own columns rather than re-folding the shift view (`gap_waste_kg = 0`).
- **WHY A GROUP WASTE KG EXISTS WHERE A GROUP RESIKO KG DOES NOT** (point 6): a BLOCK can be fed
  by several campaigns, but a SHIFT belongs to exactly one, so waste partitions cleanly and the
  kilograms simply add.
- **THE GROUP RATIO'S DENOMINATOR IS NARROWED ON PURPOSE.** `waste_loss_pct` divides by
  **`produced_kg_waste_reported`** — the PRODUCED kilos of the campaigns that actually filed waste
  — not by the group's whole produced total. Production reporting begins 2025-11-27, so **22 of
  the 32 campaigns fed the plant and filed no shift at all**; including their kilos would
  understate any group straddling that boundary, the same trap `yield_pct` avoids with
  `fed_kg_production_reported`. Measured on **Q3 2026: 218,401.0 ÷ 1,494,121.0 = 0.146174**, and
  all three campaigns filed waste, so the narrowing costs Q3 nothing and protects every group that
  reaches back past November 2025.

- **THE DAY ROWS CARRY THEIR OWN RATIOS (2026-09-15).** `view_ops_ledger_day` publishes
  **`waste_pct` = `total_waste_kg ÷ produced_kg`** — the SAME denominator as the campaign cell, so
  a day figure and the EOQ figure are one definition at two grains — plus **`yield_pct` =
  `produced_kg ÷ fed_kg`** and **`loss_pct` = `1 − yield_pct`**. All three are FRACTIONS and all
  three are NULL, never 0, when an input is missing or a denominator is 0 (a rest day reads blank
  on all three). **A DAY YIELD IS INDICATIVE ONLY and must be labelled that way wherever it is
  shown:** the feed tank is continuous flow, so a day's fed kilos and its produced kilos are not
  the same charcoal — 2026-07-02 divides to **0.9955** and a JULY day produced 22,862 kg on no
  feed at all. It is the same statement `day_drift_kg` makes in kilograms (point 2), said as a
  ratio; the REAL yield is the campaign figure. `day_ratio_mismatch` proves each published ratio
  equals the division of that row's OWN inputs and pins `loss_pct` to `1 − yield_pct`, so a row
  can never print a yield and a loss that do not add to 1. Sample: **2026-07-02 — waste_pct
  0.151514 · yield_pct 0.995483 · loss_pct 0.004517**. **Since 2026-09-15 these three (plus
  `total_waste_kg`) ARE the ledger's spine columns** — they replaced `day_drift_kg`, which is no
  longer rendered anywhere in the UI; see "THE DRIFT COLUMN IS GONE" under Key Behaviors.
- **Live figures at 2026-09-15**, on the PRODUCED denominator that shipped the same day (the
  earlier fed-kg figures 0.121155 / 0.114719 are the retired definition and are recorded above
  only as the before-half of the change). JULY 2026 — TRML1 2,391.0 · TRML2 11.5 · RS1A 38,135.0
  · RS1B 36,475.0 · RS2/3 7,869.0 · RS5 4,191.0 · BF 4,557.0 · GRITS 1,022.0 = **94,651.5 kg over
  23 of 28 shifts**, against 621,201.0 kg PRODUCED = **0.152369**. Q3 2026 — **218,401.0 kg over
  58 shifts**, 1,494,121.0 kg produced = **0.146174**, 3 of 3 campaigns reporting.

- **THE BLOCKS-USED TABLE IS ITS OWN GRAIN (2026-09-15, round 3 — migration
  `20260915073755_ops_ledger_campaign_blocks_and_shift_grades`).** Renzo asked for the FED PRICE
  and ACTUAL FED PRICE modals to become his workbook's BLOCKS USED table per campaign. The
  payload already had a blocks-used shape — `view_ops_ledger_day_blocks_used` — and it could not
  answer the question, because it is keyed on the **DAY**: the only fed weight it carries for a
  campaign is `total_fed_kg`, the block's **ALL-TIME** MAIN outflow. **78 of 523 blocks were fed
  by more than one campaign (up to 5 each; 5 of Q3 2026's 46)**, so printing that in a campaign's
  modal credits this campaign with kilos another one ate. `view_ops_ledger_campaign_block`
  publishes the `(campaign × block)` grain — **`campaign_fed_kg` is FED WT KG** — and carries
  `total_fed_kg` beside it, both labelled. That grain is not new arithmetic: it is exactly the
  `campaign_block` CTE `view_rc_movement_campaign_actual_price` already aggregates internally and
  then discards, so **Σ `campaign_fed_kg` over a campaign IS its `fed_kg`** (JULY 2026:
  **781,234.00 kg over 19 blocks**, the KPI row's own two figures) and the row count IS
  `blocks_fed` — both proven every run, 0 on all 32 campaigns.
- **`in_price_set` IS LIFTED, NOT INVENTED.** `is_closed AND is_fully_priced` is precisely the
  predicate `view_rc_movement_campaign_actual_price` filters its price set on, so the rows the
  modal marks as counting toward ACTUAL FED PRICE are exactly the ones `blocks_in_price` counts,
  with no second rule existing anywhere. Q3 2026: **43 of 46** blocks in the price set.
- **THE GROUP TABLE DE-DUPLICATES, AND ITS ROW COUNT IS `blocks_fed_distinct`.**
  `fn_ops_ledger_group_blocks` publishes ONE row per block with `campaign_count` +
  `campaign_keys`. What it deliberately does NOT do is weight or sum anything ACROSS a shared
  block: each row still carries that block's own campaign-independent all-time ₱/kg and
  shrinkage, which are correct at any grain — adding a shared pile's whole-life resiko once per
  campaign that touched it is exactly the mistake point 6 refuses. `group_feed_days` counts
  DISTINCT DATES rather than summing `campaign_feed_days`, because a changeover date belongs to
  two campaigns.
- **THE DAY EXPAND'S CHILD ROWS NEEDED TWO COLUMNS, SO THEY WERE ADDED TO THE VIEW.** A per-SHIFT
  child row printing the parent's own columns needs the shift's own WASTE % and GRADE SPLIT.
  **`view_ops_ledger_shift.waste_pct`** divides by PRODUCED kg — *the same denominator as
  `view_ops_ledger_day.waste_pct` and `view_ops_ledger_campaign_kpis.waste_loss_pct`*, so it is
  ONE definition at THREE grains — and **`grade_kg`** is a jsonb `{grade: kg}` map summed in SQL
  over the shift's own runs (several runs may carry one grade). Folding either in TSX would put
  arithmetic back on a render path and would let a child row disagree with the day row above it.
  **`grade_kg` is NULL, never `{}`, when the shift filed no run** — an empty object would claim
  the shift ran and produced nothing of any grade, while a missing KEY inside a populated map
  means that grade did not run; the adapter reshapes the NULL to `{}` for the component, which is
  the only place that distinction is not needed. *Measured on JULY 2026: 28 shifts, 27 with a
  grade split, 23 with a waste ratio; `Σ grade_kg` equals `produced_kg` on every non-null row and
  `waste_pct` equals `total_waste_kg / produced_kg` on all 28.*
- **THE POSTURE PROBE NOW PUBLISHES A SET, NOT A COUNT — and it caught its own migration's
  COMMENT on the first run.** `view_ops_ledger_campaign_block` carries ₱ on purpose, so "zero
  money-named columns" is not an available assertion. `campaign_block_money_named_columns`
  returns the **exact set** of names the money-ish regex matches, and the measured answer is
  **EIGHT**: the four real ₱ columns (`actual_fed_php_kg`, `delivered_php_kg`,
  `priced_delivered_php_kg`, `uplift_php_kg`) plus four coverage FLAGS that merely carry the word
  *price* / *unpriced* (`in_price_set`, `is_fully_priced`, `has_unpriced_delivery`,
  `unpriced_delivery_count`). The migration's own COMMENT had said "four of the five"; the
  set-valued assertion failed on it immediately and it was corrected by
  `20260915074246_ops_ledger_posture_comment_money_named_count` — a COMMENT-only migration, no
  view, no body, no grant. **A count nobody re-derives is how a wrong number survives; a set is
  re-derived every run.**

### PRICE GATING (server-side, structural)

**The ONE ₱ column on the day spine is `fed_php_kg`.** The KPI view carries seven:
`fed_php_kg`, `fed_value_php`, `actual_fed_php_kg`, `campaign_weighted_actual_fed_php_kg`,
`uplift_php_kg`, `php_per_produced_kg_delivered`, `php_per_produced_kg_true`. The group RPC
carries the same seven plus `php_per_produced_kg_true_covered`.

**The blocks-used table adds FOUR more, on two shapes** (2026-09-15):
`delivered_php_kg`, `priced_delivered_php_kg`, `actual_fed_php_kg`, `uplift_php_kg` on
`view_ops_ledger_campaign_block` **and** on `fn_ops_ledger_group_blocks`. Every other column on
both — including `campaign_fed_kg`, the resiko/balance split and `resiko_pct` — is peso-free and
not derivable back into a price, so a Production reader still gets the whole block table minus
its four rate columns. `verify-ops-ledger.ts` asserts the strip **by SOURCE EXPRESSION**
(`showPrices ? num(b.delivered_php_kg) : null`) rather than by field name, because
`actualFedPhpKg` and `upliftPhpKg` also exist on the rollup and a name-only check would pass on
the rollup's line while the block mapper leaked.

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

`npx tsx scripts/verify-ops-ledger.ts` — **80 assertions** (21 static + 59 live); zero on every
`*_mismatch` is the passing state. Measured 2026-09-15, **all 32 campaigns, one RPC call each,
strictly sequential**: every fold (the two WASTE folds included) and both reuse comparisons 0
mismatches on 32/32, the one-campaign-group identity 0/32, `day_rows == span_days` on 32/32,
**688 ledger days / 149 rest days**, the Q3 yield / fed-rate / PC-cost / **waste kg** / **waste
pct** gaps exactly 0, anon and `service_role` refused by a real read, `legacy_verify_fn_count = 0`.
Since 2026-09-15 it also asserts **`day_ratio_mismatch = 0` and `kpi_waste_pct_mismatch = 0` on
all 32 campaigns** and `gap_waste_pct === 0` on Q3, plus two static checks that the day-ratio
migration re-ALTERs `security_invoker` on BOTH views it replaced and re-grants the group function
it DROPped. **Slowest single campaign 4,671 ms (NOVEMBER 2025) on a loaded instance, 69 s wall for
the whole sequential loop** — that wall-clock is round-trip-dominated (the same probes cost
280–581 ms server-side) and the script FAILS any call over **5,000 ms**, so the 2026-09-14 shape
cannot come back unnoticed. Full table in `.agents/plans/ops-ledger-plan.md` §2.6.

> **TWO ASSERTIONS WERE RE-STATED AS INVARIANTS ON 2026-09-15, and the reason generalises.**
> The Q3 group's day split and block counts were frozen at their 2026-09-14 values (77/63/14 days,
> 45 distinct vs 50 campaign-sum blocks). **SEPTEMBER 2026 IS STILL RUNNING**, so those numbers
> grow every day — they read 79/64/15 and 46/51 twenty-four hours later — and the script would
> have begun failing **on the calendar rather than on a regression**, which is the fastest way to
> teach a team to ignore a proof. What is asserted now is what cannot change: the split is
> exhaustive (`active + rest == ledger_days`), neither count may go backwards from the
> 2026-09-14 baseline, and **exactly 5 of Q3's blocks were fed by two campaigns** so the naive
> sum exceeds the distinct count by 5. The measured values are printed in the check's own label,
> so nothing is hidden — only un-frozen. The two static additions are the L-044 re-grant of the
> DROPped group function and the `CREATE OR REPLACE` / `security_invoker` scan above.

---

## Files

| File | Role |
|---|---|
| `page.tsx` | **Server Component.** Resolves `?campaigns=` / `?lens=`, reads the campaign options and the ledger, renders `OperationsView`. Owns nothing else — the ₱ gate lives in the adapter and the title in the navbar. |
| `operations-view.tsx` | `'use client'` — the CONTROLS. Writes the URL (`router.replace` inside a transition), owns the lens segmented control, the EOQ collapse, the `campaignsMissing` notice and the block detail drawer. |
| `ops-ledger-table.tsx` | The ledger itself — **ONE table in ONE scroll container**: the frozen left spine, the frozen header band + label row, the sticky group footer, the four lenses' columns and the per-day expansion row. (Replaced `ops-ledger-split.tsx`, deleted 2026-09-15.) |
| `ops-kpi-strip.tsx` | The `EOQ` tab — one row per campaign plus the GROUP row, **eleven columns**, **every cell a button that opens the math**, every unit pinned LEFT via the platform `UnitValue`. |
| `ops-kpi-modal.tsx` | That math: `KpiDetail` (the one-line formula, then either the inputs list or a `table`, the result, the caveats) rendered in a `Dialog`. |
| `ops-blocks-table.tsx` | **The BLOCKS USED table** the FED PRICE / ACTUAL FED PRICE / RESIKO COST / RESIKO LOSS modals render — two column sets (`fed` · `actual`) over one normalised row shape, plus `campaignBlockRows()` / `groupBlockRows()`. |
| ~~`ops-day-detail.tsx`~~ | **DELETED 2026-09-15 (round 3).** A day now expands into ordinary child rows, so the shift cards and the day-grain BLOCKS USED table had no caller left. |
| `ops-group-picker.tsx` | The GROUP builder — selection chips + a popover holding the full campaign list, a filter box and the derived quarter presets. |
| `ops-lens.ts` | The lens registry (`production` · `grades` · `losses` · `blocks`), `DEFAULT_LENS`, `parseLens`, and `quarterPresets()` — quarters DERIVED from the option list, never hardcoded. |
| `ops-color.ts` | The semantic palette — `TONE` (one entry per meaning) and `CAMPAIGN_ACCENTS`. Opaque `head` for frozen surfaces, translucent `cell` for scrolling ones. |
| `ops-format.ts` | `kg` · `tons` · `php` · `pctFromFraction` · **`pctNumFromFraction`** (the bare percent NUMBER, for a cell that states its unit on the left) · `pctFromPercent` · `hours` · `count` · `shortDate`. Renderers only. |

---

## Key Behaviors (UI)

**THE URL IS THE STATE.** `?campaigns=JULY-2026,AUGUST-2026,SEPTEMBER-2026` (comma-separated
campaign keys, upper-cased and de-duplicated on read, written back in the campaigns' own DATE
order) and `?lens=production|grades|losses|blocks` (**the default is `production` since
2026-09-15**, and the default is spelled as ABSENCE, so a plain address stays clean and the
param's presence always means something; `?lens=grades` and `?lens=losses` are unchanged). Both are written with
`router.replace` inside a `useTransition`, so the server page re-reads and the payload comes
back already folded — no client fetch and no second copy of the resolution logic. The outgoing
ledger stays mounted at `opacity-50` while the new one resolves (compositor-only, nothing
reflows). **Absent `?campaigns=` = the newest campaign**, resolved from the same
`view_rc_movement_campaign_options` list, same filter and same order as RC Movement's picker.

**EXPANDING A DAY INSERTS CHILD ROWS, NOT A PANEL (2026-09-15, round 3).** Renzo: *"An
identical row in the format of the parent row but ONLY showing the SHIFTS groups. So if
there's M, E, N in one day, then it should show 3 child rows just summing the totals PER shift
accordingly. There's no need for those sections above the table with the rc fed breakdown for
the day. Child rows should be self explanatory. Too wordy anyway. No reason for the fed table in
the dropdown to also be horizontally scrolled."* So the whole expansion PANEL is gone — the
shift cards, the RECORDED WASTE block, the day-grain BLOCKS USED table and the `sticky left-0`
band that carried them — and with them **`ops-day-detail.tsx` and the `blocksUsed` read**
(`view_ops_ledger_day_blocks_used` still exists in the database; nothing reads it, because the
block table a reader actually wants is the CAMPAIGN's, and a block's all-time fed total cannot
be attributed to one campaign). A day now opens into **one ordinary `<tr>` per shift, in the
same columns**, with the same frozen-column treatment and the same gridlines: no inner table, no
second set of widths, no second horizontal scroll.

**A SHIFT ROW LEAVES BLANK EVERYTHING A SHIFT DOES NOT OWN.** `rc_out` has no shift dimension —
feeding is recorded per DATE — so **FED PRICE, TTL FED, YIELD % and LOSS % are blank** on a child
row rather than repeated from the parent or split by an invented rule. What a shift genuinely
owns is published per shift and is printed: **TTL PROD** (`producedKg`), **WASTE**
(`totalWasteKg`), **WASTE %** (`wastePct` — the same PRODUCED-kg denominator at all three
grains), **DT HRS** (`downtimeHours`, whose `title` carries everything L-051/L-051b stored: the
reason, MC's own ranges, the ranges the plant ran THROUGH, and which rule set the shift length),
its **grade split** (`gradeKg`) under the grades lens and its **eight streams** under losses.
The DATE cell announces the row (`↳ Shift M`); the SHIFTS column stays blank, because a count of
one is not news. **A day with no shift is NOT EXPANDABLE** — it gets no chevron rather than an
empty disclosure (measured on the fixture: 8 chevrons for 8 days with shifts, none on the rest
day or on the day that was fed but filed no shift). Child rows are keyed
`campaignKey:date:shiftId`, for the same changeover-date reason the parent is keyed
`campaignKey:date`.

**THE EXPANDED DAY AND THE BLOCK DRAWER ARE DELIBERATELY NOT IN THE URL.** Both are
disclosures inside ONE reading of one payload — the category RC Movement also keeps in local
state — and putting either in the address would re-run the server on every chevron click to
change nothing the server computes.

**AN UNKNOWN CAMPAIGN KEY IS NOT AN ERROR.** The group RPC returns it in `campaignsMissing`
rather than dropping it; the view prints a muted notice naming the keys and renders the
campaigns that did resolve. A mistyped or retired key must never read as a silently smaller
quarter. When NOTHING resolves the page says so and points at the bare `/operations` URL.

**ONE TABLE, ONE SCROLLBAR (2026-09-15).** Renzo, reading the shipped page: *"there are two
vertical scroll bars. There's no point in having two if they are synced… no point in making
them two different tables when in reality they are just beside each other. Better if they
coexist."* The two scroll-synced panes are gone and with them **five mechanisms that only
existed to hold them together**: the scroll-sync handler, its ownership guard, the pixel
divider + its `ResizeObserver` clamp, the phone pane toggle, and the **fixed 320px expansion
band** (which existed solely so the two sides stayed row-aligned). The day spine is now a block
of **FROZEN COLUMNS** — `#expand · DATE · DAY · FED ₱/KG · TTL FED · TTL PROD · WASTE · WASTE % ·
YIELD % · LOSS % · SHIFTS · DT HRS`, **922px with ₱ / 820 without** — each `position: sticky` at
its own cumulative `left` offset, `.frozen-edge` on the last; the lens columns scroll past them
inside the same `<table>`. *Measured: exactly ONE element in the page has
`scrollHeight > clientHeight`.* The un-freeze breakpoint moved with the width, from 767px to
**1023px**: the rule was always "un-freeze while the spine is within ~10% of the frame", and at
800px a 900-odd-pixel spine would eat the whole viewport. (FED PRICE went 96 → **102px** in
round 3 so its label and its inline unit fit on the one header line — measured, it clipped by
2px at 96.)

**EVERY COLUMN HEADER IS ONE LINE, UNIT INCLUDED (2026-09-15, round 3).** Renzo: *"Can't those
sub headers in the columns (where the units are) be stored on the same line as the column title?
… For all views in general in this page."* So `kg` · `₱/kg` · `h` · `%` now sit on the label's
own baseline in muted small type, and a block column carries its `block_loc` inline with the
batch code the same way. **The label header row went 40px → 26px**, which is two more ledger
rows on screen; the modal tables are built the same way from the start. Measured after the
change: not one header in the spine or either lens clips.

**A ROW'S IDENTITY IS `campaignKey:date`, NEVER THE DATE ALONE.** A **changeover date belongs to
two campaigns** — 2026-08-01 is JULY's last day and AUGUST's first, 2026-08-29 is AUGUST's last
and SEPTEMBER's first — so keying day rows by `date` handed React duplicate keys and it
reconciled one of them into the wrong band: **a stray 2026-08-29 row rendered above the JULY
band on production.** Both the row key and the expanded-day identity are now the composite
string, and `buildRows` groups days by campaign in the campaigns' own chronological order rather
than trusting row order, so a band always precedes its own days. *Verified on a three-campaign
fixture carrying both changeover dates: each appears ONCE PER CAMPAIGN inside its own band, in
order, with zero React key warnings.*

**VISIBLE CELL BORDERS — and `border-separate`, not `border-collapse`.** Every `th`/`td` carries
`border-b` / `border-r border-border`, spreadsheet style, in both themes. The table sets
`border-collapse: separate; border-spacing: 0` because that is **mandatory, not a preference**:
under `border-collapse` the browser renders sticky cell BACKGROUNDS transparent and the
scrolling cells bleed straight through the frozen spine (the RC Movement matrix carries the same
note). So the gridlines are reconstructed per cell instead of merged by the collapsed model.

**THE FOUR LENSES.** `production` (**the default** — GRADES *and* the eight waste streams side by
side under two group headers; the same column builders the other two lenses use, so the three
can never disagree), `grades` (one column per grade — read from `OpsLedgerData.grades`, **never
a hardcoded list**), `losses` (the eight `WASTE_STREAMS` in the sheet's order), `blocks` (one
column per block fed — **this lens IS the RC Movement matrix**). A block column header carries
no sort/filter chrome; it IS the affordance and **opens that block's `BlockingDetailPanel`**,
through the same `fetchBlockDataForBatch` + optimistic-open contract RC Movement and the
digest's Open Blocks band use. Batch codes in the BLOCKS USED expand open the same drawer.
"Edit All" from the drawer pushes `/inventory?tab=…` explicitly, because there is no inventory
tab provider on this route.

**THE LENS FOOTERS NOW PRINT REAL WASTE TOTALS.** `rollups[].waste` / `group.waste` shipped with
the data layer on 2026-09-15, so the Losses and Production footers print published per-campaign
and per-group stream totals where they used to print *"no total is published"*. Whether a total
EXISTS is a separate flag (`hasCampaignTotal` / `hasGroupTotal`) from its value, because `null`
is a legitimate total (a campaign whose shifts filed no waste row) and collapsing "not
published" into "published as null" is how a footer starts lying. Grades have a per-CAMPAIGN
total only, so with several campaigns the group footer says *which grain* is missing rather than
claiming neither exists. **THE BLOCKS LENS GOT ITS FOOTERS IN ROUND 3**: each column prints
that block's `campaignFedKg` per campaign and its `groupFedKg` in the sticky group footer — both
published per (campaign|group × block) in SQL, both proven to sum to the rollup's own `fedKg` —
so the *"no total is published for this lens"* note now survives only for an EMPTY lens's
placeholder column. It is a LOOKUP, never a fold of the cells above it.

**THE CAMPAIGN CELL IS THE NAME, AND NOTHING ELSE (2026-09-15, round 3).** The
`2026-06-30 → 2026-08-01` line under each campaign name is gone — Renzo: *"kind of needless"*,
and it is: the ledger directly underneath states every date of every campaign, and the band row
repeats the span. The **GROUP row keeps one line (`3 campaigns`)**, because how many campaigns
are in the group is what that row IS and nothing else on screen says it. The label column went
170 → 150px.

**FOUR MODALS ARE NOW A TABLE, AND NO MODAL OPENS WITH A PARAGRAPH.** Renzo: *"It should take
out the how it is defined entirely… those two KPI pop ups should portray the data in table form
so the user can distinguish and get a quick look and a breakdown of why the price is the way it
is and what the actual price is and why."* So the `HOW IT IS DEFINED` prose block is deleted
from **every** modal (title → one-line formula → inputs → result → the caveats that explain a
NULL), and **FED PRICE · ACTUAL FED PRICE · RESIKO COST · RESIKO LOSS** render
`ops-blocks-table.tsx` in place of the inputs list, in a `sm:max-w-4xl` dialog:

| Modal | Columns |
|---|---|
| Fed Price | `BATCH · BLOCK LOC · DATE OPEN · DATE CLOSE · STATE · FED WT kg · BLOCK PRICE ₱/kg` |
| Actual Fed Price · Resiko Cost · Resiko Loss | the same, plus `ARRV WT kg · RESIKO kg · RESIKO LOSS % · ACTUAL PRICE ₱/kg · RESIKO PRICE ₱/kg` |

**FED WT is the campaign's own `campaignFedKg`, never the block's all-time total** — 78 of 523
blocks were fed by more than one campaign, so an all-time figure would credit this campaign with
kilos another one ate; the GROUP table uses `groupFedKg` over one row per DISTINCT block.
**RESIKO is null on an open block and the BALANCE is shown instead, muted** (`title` *"still in
the pile"*), and **RESIKO LOSS prints only once the block is closed** — it reads `resikoPct`,
the published closed-only twin, gated on `isClosed` as well so the two cells can never disagree.
**A row outside the price set is tinted and says why on hover** (`still open` · `an unpriced
delivery` · `a sun-drying outflow`); `inPriceSet` is the view's own predicate, read, never
re-derived. Above the rows is a counts line built from PUBLISHED counts only
(`4 blocks · 3 closed · 1 open · 1 fully priced · 1 closed but unpriced · 123,500 kg fed inside
the price set (15.8%)`) and under them a sticky footer of the rollup's own totals — the table
never counts its own rows and never sums its own cells. Its header and footer are sticky and
therefore **solid `bg-muted`, never the dialog's glass**.

**THE EOQ ROLLUP — ELEVEN COLUMNS AND A MODAL PER CELL.** `RC Fed · Produced · Yield · Loss ·
Waste Loss (kg + %) · Fed Price · Actual Fed Price · Resiko Cost · Resiko Loss · PC Cost ·
True PC Cost`. Renzo: *"too wordy"* — so the nine sub-captions (*"24 feed days"*, *"100.0%
priced"*, *"whole-block 48.26"*, *"delivered basis"*, *"carries the shrinkage"*) are **gone from
the cells and moved into the math**: every cell is a `<button aria-haspopup="dialog">` that
opens `OpsKpiModal` with the definition in words AND symbols, each input beside its published
value, the result, and the coverage. `a ÷ b = c` in a modal is **three separate published fields
printed side by side, never a division** — there is no arithmetic on any value path in the strip
or its builders. A ₱/kg result that is null prints a bare em-dash, never `₱—/kg`.

**THE RESIKO PAIR IS TWO COLUMNS OF ITS OWN (2026-09-15, round 2).** Renzo: *"the KPI is wide
enough to separate resiko cost and resiko loss as their own separate columns. This would make
the KPI thinner and give more vertical space for the breakdown table."* ACTUAL FED PRICE used to
stack three figures in one 138px cell, which set the height of EVERY row in the strip at three
lines; split out, **`upliftPhpKg` (RESIKO COST) and `blockResikoLossPct` (RESIKO LOSS) each get
a full cell, a header and their own modal**, and the strip costs the ledger one line instead of
three. *Measured: rows 34px (was ~60), whole strip 159px for three campaigns + the GROUP row.*

**RESIKO LOSS IS THE ONE OF THE THREE THAT SURVIVES THE PRICE GATE.** `blockResikoLossPct` is a
WEIGHT ratio — no ₱ in it, none derivable, and the adapter does not null it — so it is not
`price`-flagged and **Production keeps it** even though it may not see what the shrinkage cost.
It is drawn in the amber LOSS hue rather than the violet MONEY one, which says the same thing in
colour. *Verified against a price-denied payload: the strip renders `Campaign · RC Fed ·
Produced · Yield · Loss · Waste Loss · Resiko Loss` — five ₱ columns dropped, this one kept, no
₱ glyph anywhere in either table.*

**THE UNIT IS PINNED LEFT IN EVERY STRIP CELL.** Each cell renders through the platform
`UnitValue` (`components/shared/unit-value.tsx` — moved out of `/analytics` in this change, with
a one-line re-export left behind so none of its six analytics call sites moved): the glyph
`t` · `%` · `kg` · `₱/kg` in muted 11px on the left, the `tabular-nums` figure hard against the
right. That is CLAUDE.md's Currency (Accounting format) rule generalised — Renzo's 2026-09-02
analytics decision, applied here — and it is why the column headers **no longer carry a unit
sub-label**: the cell says it on every row at a fixed x. **An ABSENT figure drops the glyph with
the number**; a lone `%` or `₱/kg` beside an em-dash claims a unit for a figure that does not
exist.

**COLOUR IS SEMANTIC, AND IT LIVES ON THREE SURFACES.** `ops-color.ts` owns one hue per meaning
— **sky** FED/input · **emerald** PRODUCED/yield · **amber** DRIFT/loss · **rose** WASTE ·
**violet** MONEY (₱) · **zinc** the spine's own chrome — applied to (1) the column-group header
bands (a tinted opaque background plus a 2px coloured top border), (2) the KPI values in the EOQ
strip and the headline numbers in the spine, and (3) a light translucent tint on the scrolling
lens columns. The lens tabs carry the same hue as their columns. **Numbers stay `font-mono`,
right-aligned, and the eight waste value columns stay on the neutral token** — colour says what
KIND of number this is, never how big it is, and a losses lens must not be a wall of red.
Campaign bands get a rotating accent drawn from hues the semantic palette does NOT use
(indigo/teal/fuchsia/orange), because it identifies a band and means nothing about its numbers.

**NO ARITHMETIC ANYWHERE IN THE COMPONENTS.** No `reduce`, no `+`, no ratio on any render path
— the only sums left are column-width bookkeeping, which is layout. Day figures come from
`OpsLedgerDay`, campaign footers from `OpsCampaignRollup`, the sticky group footer from
`OpsGroupRollup`, grade campaign totals from `gradesByCampaign`. **Where a total does not exist
in the payload the footer SAYS SO** — the waste streams and the per-block columns have no
campaign or group total, so that footer prints one sentence instead of a fabricated number.

**THE DRIFT COLUMN IS GONE; FOUR RATIOS TOOK ITS PLACE (2026-09-15, round 2).**
`dayDriftKg` is **no longer rendered anywhere on this screen**. It was a kilogram figure whose
whole header tooltip existed to say *"this is not what it looks like"*, and the four numbers a
reader actually wants beside a day now say it better: **WASTE** (`totalWasteKg`, the eight
streams, rose band) · **WASTE %** (`wastePct`, rose) · **YIELD %** (`yieldPct`, amber) ·
**LOSS %** (`lossPct`, amber), under two group bands `WASTE` and `OUTPUT RATIOS`. All four are
published per day by `view_ops_ledger_day` and none is computed here.

**THE DAY YIELD AND LOSS ARE LABELLED INDICATIVE, WHICH IS THE CAVEAT DRIFT USED TO CARRY.**
Both column headers carry the `title` *"Day-level, indicative — the feed tank is continuous
flow; the campaign figure is the real one."* WASTE and WASTE % carry no such caveat — a day's
swept-up waste and a day's production DO describe the same shift. The CAMPAIGN and GROUP footers
under the four print the published rollup figures (`wasteKg` · `wasteLossPct` · `yieldPct` ·
`processLossPct`), never a sum of the cells above them, and each says which grain it is in its
own `title` (`RATIO_FOOTER_TITLE`, keyed by column so it cannot land on the wrong one). The
day-expand's waste note was rewritten the same way: it no longer quotes a drift figure, it
points at WASTE % and says the day's yield and loss are indicative.

**PRICE GATING IS ABSENCE, NOT A BLANK — IN THE MODAL TABLES TOO.** The blocks table drops
`BLOCK PRICE` / `ACTUAL PRICE` / `RESIKO PRICE` for a viewer without price rights, which is what
makes the RESIKO LOSS modal (not a ₱ column, so Production keeps it) safe to open at every role.
*Verified on a price-denied payload: the RESIKO LOSS modal renders nine columns and the document
contains no `₱` glyph at all — including in the prose, which deliberately writes "NO PESO VALUE"
so the assertion stays meaningful.* `canViewPrices` drops `FED ₱/KG` from the spine's
coordinate space (the `left`-offset arithmetic reads the flag) and the **five** ₱ columns from
the EOQ strip — `Fed Price · Actual Fed Price · Resiko Cost · PC Cost · True PC Cost`, and their
five modals with them. **RESIKO LOSS is deliberately not one of them** (see above). The server
already nulled the fields; this is the render guard. *Verified against a price-denied payload:
the spine drops FED PRICE and its whole PRICE band, the strip renders `Campaign · RC Fed ·
Produced · Yield · Loss · Waste Loss · Resiko Loss`, and neither table contains a ₱ glyph
anywhere.*

**TRUE PC COST IS NEVER FILLED IN.** Null unless every block is closed and priced; the cell
prints a bare `—` and **its modal says why** (`17 of 20 closed · 16 priced`), and for the GROUP
prints the always-computed `phpPerProducedKgTrueCovered` as the honest partial, labelled. The
GROUP's RESIKO LOSS modal likewise states that no group resiko KG is published and why — a block
can be fed by several campaigns (78 of 523), so summing per-campaign resiko weights would charge
one pile's shrinkage once per campaign that touched it.

**EXCEL STANDARD / NEVER CRUSH.** `table-fixed` with explicit pixel widths everywhere,
`px-2 py-1`, `text-xs`, 32px rows, `font-mono tabular-nums` right-aligned numerics, ₱ in
accounting format (symbol pinned left). Every table declares `min-width = Σ of its column
widths` inside an `overflow-x-auto` (or the pane's own `overflow-auto`) wrapper. Each pane's
table ends in an **empty auto-width SPACER column** so leftover pane width is absorbed there
instead of being distributed across the data columns — the one case the "never let a `w-auto`
column absorb the slack" rule does not bite, because the spacer carries no content and the
`minWidth` still forces a scrollbar when the pane is too narrow. *Measured at 375px: document
`scrollWidth === innerWidth`.*

**FROZEN SURFACES ARE OPAQUE.** Two sticky header rows (the group band at `top: 0`, the label
row at `top: 22`), the sticky group footer and every frozen spine cell carry a SOLID token —
`bg-muted`, `bg-background`, `bg-accent`, or a solid palette step from `ops-color.ts`. The hover
repaint on a frozen cell is solid too (`group-hover:bg-accent`), because a translucent hover
REPLACES the opaque base and reopens the bleed-through. The translucent `TONE[...].cell` tints
go only on NON-frozen lens cells. The last frozen column carries `.frozen-edge`, and its footer
cell carries `.frozen-edge-corner` — one `box-shadow` property, so the two seams are composed
rather than stacked. Pinning classes go on the CELLS, never on the `<tr>`.

**MOTION.** No row animates and nothing is staggered — the expansion band's `animate-fade-in`
went with the band, because child rows are rows and rows do not animate. The only animation left
is `animate-fade-up` on the empty state and the dialog's own entrance; the campaign switch is an opacity transition on a mounted sheet. The KPI modal is
a `Dialog`, which already ships the project's canonical glass
(`bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80`).

**PHONE / SMALL LAPTOP (< 1024px): THE SPINE UN-FREEZES.** 916px of frozen columns on a 375px
(or an 800px) screen would leave no room at all for the lens, so below 1024px the spine simply
scrolls with everything else
— one table, one horizontal scroll, **nothing hidden and no second layout to maintain**. The
header stays pinned at every width. `narrow` starts `false` on server AND client and is set in
an effect, so the first client render matches the server's. *Measured at 375px: document
`scrollWidth === innerWidth === 375`, one vertical scroller, spine cells `position: static`.*

**ERRORS.** The block drawer is opened optimistically and a failed fetch keeps it open with the
panel's own persistent, copyable inline banner plus Retry (the project HARD RULE on error
surfaces) — never a silently empty drawer. The `campaignsMissing` notice is deliberately NOT an
error: nothing failed.

---

## Dependencies

**Data layer:** `lib/supabase/server`, `lib/auth` (`canViewPrices`), `lib/supabase/paginate`
(`fetchAllRows`), `types/supabase`. Reads only `view_ops_ledger_*` and
`view_rc_movement_campaign_options`.

**UI:** `lib/operations/{types,queries}`, `lib/utils` (`cn`),
**`components/shared/unit-value`** (the platform unit-on-the-left cell, shared with
`/analytics`), `components/ui/{popover,input}`,
`lucide-react`, and two files from the inventory module —
`app/(app)/inventory/_shared/blocking-detail-panel` (the shell-agnostic drawer, already shared
by Blocking, RC Movement, the inventory tab shell and the digest's Open Blocks band) and
`app/(app)/inventory/blocking/actions#fetchBlockDataForBatch` + its `BlockData` type. Both are
TENANT code, as this module is. **Nothing is imported from `app/dev/**`**, and the drafts there
are untouched. The KPI modal uses `components/ui/dialog`. The Blackwood Table is deliberately
NOT used — this is a read-only ledger with no inline editing, so the grid's whole value
proposition is unused; see the header comment in `ops-ledger-table.tsx`.

**Registered in the navbar:** `getBreadcrumb()` (`Operations` · *Plant operations ledger — day
rows on the campaign clock, with the EOQ rollup*) and `ICTC_MODULES`, next to Analytics.

## See also

- `.agents/plans/ops-ledger-plan.md` — §1 brief, §2 data layer, §3 UI
- `app/dev/ops-ledger/CONTEXT.md` — the three layout drafts and the unification thesis
- `app/(app)/inventory/rc-movement/CONTEXT.md` — the matrix this ledger shares a spine with
- `app/(app)/production/daily/CONTEXT.md` — the shifts/runs/downtime/waste source (L-051/L-051b)
- `CLAUDE.md` → "Views", "Price gating", "Database Rules", "Frozen Panes", "Excel Standard"
