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
| `lib/operations/types.ts` | **THE PORT** — `OpsLedgerData`, `OpsLedgerDay`, `OpsShift`, `OpsDayBlockFeed` (**+ its seven-stat lab profile, 2026-09-16**), **`OpsFedBlend`** (**the day's projected blend, 2026-09-16**), `OpsDayBlockUsed`, **`OpsCampaignBlock`**, **`OpsGroupBlock`**, `OpsCampaignRollup`, `OpsGroupRollup`, `OpsCampaignGrade`, `OpsCampaignOption`, plus `WASTE_STREAMS` and `GRADE_DISPLAY_ORDER`. `OpsCampaign.blocks` and `OpsGroupRollup.blocks` carry the blocks-used table. Supersedes the draft port at `app/dev/ops-ledger/_mock/types.ts`; every divergence is annotated in place. |
| `lib/operations/queries.ts` | **THE ADAPTER** (server-only). `fetchOpsLedger(campaignKeys)` → one `OpsLedgerData`; `fetchOpsLedgerCampaignOptions()` → the picker. |

### The SQL objects (migration `20260914033037_ops_ledger`, + `20260915021820_ops_ledger_campaign_waste`, + `20260916030358_ops_ledger_day_fed_blend_quarters_arrival`)

All **ten** views are `security_invoker`, `authenticated` SELECT only, `anon` REVOKEd, and
**deliberately NOT granted to `service_role`** — the sync worker reads none of them, so
`verify-worker-view-grants` stays at 4 views / 0 findings (L-044: a consumer is not a
dependency). Each view's plain-language definition lives in its DB `COMMENT`.

| View | Grain | Key columns | Rows |
|---|---|---|---|
| `view_ops_ledger_campaign_span` | campaign | `campaign_key`, `campaign_label`, `first_date`, `last_date`, `span_days`, `first_fed_date`, `feed_days`, `shift_count`, **`midpoint_date`, `quarter_year`, `quarter_no`, `quarter_key`, `quarter_label` (2026-09-16)** | 32 |
| **`view_ops_ledger_day`** | campaign × calendar day | `calendar_date`, `weekday`, `is_weekend`, `is_rest_day`, `fed_kg`, `sundry_kg`, **`fed_php_kg` (₱)**, `produced_kg`, `day_drift_kg`, `blocks_fed_count`, `shift_count`, `shift_hrs_total`, `downtime_hours`, `downtime_incident_count`, `downtime_shift_count`/`_with_duration`/`_reason_only`, `run_count`, `sacks`, the eight waste columns, `total_waste_kg`, `production_reported`, **`waste_pct` / `yield_pct` / `loss_pct` (2026-09-15, FRACTIONS)** | **688** (≈31/campaign, max 33) |
| `view_ops_ledger_day_grade` | campaign × day × grade | `grade`, `kg`, `sacks`, `run_count` | 317 (max 48/campaign) |
| `view_ops_ledger_day_block` | campaign × day × block | `batch_id`, `batch_code`, `block_loc`, `fed_kg`, `sundry_kg`, **+ the block's seven-stat LAB PROFILE `mc`/`ash`/`bd_astm`/`bd_jis`/`grit`/`vm`/`fc` (2026-09-16)** | 2,148 (max **114**/campaign) |
| **`view_ops_ledger_day_fed_blend`** | campaign × day that FED | `fed_kg`, `blocks_fed_count`, the seven FED-KG-WEIGHTED means `w_mc`…`w_fc` and their coverage `mc_kg`…`fc_kg` | **~700** (24/campaign for JULY 2026) |
| `view_ops_ledger_day_blocks_used` | campaign × day × block | `first_fed_date` (date open), `close_date`, `is_closed`, `status`, `day_fed_kg`, `total_fed_kg`, `total_out_kg`, `delivered_kg`, `weight_lost_kg`, `loss_pct`, **`resiko_kg`/`resiko_pct`** (closed only), **`balance_kg`** (open only), `has_sundry_outflow`, `has_unpriced_delivery` | 2,148 |
| `view_ops_ledger_shift` | shift | `shift` (`M`/`E`), `shift_hrs`, `shift_hrs_source`, `dt_hrs`, `dt_mins`, `downtime_hours`, `productive_hrs`, `dt_reason`, `dt_ranges`, `dt_incident_ranges`, `has_incident`, `produced_kg`, `run_count`, `sacks`, the eight waste columns, `waste_remarks`, **`runs` (jsonb array)**, **`waste_pct` / `grade_kg` (2026-09-15)** | 260 |
| **`view_ops_ledger_campaign_block`** | campaign × block | `batch_code`, `block_loc`, **`campaign_fed_kg`**, `campaign_sundry_kg`, `campaign_feed_days`, `first_fed_date` (date open), `close_date`, `is_closed`, `status`, `total_fed_kg`, `total_out_kg`, `delivered_kg`, `weight_lost_kg`, `loss_pct`, `resiko_kg`/`resiko_pct`/`balance_kg`, `is_fully_priced`, **`in_price_set`**, and **four ₱** (`delivered_php_kg`, `priced_delivered_php_kg`, `actual_fed_php_kg`, `uplift_php_kg`) | **523** (19/campaign for JULY 2026) |
| `view_ops_ledger_campaign_grades` | campaign × grade | `grade`, `kg`, `share_pct` (0–100), `campaign_produced_kg` | 21 |
| **`view_ops_ledger_campaign_kpis`** | campaign | the EOQ row — see below; **+ the eight waste streams, `waste_kg`, `waste_shift_count`, `waste_loss_pct` (2026-09-15; its denominator became PRODUCED kg the same day)**; **+ the BLOCKS-TABLE FOOTER `blocks_delivered_kg`, `blocks_closed_delivered_kg`, `blocks_total_fed_kg`, `blocks_resiko_kg`, `blocks_closed_resiko_loss_pct` (2026-09-16)** | 32 |

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
| **`view_ops_ledger_day_fed_blend`** (filtered) | **16** | **24** |
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

- **THE DAY'S PROJECTED FED BLEND, AND THE BLOCK'S LAB PROFILE (2026-09-16, round 5 — migration
  `20260916030358_ops_ledger_day_fed_blend_quarters_arrival`).** Renzo: clicking a day's FED cell
  opens the blocks fed that day *with the projected lab profile of what was fed* — "the projected
  MC, BD, Ash etc. of the final product, since these are heavily based on what was fed. **Not to
  be taken as truth but a good figure to have.**" So `view_ops_ledger_day_block` gained the
  block's seven-stat panel and NEW **`view_ops_ledger_day_fed_blend`** publishes the
  **FED-KG-WEIGHTED** mean of each stat over the blocks fed that day.
- **THE LAB PROFILE IS NOT `batches.quality_stats`, AND THE DATA SETTLES IT.** The ask named
  `quality_stats` *and* named "the same numbers the Blocking page shows", and those are two
  different things. Measured: **`quality_stats` carries exactly THREE keys — `mc`, `ash`, `bd` —
  across all 725 batches, and `bd` is 0.0 on 724 of the 725.** Five of the seven stats do not
  exist in it. The Blocking page's lab columns come from `view_blocking_grid`, whose `avg_*` are
  DELIVERY-WEIGHTED means over `deliveries.lab_results` — and that arithmetic is what the new
  `lab` CTE reproduces, expression for expression. **PROVEN byte-identical to the grid
  (COALESCEd) on ALL 168 of its rows and all seven stats, 0 mismatches.**
- **THE GRID ITSELF CANNOT BE THE SOURCE, which is the measurement that decided the shape.** It
  shows only OPEN blocks with a `location_ref`, and **522 of the 525 blocks a campaign has ever
  fed have no row in it** — reading it would leave 605 of 608 campaign-block rows blank. Same
  reason `view_analytics_aging_watchlist` reads `batches.avg_cost` rather than the block view.
  **`view_blocking_block_suppliers` is derived from the grid and has the identical hole**, so no
  supplier column was added — a column blank on every closed block is worse than absent.
- **THE ONE DELIBERATE DIVERGENCE FROM THE GRID: NULL, NEVER 0.** The grid COALESCEs a missing
  stat to 0 (a measured no-op on its own population — not one of its 168 rows has a NULL stat).
  Here, **53 of the 525 fed blocks carry no lab reading at all**, and a published 0.0 would read
  as "0 % moisture" rather than "not measured" — the L-008 placeholder mistake in a new costume,
  on the one surface where a fabricated zero does the most damage. All seven stats have
  **identical coverage (472 of 525)**: a delivery carries the whole panel or none of it.
- **THE BLEND SELECTS FROM `view_ops_ledger_day_block`, THE VIEW ITS ROWS ARE LISTED FROM** — the
  P3 trick. The blended head and the block list beneath it come from the SAME relation, so a
  block can never appear in one and not the other and the weights can never be taken from a
  different population than the stats. **THE WEIGHT IS FED KG, NOT PILE BALANCE**:
  `fn_blend_proposal` weights by `view_blocking_grid.balance` because it answers what a pile
  *would* blend to and cannot see a closed block at all, so it is deliberately NOT called — the
  statistic keeps its `SUM(stat×weight)/SUM(weight)` shape and its `w_` prefix so a reader
  recognises it. **Each stat is weighted over ONLY the blocks that carry it**, with the fed kilos
  that did carry it beside it as `<stat>_kg`, so the UI prints *"projected from 41,200 of 47,000
  kg"* rather than implying the whole day was measured; NULL, never 0, when no fed block that day
  carries the stat. ⚠ **`grit_kg` on the blend view is COVERAGE** (fed kilos carrying a grit
  READING) and is unrelated to `grit_kg` on the day / campaign views, which is the GRITS WASTE
  STREAM — the two are never joined. **PROVEN: Σ `fed_kg` per campaign IS the KPI row's `fed_kg`
  (JULY 2026: 781,234.00) and the row count IS the ledger days with `fed_kg > 0` (24)**, both on
  every verify run. Sample — 2026-07-02, 30,992 kg over 5 blocks: MC 10.4229 · ASH 3.5369 ·
  BD ASTM 0.5761 · BD JIS 0.5961 · GRIT 2.9117 · VM 12.7999 · FC 83.6631, every one at 100 %
  coverage. **NO ₱ column and none derivable — the whole sidebar is safe for Production.**
- **THE QUARTER IS DECIDED BY DATE, NEVER BY THE BATCH NAME (2026-09-16).** A campaign belongs to
  the quarter containing the **MIDPOINT of its span**, `first_date + (last_date − first_date)/2`,
  published as `midpoint_date` / `quarter_year` / `quarter_no` / `quarter_key` (`2026-Q3`) /
  `quarter_label` (`Q3 2026`). Not the NAME — a `production_batch` is a name a person typed
  (L-039 / L-042 / L-048 one level up) and `TEST BATCH` has no month in it. Not `first_date` or
  `last_date` either, because a campaign straddles the boundary at BOTH ends: **JULY 2026 opens
  2026-06-30 (Q2 by its first day) and closes 2026-08-01 (Q3 by its last)**, and SEPTEMBER 2026
  opens 2026-08-29. The midpoint is the only one of the three that answers both the same way.
  **AN INCOMPLETE QUARTER IS STILL A QUARTER** — the old rule required all three months, so the
  CURRENT quarter never appeared until its third campaign opened, which is the one quarter an
  owner most wants. `app/(app)/operations/ops-lens.ts::quarterPresets()` now does **no date
  arithmetic at all**: it groups on the `quarter_key` the database decided, so the picker and the
  database cannot disagree. Measured on all 32 campaigns — every midpoint quarter agrees with the
  quarter its month-name implies, including OCTOBER 2024 (opens 2024-09-30 → `2024-Q4`), so
  nothing visible moved on today's data:

  | campaign | first → last | midpoint | quarter |
  |---|---|---|---|
  | JANUARY-2024 · FEBRUARY-2024 · MARCH-2024 | 2024-01-01 · 02-01 · 03-01 (1-day) | same | `2024-Q1` |
  | APRIL-2024 · MAY-2024 · JUNE-2024 | 2024-04-01 · 05-01 · 06-01 (1-day) | same | `2024-Q2` |
  | JULY-2024 | 2024-07-12 → 07-30 | 2024-07-21 | `2024-Q3` |
  | AUGUST-2024 | 2024-08-31 (1-day) | 2024-08-31 | `2024-Q3` |
  | SEPTEMBER-2024 | 2024-09-10 → 09-28 | 2024-09-19 | `2024-Q3` |
  | **OCTOBER-2024** | **2024-09-30** → 10-30 | 2024-10-15 | **`2024-Q4`** |
  | NOVEMBER-2024 | 2024-11-04 → 11-15 | 2024-11-09 | `2024-Q4` |
  | JANUARY-2025 | 2025-01-02 → 01-30 | 2025-01-16 | `2025-Q1` |
  | FEBRUARY-2025 | 2025-01-31 → 02-28 | 2025-02-14 | `2025-Q1` |
  | MARCH-2025 | 2025-02-28 → 03-29 | 2025-03-14 | `2025-Q1` |
  | APRIL-2025 | 2025-04-01 → 04-30 | 2025-04-15 | `2025-Q2` |
  | MAY-2025 | 2025-04-30 → 05-30 | 2025-05-15 | `2025-Q2` |
  | JUNE-2025 | 2025-05-31 → 06-27 | 2025-06-13 | `2025-Q2` |
  | JULY-2025 | 2025-06-28 → 07-30 | 2025-07-14 | `2025-Q3` |
  | AUGUST-2025 | 2025-07-31 → 08-29 | 2025-08-14 | `2025-Q3` |
  | SEPTEMBER-2025 | 2025-08-30 → 09-29 | 2025-09-14 | `2025-Q3` |
  | OCTOBER-2025 | 2025-10-01 → 10-23 | 2025-10-12 | `2025-Q4` |
  | NOVEMBER-2025 | 2025-11-15 → 11-25 | 2025-11-20 | `2025-Q4` |
  | DECEMBER-2025 | 2025-11-27 → 12-28 | 2025-12-12 | `2025-Q4` |
  | JANUARY-2026 | 2026-01-02 → 02-02 | 2026-01-17 | `2026-Q1` |
  | FEBRUARY-2026 | 2026-02-02 → 02-27 | 2026-02-14 | `2026-Q1` |
  | MARCH-2026 | 2026-02-28 → 03-30 | 2026-03-15 | `2026-Q1` |
  | APRIL-2026 | 2026-03-30 → 04-30 | 2026-04-14 | `2026-Q2` |
  | MAY-2026 | 2026-04-30 → 05-29 | 2026-05-14 | `2026-Q2` |
  | JUNE-2026 | 2026-05-29 → 06-30 | 2026-06-14 | `2026-Q2` |
  | **JULY-2026** | **2026-06-30 → 2026-08-01** | **2026-07-16** | **`2026-Q3`** |
  | **AUGUST-2026** | 2026-08-01 → 08-29 | 2026-08-15 | **`2026-Q3`** |
  | **SEPTEMBER-2026** | **2026-08-29** → 09-15 | 2026-09-06 | **`2026-Q3`** |

- **THE TWO PICKERS NOW LEGITIMATELY DIFFER, AND THAT IS THE POINT.**
  `fetchOpsLedgerCampaignOptions()` reads **`view_ops_ledger_campaign_span`**, not
  `view_rc_movement_campaign_options`. That view is built from `rc_out`, so a campaign that has
  PRODUCED but not yet been FED is missing from it — which is exactly what SEPTEMBER 2026 was on
  the day it opened (a shift on 2026-08-29, three days before its first feed). The ledger DRAWS
  such a campaign, so its picker must offer it; RC Movement's matrix is feeding-only, so its
  fed-only list is still right there. The `campaign_year >= 2025` filter is also gone — 32 rows
  is three orders of magnitude under PostgREST's cap and the 2024 one-feeding rows are real
  campaigns the EOQ tab can be pointed at. `OpsCampaignOption.totalFedKg` now reads **0**: the
  span view is a calendar spine and carries no tonnage, the picker only ever used it to sort, and
  a fed total belongs to the KPI row.
- **THE BLOCKS-TABLE FOOTER (2026-09-16).** The ACTUAL FED PRICE modal renders
  `view_ops_ledger_campaign_block` as a table and its footer has to total the columns that table
  prints; the campaign's total ARRIVAL weight was published nowhere. `view_ops_ledger_campaign_kpis`
  gained **`blocks_delivered_kg`** (Σ `delivered_kg` over EVERY block the campaign fed),
  **`blocks_closed_delivered_kg`** (the CLOSED ones — the resiko denominator, carried so the ratio
  is auditable from its own row), **`blocks_total_fed_kg`** (the blocks' ALL-TIME fed kilos, which
  is NOT the campaign's own `fed_kg` — a shared block was fed by other campaigns too),
  **`blocks_resiko_kg`** and **`blocks_closed_resiko_loss_pct`** (a FRACTION). **THE TWO RESIKO
  FIGURES AGREE — measured on all 32 campaigns, 0 differences**, because
  `view_analytics_batch_cost.weight_lost_kg` / `loss_pct` already restrict themselves to CLOSED
  blocks; that holds even on campaigns still holding open ones (JANUARY 2024: 14 open, both NULL;
  SEPTEMBER 2026: 4 open, both 9,260.00 kg / 0.022058). Neither is "fixed" and neither replaces
  the other — the pair exists so a reader can check the total against the rows above it, and
  `kpi_blocks_resiko_mismatch` re-derives the agreement every run rather than leaving it as a
  sentence in a COMMENT. **JULY 2026: 1,054,434.00 kg arrival / 1,006,987.00 kg all-time fed /
  47,447.00 kg resiko / 0.04499760060847810294**, against a `block_resiko_kg` of 47,447.00 and a
  `block_resiko_loss_pct` of 0.04499760060847810294. **The GROUP RPC gets NOTHING new**, and it is
  the same refusal it already makes about resiko: 78 of 523 blocks were fed by more than one
  campaign (5 of Q3 2026's 47), so adding a shared pile's whole-life arrival weight once per
  campaign that touched it would inflate a group arrival total exactly the way a group resiko kg
  would. `fn_ops_ledger_group_blocks` already publishes the de-duplicated rows; **a group footer
  must total THOSE.**
- **COST, measured under the 5 s guard.** `view_ops_ledger_day_block` with the lab join is
  **16.2 ms / 407 shared buffers** for JULY 2026 (94 rows) against 36 ms for the view it replaced
  — the `lab` CTE is ONE sequential scan of `deliveries` (76 buffers, 1,756 rows → 656 batch
  codes; there is no index on `deliveries.batch_code`, which is why it is a grouped CTE and not a
  lateral). The blend view is **16.0 ms / 407 buffers** (24 rows) — the same scan plus a group-by.
  The KPI row with its new lateral is **37.4 ms** against 33 ms. The per-campaign verify probe
  went from round 3's 280–581 ms / 10,982–12,599 buffers to **413–992 ms / 15,605–19,283**, since
  it now proves a TENTH view.
- **⚠ A KNOWN, OPEN DIVERGENCE THE VERIFY RUN NAMES OUT LOUD — `php_per_produced_kg_delivered`.**
  `view_analytics_batch_cost` publishes PC COST (delivered) as **STRICT NULL unless the campaign's
  fed price is 100 % TRACEABLE**; `fn_ops_ledger_group_kpis` computes `Σ fed_value ÷ Σ produced`
  with **no coverage guard**. Both rules are as written and they had never disagreed — until
  2026-09-16, when **SEPTEMBER 2026 fed 2,000 of its 452,970 kg from a block with no delivery
  rows (coverage 99.5585 %)**: the campaign now reads NULL and the group reads **60.904**, a
  figure understated by exactly the untraceable kilos' money — the L-008 shape. **Nothing was
  changed about either number**, because bringing the group into line blanks a cell on Renzo's own
  EOQ strip and that is his decision. What changed is the PROOF (migration
  `20260916031811_ops_ledger_verify_split_group_pc_cost_delivered`, probe only): the column left
  `single_campaign_group_mismatch` — which was testing a POLICY, not the group machinery — and
  became two keys, **`group_pc_cost_delivered_mismatch` (0 ALWAYS: whenever the campaign publishes
  a NUMBER the two must agree exactly)** and **`group_pc_cost_delivered_coverage_divergence`
  (0/1)**, whose firing campaigns the script PRINTS BY NAME on every run. `php_per_produced_kg_true`
  is not split, because BOTH sides already go strict-NULL there. **This is an open item, not a
  resolved one.**

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

Everything else — the shift expand, the grade lens, the block lens, the blocks-used expand,
**the day's projected fed blend and the blocks-table footer (2026-09-16)** and
`view_ops_ledger_campaign_grades` — carries **no money-named column at all** and none is
derivable, so those surfaces are safe for every role. The seven lab stats, the seven weighted
means with their coverage kilos, `blocks_delivered_kg` / `blocks_total_fed_kg` /
`blocks_resiko_kg` / `blocks_closed_resiko_loss_pct` and every quarter column are all
peso-free — **not one ₱ column was added on 2026-09-16.**

### Row budgets / PostgREST

No single campaign's lens exceeds **114 rows**, so every read is far under PostgREST's 1,000-row
cap *per campaign*. But `view_ops_ledger_day_block` is **2,148 rows over all history**, so the
page must **fetch PER CAMPAIGN and fold** — which is what `fetchOpsLedger` does (per-campaign
reads in parallel, each paged through `fetchAllRows`). A whole-history read would truncate
silently.

### Proofs

`npx tsx scripts/verify-ops-ledger.ts` — **87 assertions** (25 static + 62 live); zero on every
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
| `ops-kpi-modal.tsx` | That math: `KpiDetail` (the one-line formula, then either the inputs list or a `table`, the **RESULT TILES**, the caveats) rendered in a `Dialog` **sized to its content and clamped to the viewport**. Since 2026-09-16 it also carries an `actions` slot in the header — a NODE, so the print control lives in `ops-print-sheet.tsx` and there is no import cycle. |
| `ops-modal-size.ts` | **THE ONE definition of how big a modal is** — `opsModalWidth()`, `OPS_MODAL_CONTENT`, `OPS_MODAL_BODY`, `OPS_MODAL_MAX_WIDTH` (1720). No JSX, so both dialog components read it without a cycle. |
| `ops-blocks-table.tsx` | **The BLOCKS USED table** the FED PRICE / ACTUAL FED PRICE / RESIKO COST / RESIKO LOSS modals render — two column sets (`fed` · `actual`) over one normalised row shape, plus `campaignBlockRows()` / `groupBlockRows()`, **`campaignBlocksFooter()` / `groupBlocksFooter()`** (the aligned `<tfoot>` row, 2026-09-16) and **`blocksTableWidth(variant, canViewPrices)`**, the Σ the dialog is sized from. A `print` prop draws the same table black-on-white with no tint, no sticky surface and no scroller. |
| `ops-production-table.tsx` | **The PRODUCTION breakdown** — the two tables the PRODUCED · YIELD · LOSS · WASTE LOSS family opens: the four figures per campaign (+ GROUP), and the eight waste streams underneath. `productionRowFromCampaign()` / `productionRowFromGroup()` / `productionTablesWidth()`. |
| `ops-rc-movement-modal.tsx` | **RC FED's modal** — `/inventory/rc-movement`'s Classic matrix, `next/dynamic({ssr:false})`, fetched on demand per campaign with `fetchRcMovementMatrix`, with campaign tabs for a GROUP cell. **Inherits the 2026-09-17 block-footer trim for free** (no edit to the matrix): each block column's footer is now `FED <kg>` (this campaign's own draw — `view_ops_ledger_campaign_block.campaign_fed_kg`, the same peso-free figure `OpsCampaignBlock.campaignFedKg` carries) · `₱/KG` (DELIVERED, not actual) · `LOSS %` (no leading minus), with the block's lifetime figures on the hover card. It DOES own one new control: the **`Actual ₱` switch beside the campaign tabs**, local state, which adds the fourth `ACTUAL` footer line. See `app/(app)/inventory/rc-movement/CONTEXT.md` → "Frozen summary footer" and "The `Actual ₱` switch". |
| ~~`ops-day-detail.tsx`~~ | **DELETED 2026-09-15 (round 3).** A day now expands into ordinary child rows, so the shift cards and the day-grain BLOCKS USED table had no caller left. |
| `ops-group-picker.tsx` | The GROUP builder — selection chips + a popover holding the campaign list **GROUPED UNDER ITS QUARTER HEADINGS (2026-09-16)**, a filter box and the derived quarter presets. A row states its **`firstDate → lastDate`**, never a tonnage (the option list is the calendar SPAN view and carries none); the selected CHIPS take their tonnage from `rollups[].fedKg`. Ordering is on `firstDate`, which every campaign has — `maxDate` is the last FEED and is NULL on a campaign that has produced but not yet been fed. |
| `ops-fed-day-sheet.tsx` | **THE FED CELL'S SIDEBAR (2026-09-16)** — a right-hand `Sheet`, OPAQUE, titled `<date> · <campaign> · FED`: the day's seven PROJECTED lab stats from `day.fedBlend` with their coverage captions, the caveat line, and the `BATCH · BLOCK LOC · FED kg · MC · ASH · BD ASTM · BD JIS · GRIT · VM · FC` table from `day.blocksFed` with the blend as its footer. A batch cell opens `BlockingDetailPanel`. **NO ₱ ANYWHERE** — neither source view carries one. |
| `ops-page-print.tsx` | **THE PRINTED PAGE (2026-09-17)** — `OpsPagePrintControl`, the toolbar `Print` button, and the pages it builds: **page 1 the EOQ ROLLUP** (only when there IS a group), then **one page per campaign** carrying that campaign's own KPI strip (which IS its EOM rollup) over its day ledger in KEY COLUMNS ONLY. Drives the same `GroupPrintStage` / `GroupPrintPage` / `printCard`, portalled to `<body>`, and injects its own `@page` block for the duration. Since round 9 (2026-09-17) it owns the **vertical budget** — `ledgerMetrics(dayCount)` derives the row height and body font from the measured page box, `OPS_PRINT_MAX_ROWS_PER_PAGE` is the promise (45) — and the print **colour**, and it exports `OpsPrintRollupPage` / `OpsPrintCampaignPage` / `OPS_PAGE_PRINT_RULES` so the sheet can be mounted statically and measured in a real print box. |
| `ops-print-sheet.tsx` | **THE PRINTED PRICE SUMMARY (2026-09-16)** — `OpsPrintSheet` (one page: title · span · counts · rows · aligned footer · result, black on white) and `OpsPrintControl` (a Print BUTTON on a campaign modal, a small MENU on a group's: `Print all N separately` plus one entry per campaign). It drives the platform `GroupPrintStage` / `GroupPrintPage` / `printCard`, PORTALLED to `<body>` — see "THE STAGE IS PORTALLED" below. |
| `ops-export.tsx` | **THE `Export` BUTTON (2026-09-18)** — `OpsExportControl`, beside `Print`, same height/border/typography (both are plain `<button>`s with one shared class string, so they read as one pair). It FETCHES `/operations/export?campaigns=…` rather than being an `<a download>`, because a link cannot see a failure: a 401 or a builder error would download a file containing an error message. The route answers in **plain text** and that body goes straight into `errorToast()` (persists until dismissed, carries Copy — the CLAUDE.md HARD RULE). The filename is read back off `Content-Disposition` (`filename*`), never rebuilt here. It exports exactly `selected`, so the file and the screen can never show different campaigns. |
| `export/route.ts` | **THE DOWNLOAD (2026-09-18)** — `GET ?campaigns=…`, `runtime = 'nodejs'`, `force-dynamic`. Parses the address the SAME way `page.tsx` does (comma-separated, upper-cased, de-duplicated; absent = `latestQuarterKeys()`), calls the SAME `fetchOpsLedger()` (so it inherits the per-campaign row budget), resolves the group label through the SAME `quarterPresets()`, builds the workbook in memory and streams it. TWO server-side gates: a signed-in user (`supabase.auth.getUser()` — asked again although middleware already redirects, because a download route is exactly what later gets added to a `PUBLIC_PATHS` list by accident) and `canViewPrices()`, **ANDed with the adapter's own flag so the workbook can only ever be narrower — fail closed**. NO Storage bucket and no stored artifact: the file is a view of the live data, like the page, so unlike `sync_run_reports` there is no stored fact whose price-gating has to be recorded. `Content-Disposition` carries an RFC 5987 `filename*` — the name has an em dash, which a bare `filename=` cannot express. |
| `ops-lens.ts` | The lens registry (`production` · `grades` · `losses` · `blocks`), `DEFAULT_LENS`, `parseLens`, **`RATIOS_PARAM` / `RATIOS_OFF` / `parseRatios` (2026-09-17 — `?ratios=off`; ON is the default and is spelled as ABSENCE, the same contract `?lens=` keeps)**, `quarterPresets()` and **`latestQuarterKeys()`** — **which since 2026-09-16 do NO date arithmetic: they group the options on the `quarter_key` `view_ops_ledger_campaign_span` computed from each campaign's MIDPOINT, an incomplete quarter is still a quarter, and a preset's campaigns come back chronological by `firstDate` with the quarter's own span beside them.** `latestQuarterKeys()` is what `page.tsx` defaults to. |
| `ops-color.ts` | The semantic palette — `TONE` (one entry per meaning) and `CAMPAIGN_ACCENTS`. Opaque `head` for frozen surfaces, translucent `cell` for scrolling ones. Since 2026-09-17 also **`PRINT_TONE`** (+ `PRINT_NEUTRAL_FILL` / `PRINT_MUTED_TEXT` / `PRINT_WEEKEND_TEXT`) — the SAME six meanings in explicit LIGHT values with no `dark:` twin and no semantic token, so a printed sheet comes out identical whichever theme it was printed from. Every `value` colour clears 7:1 on white. |
| `ops-format.ts` | `kg` · `tons` · `php` · `pctFromFraction` · **`pctNumFromFraction`** (the bare percent NUMBER, for a cell that states its unit on the left) · `pctFromPercent` · **`lab`** (a lab reading at a fixed precision — 2 dp, 3 dp for the two BDs; NULL blank, never `0.00`) · `hours` · `count` · `shortDate`. Renderers only. |

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
reflows). **Absent `?campaigns=` = EVERY CAMPAIGN OF THE LATEST QUARTER (2026-09-16)** — see
"QUARTERS ARE DECIDED BY DATE" below. It was the newest campaign alone. **`?ratios=off`
joined them on 2026-09-17** — see "THE OUTPUT RATIOS GROUP IS ON A SWITCH".

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

**A MODAL IS SIZED TO WHAT IT HOLDS AND CLAMPED TO THE VIEWPORT (2026-09-16, round 4).**
Renzo, on a 1080p 24" monitor: *"The modal is causing shrinkage and overflowing of the table
UIs. The space can be MUCH better utilized considering how much space we have… It should also
occupy the space that is available so it can be viewed on any device."* `sm:max-w-4xl` is
**896px** and the ACTUAL FED PRICE table is **1,298px** of columns, so the table scrolled
sideways inside a dialog with ~900px of monitor empty on either side, and `BLOCK PRICE ₱…` /
`RESIKO LO…` ellipsised. `ops-modal-size.ts` now owns
**`width = min(96vw, Σ column widths + 44, 1720px)`** and `max-h-[92vh]`, and **the Σ is never a
literal** — it comes from `blocksTableWidth(variant, canViewPrices)` / `productionTablesWidth()`,
so a column that grows widens the dialog with it. Two things had to move with it:

- **THE COLUMN WIDTHS THEMSELVES.** Round 3 put the unit on the label's line and did not re-size
  the columns for it, so `BLOCK PRICE ₱/kg` clipped at *any* dialog width. The numeric columns
  are now sized as `measured label + 4px gap + unit + 16px padding`, measured, not estimated:
  BLOCK/ACTUAL/RESIKO PRICE 84 → **122/128/128**, RESIKO LOSS 84 → **106**, FED/ARRV WT 88 →
  **98/100**, RESIKO 86 → **98**, BATCH 124 → **152** (a `SEPTEMBER-26-BLK12` is 18 mono
  characters and a batch code is the row's identity). *Measured at 1920×1080: all 12 columns fit,
  `scrollWidth === clientWidth === 1298`, zero clipped headers, zero `…`.*
- **`transition-none` ON THE DIALOG, WHICH IS NOT COSMETIC.** `DialogContent` carries
  `duration-200` for its entrance, and `transition-property`'s CSS **initial value is `all`** — so
  with the width now varying per modal, re-opening on a wider table would have ANIMATED a layout
  property, which CLAUDE.md forbids outright. It does not touch the entrance: `animate-in` reads
  `--tw-duration`, which `duration-200` sets separately.

The layout is a flex COLUMN: header, formula line, result bar and caveats are **pinned**, and the
TABLE is the only flexible child and the only scroller. It is **`flex-auto`, never `flex-1`** —
`flex-1`'s `flex-basis: 0%` makes the child's hypothetical size ZERO, and in a container that is
only *clamped* at 92vh (never fixed) the container then measures itself as if the child were empty
and the child collapses. *Measured: a 4-row modal is 494px tall; an 18-row one at 1366×768 is
exactly 707px = 92vh with only the table scrolling.* `KpiDetail.result` became OPTIONAL in the
same change, for the PRODUCTION modal — four columns of results have no single headline, and
picking one would be a claim about which matters. Every modal now sizes to itself: **782px** (FED
PRICE, 7 columns) · **1,342px** (ACTUAL FED PRICE, 12) · **1,146px** (PRODUCTION) · **560px** (an
inputs list — "size to content" cuts both ways).

**PRODUCED · YIELD · LOSS · WASTE LOSS ARE ONE FAMILY (2026-09-16, round 4).** Renzo: *"Hovering
over one of them highlights all 4 of those KPIs. Since those 4 are interrelated, what pops up
should be a table where we can see all 4 of that data."* They **stay four columns** — the ask was
to relate them, not to merge them — and `KpiColumn.family` now carries `FAMILY_PRODUCTION` on all
four, which does two things:

- **Hovering or FOCUSING any of them lights all four**, in that row, with `bg-accent/70` +
  `ring-1 ring-inset ring-ring/40` (background and ring only — compositor-cheap). **Per ROW, not
  per column block**: the relationship between the four numbers is a statement about ONE campaign,
  and lighting three campaigns' worth would say something the data does not. The GROUP row behaves
  identically because it is the same `Row`. `onFocus`/`onBlur` as well as the pointer, so a
  keyboard reader sees what a mouse reader sees. *Measured: hovering YIELD on the JULY row lights
  exactly cells 2–5 and nothing on any other row.*
- **Clicking any of them opens ONE modal**, `ops-production-table.tsx`: a table of `RC FED t ·
  PRODUCED t · YIELD % · LOSS % · PROCESS LOSS kg · WASTE kg · WASTE %` with **one row per
  campaign in the strip plus the GROUP row**, the three formulas on the one `symbols` line above
  it, and a second table of the eight streams (`TRML 1 · TRML 2 · RS1A · RS1B · RS2/3 · RS5 · BF ·
  GRITS`, `TOTAL`, and `WASTE SHIFTS` = `23 of 28`). The coverage caveats ride underneath —
  `fedKgProductionReported` / `campaignsProductionReported` for YIELD's narrowed denominator,
  `producedKgWasteReported` / `campaignsWasteReported` for WASTE %'s. **Nothing is computed**: the
  GROUP row is `data.group`, never a fold of the campaign rows, and a campaign that reported no
  production reads blank on every production figure rather than 0.

**RC FED OPENS THE RC MOVEMENT MATRIX (2026-09-16, round 4).** Renzo: *"RC Fed should pop up to a
modal of RC movement… rendering the RC Movement table in a modal based on which campaign RC Fed
you click just makes so much sense."* It is the unification thesis made clickable — the cell is the
Σ of exactly the cells that matrix prints. **The matrix is NOT forked, copied or
re-implemented:** `RcMovementMatrix` (the **Classic** matrix) takes `{ data, onCampaignChange?,
onNavigateToBatch? }` and calls no `useRouter`, `usePathname` or `useSearchParams` — every route
concern lives in `rc-movement-route-view.tsx`, its HOST — so `ops-rc-movement-modal.tsx` is simply
a second host and not one character of the matrix changed. (The **v2** grid is not embeddable: it
takes the page's `searchParams` and writes `?campaign=` with `router.replace`, which inside this
modal would rewrite `/operations`'s own address.) Four things make it cheap and correct:

- **`next/dynamic` with `ssr: false`** — the matrix chunk is fetched on the first click. *Measured
  on the production build: `/operations` client JS 972.2 kB → **979.9 kB** across the same 36
  chunks, and the three chunks carrying the matrix's identifiers are verifiably NOT among them.*
- **The data is fetched ON DEMAND from the SAME server action the RC Movement page calls**,
  `fetchRcMovementMatrix(campaignKey)` — the ops payload gains no field, and the two screens cannot
  disagree about a campaign's cells because they read one query. Each campaign is cached for the
  life of the dialog; a failure keeps the dialog open with a Retry beside the project's persistent
  copyable `errorToast()`.
- **The GROUP cell gets campaign TABS, not three matrices.** Stacking them would be three tall
  grids fighting for one viewport, and the RC Movement views publish a matrix per CAMPAIGN — there
  is no group-grain matrix to render even if the room existed. `RC Fed = Σ MAIN feedings` plus the
  rollup's own totals (tonnes, kg, feed days, blocks, sundry) print above the grid, assembled from
  published fields.
- **₱ is gated where it always was.** `fetchRcMovementMatrix` resolves `canViewPrices()` itself,
  nulls every ₱ field before returning and does not even QUERY the three actual-price views for a
  denied caller; the matrix then drops `Fed ₱/kg` from its frozen pane's coordinate space. This
  host passes the payload straight through. *Verified against a price-denied payload: no `₱` glyph
  anywhere in the dialog.*

> **THE ONE DIALOG ON THIS SCREEN THAT IS OPAQUE, AND WHY IT HAS TO BE.** `backdrop-filter` — the
> `backdrop-blur-xl` in CLAUDE.md's canonical dialog glass — makes an element the **containing
> block for every `position: fixed` descendant**. The matrix renders `BlockingDetailPanel`, a fixed
> slide-over that is **not portalled**, so with the glass on, clicking a block header pinned the
> drawer to the dialog box instead of the viewport: *measured at 1920×1080, x=1299 · right=1819 ·
> y=44 instead of flush right and full height.* A transform does the same, so the primitive's
> `translate(-50%,-50%)` centring is replaced by `inset: 0` + `margin: auto` over a definite width
> and height; and `animate-in … zoom-in-95` has only a `from` keyframe, so a running or filled
> animation can HOLD `scale3d(.95)` and outrank the inline reset — hence `animation: none` and
> `filter: none` as well. *After all four: the drawer measures x=1400 · right=1920 · y=0 ·
> 520×1080, exactly the viewport.* Nothing is lost — at 1720×92vh this surface covers the screen,
> so there was no ground showing through to frost, and `DialogOverlay` still supplies the dimmed,
> blurred backdrop. **The KPI modals keep the glass**: they contain no fixed descendant. One known
> nit: **Escape inside the matrix's block drawer closes the drawer AND the dialog**, because
> Radix's dismiss and the panel's own handler both fire; the drawer's X and backdrop close only
> the drawer.

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

**THE FED CELL OPENS THE DAY (2026-09-16, round 7).** Renzo: *"Per cell in the Fed column, it
should be clickable like the KPI and once clicked show a table of the blocks that were fed on
that day, like a sidebar. And it should show me the stats of what was fed — a table / mini KPI
strip that shows me the projected MC, BD, Ash etc. of the final product. **Not to be taken as
truth but a good figure to see.**"* Every `TTL FED` cell on a day that fed is a `<button>` with
the same affordance idiom as an EOQ cell (full-width hit area, real button semantics, a visible
focus ring, `aria-haspopup="dialog"`), and it opens `ops-fed-day-sheet.tsx`.

- **THE HEAD IS A PROJECTION AND SAYS SO ON EVERY OPEN.** Seven tiles — `MC % · ASH % · BD ASTM ·
  BD JIS · GRIT % · VM % · FC %`, **three decimals for the two BDs and two for the rest**
  (CLAUDE.md → "Lab results"), each unit pinned LEFT through the platform `UnitValue` — read
  verbatim from `day.fedBlend`, which `view_ops_ledger_day_fed_blend` computed IN SQL weighted by
  FED KG. A stat whose `<stat>Kg` is short of the day's `fedKg` prints *"from 41,200 of 47,000
  kg"* under it: a COMPARISON of two published fields, not arithmetic. The caveat line is
  permanent, not a hover.
- **THE LIST AND THE HEAD ARE ONE POPULATION.** `blocksFed` and `fedBlend` come from the same
  relation, so a block can never appear in one and not the other. NULL IS NEVER 0: a block with
  no lab panel reads blank on all seven (53 of the 525 blocks a campaign has ever fed carry no
  reading), and the footer prints `day.fedKg` beside the blend row.
- **A REST DAY, AND A DAY THAT FED NOTHING, GET NO BUTTON** — the same rule the expand chevron
  follows for a day with no shift. *Measured on the fixture: 12 buttons for 3 campaigns × 4 fed
  days, none on the rest day or on the day that produced without feeding.*
- **IT IS A SHEET AND THEREFORE OPAQUE.** It slides over the scrolling ledger, so the primitive's
  canonical glass is overridden — `bg-background`, `backdrop-blur-none`, **and the
  `supports-[backdrop-filter]` twin**, because a variant-prefixed class is its own utility group
  and a plain `bg-background` would not replace it. **NO ₱ ANYWHERE**, at any role.

**QUARTERS ARE DECIDED BY DATE, AND THE LATEST ONE IS THE DEFAULT (2026-09-16, round 7).** Renzo:
*"It is not showing the current Q3 2026 group because it isn't complete yet. It should show it
and default to it since it is the latest. Quarters are based on date, not on batch."*

- **`page.tsx`'s default is now EVERY CAMPAIGN OF THE LATEST QUARTER**, resolved by
  `latestQuarterKeys(options)` — the first preset `quarterPresets()` returns, which is the quarter
  holding the newest `firstDate`. It was the single newest campaign, which opened the EOQ tab on
  one month of a quarter the owner reads as a whole. The single-newest fallback survives only for
  the case where no option carries a quarter at all.
- **ONE FUNCTION, TWO SURFACES.** The picker's presets, its list headings and the page's default
  all read `quarterPresets()`, so a heading can never name a quarter the preset above it does not
  build and the address can never disagree with the chips. It does NO DATE ARITHMETIC — `quarterKey`
  is `YYYY-Qn` and `firstDate`/`lastDate` are `yyyy-MM-dd`, so every comparison in it is a STRING
  comparison over values the database decided (the MIDPOINT rule, in SQL).
- **`OpsCampaignOption.totalFedKg` IS DEAD AND IS NO LONGER RENDERED.** The span view is a calendar
  spine and publishes no tonnage, so the field reads 0 for every row; the list prints
  `firstDate → lastDate` instead and the SELECTED chips take a real fed total from
  `rollups[].fedKg`. *Measured on the fixture: `Q3 2026 · 2026-06-30 → 2026-09-15` over JULY,
  AUGUST, SEPTEMBER in that order, then `Q2 2026` with JUNE — and the bare address resolved to all
  three of Q3.*

**THE BLOCKS-TABLE FOOTER SITS UNDER ITS OWN COLUMNS (2026-09-16, round 7).** Renzo: *"Footers I
don't really like. It should align with the columns. Also add the same kind of pop in the colour
as the rest of the table — don't overly colour it, old people are reading this as a report,
legibility is king."* The wrapped line of `LABEL value` pairs is gone; it is a real `<tfoot>` row
built by `campaignBlocksFooter()` / `groupBlocksFooter()`, one published rollup field per column:
`FED WT → fedKg` · `ARRV WT → blocksDeliveredKg` · `RESIKO → blocksResikoKg` ·
`RESIKO LOSS → blocksClosedResikoLossPct` · `BLOCK PRICE → fedPhpKg` ·
`ACTUAL PRICE → actualFedPhpKg` (with `campaignWeightedActualFedPhpKg` as its caption) ·
`RESIKO PRICE → upliftPhpKg`. *Measured at 1920×1080: all twelve footer `left` offsets equal
their header's, exactly.*

- **THE GROUP LEAVES THE TWO WEIGHT CELLS BLANK AND SAYS WHY.** A block can be fed by more than
  one campaign, so a group ARRIVAL or RESIKO weight would double-count exactly the way a group
  resiko kg would — the refusal `fn_ops_ledger_group_kpis` already makes. `weightNote` is the
  `title` of those cells AND a line under the table. The ₱ rates ARE published for a group (every
  one is weighted in SQL) and are filled.
- **COLOUR LANDS ON THE HEADER AND THE FOOTER, NEVER ON A DATA ROW.** Sky FED/ARRV, amber RESIKO,
  violet ₱. The header takes the palette's **opaque** `head` step; the footer is an opaque
  `bg-muted` cell with the **translucent** `cell` tint on an inner layer — never alpha on the
  sticky cell itself, which is the "Frozen Panes" rule. Numbers stay `font-mono` on the neutral
  token.
- **THE PRICED-COVERAGE FIGURE MOVED TO THE COUNTS LINE** rather than being dropped with the old
  footer. It is a share of KILOGRAMS, not a ₱ column, so every role sees it.

**THE PRODUCTION MODAL IS LEANER, AND THE RESULT BAR IS THREE TILES (2026-09-16, round 7).**
Renzo: *"Take out process loss, take out the description headings — too wordy"*, *"What is waste
shifts? That needs to be taken out"*, and *"It seems weird keeping them the same colour."*

- **PROCESS LOSS kg and WASTE SHIFTS are gone**, with the two section headings, the coverage prose
  and the long notes under the result. What survives is the one-line formula and ONE caveat line
  (the eight streams do not sum to the process loss). `OpsProductionRow` lost `wasteShiftCount`
  and `shiftCount` with them, so the count cannot come back by accident.
- **`KpiDetail.result` BECAME `results: KpiResultTile[]`.** The combined `YIELD · LOSS · WASTE %`
  string was three figures from three families in one hue, which reads as one number; they are
  three tiles now in **emerald / amber / rose**, each with its label and its unit pinned LEFT
  through `UnitValue` and its value large. A modal with ONE result renders ONE tile through the
  identical component, so there is one shape and not two.

**PRINTING A PRICE SUMMARY (2026-09-16, round 7).** Renzo: *"When clicking on one campaign, have
the option to print a summary of the selected campaign. If clicking on the group row, give the
option to print all 3 SEPARATELY. We should also be able to print from the group summary modal
which campaign we want instead of batch printing all. **Make sure the printed summary is NOT
WORDY.**"*

- **THE MECHANISM MOVED TO THE PLATFORM, IT WAS NOT COPIED.** `printCard` and `GroupPrintStage` /
  `GroupPrintPage` now live in **`components/shared/print/`** (zero tenant knowledge — a DOM +
  `window.print()` mechanism and a stage that takes CHILDREN); `app/(app)/analytics/print-card.ts`
  and `group-print.tsx` are one-line re-exports, so no analytics call site moved. The stage gained
  ONE optional prop, `showHeader` (default true = what /analytics prints); `/operations` passes
  false, because every page already carries its own title and span and a second heading is exactly
  the wordiness that was asked to go.
- **THE SHEET IS THE TABLE AND NOTHING ELSE:** title · date span · counts line · rows · the
  aligned footer · the result. No definition prose, no caveat paragraph, no coverage narration —
  everything the modal says in words stays on the screen. Black on white, no tints, the STATE chip
  as plain text, and the ₱ columns gated exactly as on screen (a Production reader has no FED
  PRICE or ACTUAL FED PRICE column at all, so there is no print button to press).
- **THE STAGE IS PORTALLED TO `<body>`, AND THAT IS NOT A DETAIL.** `printCard` flattens every
  ancestor with `position: static; transform: none`, and Tailwind v4 centres a `DialogContent`
  with the INDIVIDUAL `translate` property (`translate: -50% -50%`), which `transform: none` does
  not reset — *measured: the sheet landed at `left: -960` on a 1920px viewport*. It could not be
  fixed from the print stylesheet either: **Lightning CSS FOLDS `translate`/`rotate`/`scale` back
  into a `transform` shorthand**, so the rule that would have reset them compiled into
  `transform: translate3d(0,0,0) rotate3d(…) scale3d(1,1,1)` and did nothing (measured in the
  served CSS, both orderings). Portalling the stage out of the dialog removes the translated
  ancestor instead of arguing with the compiler — and it is the truer statement anyway: the sheet
  is not part of the dialog's layout. **`app/globals.css` was left untouched.** This is the same
  containing-block family as the RC FED modal's `backdrop-filter` finding above.
- *Measured on the fixture, with the print media queries re-scoped to `all` and the teardown
  timers frozen:* one campaign → **1 page**, `document.body.innerText` is the sheet and nothing
  else; the GROUP's `Print all 3 separately` → **3 pages**, titled `JULY/AUGUST/SEPTEMBER 2026 ·
  ACTUAL FED PRICE`, `break-after` reading `page · page · auto` (no trailing blank sheet), and
  `window.print()` called exactly ONCE.

**THE OUTPUT RATIOS GROUP IS ON A SWITCH (2026-09-17, round 8).** Renzo: *"Would be nice
to have an option to toggle on and off the visibility of the column group 'output ratios',
since the more accurate stat for loss and yield is the overall average when a batch closes.
EOQ remains as is."* He is describing the caveat those two columns already carry in their
header `title` — a DAY yield is indicative, because the feed tank is continuous flow — and
asking to be able to put the indicative pair away without losing the WASTE pair beside it,
which carries no such caveat.

- **A `Ratios` toggle sits beside the lens tabs**, because it is the same kind of control:
  which columns the ledger shows. A real `<button aria-pressed>` with a focus ring, drawn in
  the amber `drift` hue its columns are drawn in, and its `title` states the day/campaign
  distinction at both settings.
- **THE STATE IS `?ratios=off`, AND ON IS SPELLED AS ABSENCE** — the contract `?lens=` keeps,
  so a plain `/operations` address stays clean and the param's presence always means
  something. Anything other than the literal `off` reads as ON, so a stale or mistyped value
  can never silently hide a column group. Written with the same `router.replace` inside a
  `useTransition` as the other two params.
- **THE COLUMNS ARE ABSENT, NOT BLANK.** `SpineCol.ratio` is the twin of `SpineCol.price`,
  and `spineCols` filters on both — so the frozen `left` offsets, the table's `minWidth`, the
  campaign footers, the sticky group footer and the expanded child rows all follow from the
  columns that survive. *Measured at 1920×1080: SHIFTS moves 780 → 628 and DT HRS 842 → 690,
  every row kind carries the same 21 cells, and the document never scrolls sideways.*
- **THE UN-FREEZE BREAKPOINT IS NOW DERIVED, NOT DECLARED.** The spine has FOUR widths rather
  than two (the ₱ column and the ratio pair each come and go), so `NARROW_MQ`'s hardcoded
  `1023px` became `narrowQuery(spineWidth)` = `round(spineWidth / 0.9) − 1` — the rule it
  always was (*un-freeze while the spine would take more than ~90% of the frame*), which
  reproduces **1023** for the 922px priced spine EXACTLY and gives **910 / 855 / 741** for the
  other three. *Measured at 900px: ratios OFF stays frozen (855 < 900) and ratios ON
  un-freezes (1023 ≥ 900) — the breakpoint really does move with the columns.*
- **THE EOQ STRIP IS UNTOUCHED at either setting**, as asked: its YIELD and LOSS are the
  CAMPAIGN figures, which is exactly the "more accurate stat" the note names.

**PRINTING THE WHOLE PAGE, ONE SECTION PER SHEET (2026-09-17, round 8).** Renzo: *"Have a
print button on the main page. It should print each section separately. For this Q3 2026
view: first the EOQ Roll Up in one page, then the 1st month in one page, 2nd month in
another, 3rd in another. Legibility is key, so just the key data. Output ratios group should
be off by default when printing since it is redundant. Each month page should also have a
little table giving the EOM rollup for that month. Maybe its own KPI strip up top also."*

- **THE SHAPE.** Page 1 is the EOQ ROLLUP — one row per campaign plus the GROUP row, headed
  `Q3 2026 · EOQ ROLLUP`. Pages 2..N are one per campaign: the campaign's own KPI strip, then
  its day ledger. **The strip IS the month's EOM rollup** — the same eleven published figures
  — so it is printed ONCE and not again as a separate little table underneath; printing the
  same numbers on one sheet twice is the wordiness this report was told to avoid.
- **A ONE-CAMPAIGN SELECTION PRINTS ONE PAGE, NOT TWO.** With a single campaign there is no
  GROUP row, so page 1 would be one row byte-identical to the campaign page's own strip. The
  EOQ page is therefore rendered only when `group !== null && rollups.length > 1`. *Measured:
  3 campaigns → 4 pages (`Q3 2026 · EOQ ROLLUP · JULY · AUGUST · SEPTEMBER`, `break-after` =
  `page · page · page · auto`); 1 campaign → 1 page titled `JULY 2026`.*
- **THE ELEVEN KPI COLUMNS ARE NOT LISTED TWICE.** `ops-kpi-strip.tsx` exports
  **`opsKpiPrintTable(rollups, group, canViewPrices)`**, which reads its own `COLUMNS` and
  hands back PLAIN DATA (a unit glyph and a formatted string per cell, plus WASTE LOSS's
  second line). What is shared is the part that must not drift — which columns, in which
  order, reading which published field; what is NOT shared is the render, because paper is
  black on white with no `UnitValue`, no tint and no button. The GROUP row is included on
  exactly the screen's own condition.
- **KEY DATA ONLY, AND OUTPUT RATIOS ALWAYS OFF.** The printed ledger is
  `DATE · DAY · FED ₱/KG · TTL FED · TTL PROD · WASTE kg · WASTE % · SHIFTS · DT HRS` plus one
  column per GRADE (`data.grades`, never a hardcoded list), and the campaign footer row from
  the rollup. YIELD % / LOSS % are never printed at any `?ratios=` setting — their caveat is a
  hover `title` that paper cannot carry, which is precisely why the note calls them redundant
  here; the CAMPAIGN yield and loss are on the strip at the top of the same page. **A REST DAY
  IS STILL A ROW**, blank but for its date and weekday.
- **THE EIGHT WASTE STREAMS DID NOT MAKE IT, AND THE MEASUREMENT IS WHY.** At 8pt — the
  legibility floor this report was given — a waste-stream column needs ~56px and a grade
  column ~58px. A4 landscape at a 10mm margin is **~1047px** of printable width; the nine
  spine columns are **600px** with two grades, so eight streams (**448px**) put a two-grade
  campaign at **1048px** and a four-grade one 117px over. Squeezing them in would trade the
  stated floor for a column nobody asked for. The day's WASTE kg and WASTE % carry the total,
  and the per-stream split is on screen under the Losses lens.
- **NO SPACER COLUMN — the opposite of the screen ledger, for a stated reason.** Paper does
  not scroll, so "never crush, always scroll" has no scroll half to offer and the only
  question left is how the page width is shared. `width: 100%` + `table-fixed` makes the
  declared widths a RATIO, so the columns fill the sheet instead of leaving ~40% of it blank.
  *Measured with the sheet pinned to 1047px: the ledger and the KPI table both lay out at
  1031px, `scrollWidth === clientWidth`, and not one header clips.*
- **THE `@page` RULE IS INJECTED AND REMOVED, BECAUSE IT CANNOT BE SCOPED.** `app/globals.css`
  already sets `@page { size: A4 landscape; margin: 12mm }` and `@page` takes no class, so it
  governs every print in the app. This report wants its own margin (**10mm**, tightened to
  **8mm** in round 9) plus the row/head break rules a multi-page table needs
  (`tr { break-inside: avoid }`, `thead { display: table-header-group }`, both scoped to
  `[data-ops-print]`), and it must not take them from `/analytics`. A `<style>` block is
  appended at print time and removed when the stage unmounts, which is on `afterprint`.
  **`app/globals.css` was not touched.** *Measured: the block is present during the print and
  gone 2.6s later, with `bw-printing` cleared and the stage unmounted.*
- ~~**A CAMPAIGN LONGER THAN ONE PAGE FLOWS**, with `thead` repeating and no row split across
  the break. *Measured: a 5-day campaign page is 283px at the real page width, so a 33-day one
  crosses onto a second sheet — accepted.*~~ **ACCEPTED IN ROUND 8, REJECTED BY RENZO IN ROUND
  9** — the 33-day JULY sheet spilling five rows onto a third page is the first thing he named
  in the returned PDF. A campaign now fits one sheet up to **45 day rows**; see "COLOUR ON
  PAPER, AND ONE SHEET PER CAMPAIGN" below. The flow behaviour itself is unchanged and is what
  happens ABOVE that ceiling.
- **₱ IS ABSENT ON PAPER TOO.** *Verified against a price-denied payload: the printed strip
  reads `CAMPAIGN · RC FED · PRODUCED · YIELD · LOSS · WASTE LOSS · RESIKO LOSS`, the ledger
  drops `FED PRICE`, and the document contains no `₱` glyph in text OR markup.*
- **THE STAGE IS PORTALLED TO `<body>`** for the reason `ops-print-sheet.tsx` records
  (`printCard` flattens with `transform: none`; Tailwind v4 centres with the INDIVIDUAL
  `translate`; Lightning CSS folds a `translate` reset into a `transform` shorthand). Here the
  trigger is a toolbar button rather than a dialog, but the portal costs nothing and keeps the
  two print paths on this screen identical.

**COLOUR ON PAPER, AND ONE SHEET PER CAMPAIGN (2026-09-17, round 9).** Renzo printed Q3 2026
to PDF and sent it back: *"Print output lacks color. Hard to determine which data is which.
Would be nice to have it follow the current operations sheet a bit (in light mode) but have
colors that work well on print. Make it a point to make sure all rows + KPI strip per month
fit in ONE page and not overflow to another. Making sure 32-33 rows fit in one A4 landscape
page would be nice."* Three things were wrong in that PDF and all three are fixed.

- **THE ROW HEIGHT WAS A CONSTANT WHERE IT HAD TO BE A FUNCTION.** Every row was whatever
  `text-[8pt]` with an inherited line-height happened to be (~19.5px), so JULY's 33 days ran
  five rows onto a third sheet and AUGUST's 29 ran **one** row onto a fifth. It is now derived
  from the day COUNT against the sheet's **measured** vertical budget: A4 landscape is 210mm
  tall, an 8mm margin leaves **733.2px**, the fixed chrome is **81px** (title+span on one line
  **17** · single-line KPI strip **34** · one-line ledger header **16** · two `gap-1` **8** ·
  **6** of measured sub-pixel slack), so **652px** is left for rows and
  `rowH = clamp(floor(652 / (days + 1)), 14, 22)`. The body font steps down with it —
  9 / 8.5 / 8 / 7.5 / **7pt floor, never lower** — and `lineHeight` is set to `rowH − 3`
  explicitly, because a `<tr>` height is a FLOOR in the table model and the only way to pin a
  row is to pin its content.
- **THE TOTALS ROW IS IN THE DIVISOR, NOT IN THE CHROME — and that is the fix, not a
  refinement.** It is a `<tbody>` row drawn at the body font, so its height IS `rowH`. Pinning
  it at a constant produced the first miss of this round: AUGUST's 29 days computed to 22px
  rows and *measured 736px against a 733px box*, i.e. it would still have spilled by one row.
  Counting it as the `days + 1`-th row removes the circularity rather than approximating it.
- **THE TOTALS ROW STOPPED BEING A `<tfoot>`.** Chrome REPEATS a `<tfoot>` on every printed
  page, so in the returned PDF `JULY 28 D 45.34 781,234 …` printed at the foot of page 2 AND
  again at the foot of page 3 and read as a duplicated total. It is the last `<tbody>` row now.
  `<thead>` keeps `display: table-header-group`: **a header that repeats is a help, a total
  that repeats is a lie.**
- **THE SHEET CARRIES THE SCREEN'S OWN PALETTE, IN EXPLICIT LIGHT VALUES.** `PRINT_TONE` in
  `ops-color.ts` — the same six {@link OpsTone} meanings (sky FED · emerald PRODUCED/YIELD ·
  amber LOSS · rose WASTE · violet ₱ · zinc spine), declared with **no `dark:` twin and no
  semantic token**, so the paper comes out identical whichever theme the button was pressed in.
  Three strengths: the family's **100** step under **900** text on a header, a 2px **500** top
  border, and a body column tint hand-mixed at **≈7% of the 500 step into white** (the 50 step
  is ~3% and vanishes on a laser printer). **Every KPI value colour clears 7:1 against white,
  computed not eyeballed** — sky-800 7.56 · emerald-800 7.68 · amber-900 9.07 · rose-800 8.02 ·
  violet-800 8.98 — which is the greyscale insurance: a 7:1 colour is still a dark grey once
  the hue is thrown away. Weekend DAY labels amber-800 (7.09), rest-day rows a neutral zinc-100
  fill with muted zinc-500 text, totals bold on zinc-100 under a 1.5px rule.
- **THE COLUMN-GROUP BAND IS FOLDED INTO THE HEADER ROW, and the reason is the budget.** A band
  row of its own costs ~17px, which is most of a day row. The tinted fill plus the 2px coloured
  top border says the same thing for nothing. The EOQ page uses the identical treatment.
- **`print-color-adjust: exact` IS LOAD-BEARING, NOT POLISH.** Without it a browser drops every
  background fill unless the person ticks "Background graphics", i.e. the colour would be in
  the markup and absent from the paper. It is in the injected block (`globals.css` already sets
  it on `[data-print-card] *`, but this report's colour must not depend on a rule written for
  another one).
- **THE HEADERS ARE SHORTENED FOR PRINT, THE KPI NAMES ARE NOT.** `FED PRICE ₱/kg` and `DT HRS
  h` both wrapped in the returned PDF, and a wrapped header is a two-line header that costs a
  day row — so paper gets `FED ₱/kg`, `FED kg`, `PROD kg`, `WASTE kg`, `WASTE %`, `SHIFTS`,
  `DT h`, `3X50 kg`. The **screen keeps the long forms**; this is a rendering of the column,
  not a renaming of it. That escape is deliberately NOT taken in the KPI strip — those eleven
  are the EOQ rollup's own column names and abbreviating them would make the printed strip and
  the screen strip disagree — so its **widths** move instead (`ACTUAL FED PRICE` clipped to
  `ACTUAL FED PR` at a flat 78px). Its `tone` comes across from `opsKpiPrintTable()`, so the
  family hue is stated once for both surfaces.
- **THE KPI STRIP IS ONE LINE.** WASTE LOSS was two (kg over %), which made the whole strip two
  lines tall for one cell; it prints `KG 106,507 · % 17.15` side by side now. A single-figure
  cell keeps the Excel Standard's accounting shape (unit pinned left, digits right); two
  figures become a right-aligned run, because pinning two units to one left edge is not a shape.
- **THE EIGHT WASTE STREAMS ARE STILL OUT, AND NOW FOR A SECOND REASON.** The width measurement
  from round 8 stands; round 9 adds the stronger one — the sheet's whole contract is a VERTICAL
  budget, and eight more columns force the body font down a step to keep the width, and the
  font step is exactly what buys the rows.
- **THE CEILING, MEASURED IN REAL PDFs.** The code promises **45 day rows** on one sheet
  (`OPS_PRINT_MAX_ROWS_PER_PAGE`); headless Chrome is two days more forgiving — **47 fits, 48
  takes a second sheet** — because collapsed borders are shared between rows, so the constant
  under-promises by design. Above the ceiling the page flows CLEANLY: *verified on a 48-day
  page, `<thead>` repeats on sheet two and the totals row appears exactly ONCE.* JULY 2026 at
  33 ledger days is the longest campaign the plant has ever run.
- **VERIFIED AGAINST ACTUAL PDFs, NOT AN ESTIMATE.** A throwaway fixture at
  `app/dev/table-playground/opsprint/` mounted the real pages in the real print context
  (`bw-printing` on `<body>`, the sheet `data-print-card`, ancestors `data-print-ancestor`, the
  `@page` block injected — everything `printCard()` does except `window.print()`), rendered by
  `chrome --headless=new --print-to-pdf`. Three campaigns of **33 / 29 / 19** days with rest
  days, weekends and a five-grade union: **4 pages** (1 EOQ + 3 campaigns), page heights
  **722 / 706 / 516** against a 733px box, `scrollWidth === clientWidth`, **zero** clipped or
  wrapped headers, **zero** clipped cells, **zero** `<tfoot>` elements, the totals row the last
  `<tbody>` row. Price-denied: **4 pages**, no `₱` in text OR markup, `FED ₱/kg` absent and six
  KPI columns. A 34-day campaign: **4 pages**. *Fixture deleted; `git status` carries no trace.*

**THE RC FED MODAL GAINED THE `Actual ₱` SWITCH (2026-09-17, round 8).** Beside the campaign
tabs, as **LOCAL REACT STATE — deliberately not the URL**: this page's address describes which
CAMPAIGNS and which LENS the ledger shows, and a disclosure inside one dialog over one
campaign's matrix is the same category as the expanded day and the block drawer, both of which
this screen already keeps out of the address. It is the SAME `ActualPriceToggle` component the
RC Movement route renders, and the matrix is handed `showActualPrice` with **no callback**, so
it renders no second control of its own. ABSENT for a price-denied payload — there is no actual
price to reveal. The modal also inherits the trimmed **three-line block footer** for free (no
edit here): `FED` (this campaign's own draw) · `₱/KG` (delivered, not actual) · `LOSS %`, with a
fourth `ACTUAL` line under the switch and everything else on the hover card. See
`app/(app)/inventory/rc-movement/CONTEXT.md` → "Frozen summary footer".

**THE EXCEL EXPORT (2026-09-18).** Renzo: *"The idea is like printing but more Excel-report
based for easy emails… the Excel should utilize formulas… EOQ Summary should be using formulas
to grab data from the other month tabs… an RC Movement tab that features 3 separate RC Movement
tables inside ONE tab."* The builder lives in **`lib/operations/excel/`** (seven files) and is
driven by `export/route.ts`; the format is Renzo's own, taken from a mock-up he hand-edited
twice (`.agents/plans/ops-ledger-excel-plan.md` §9–§10).

- **SIX TABS:** `EOQ Summary` (one row per campaign + the GROUP row, **every cell a link**) ·
  one tab per campaign (`JULY 2026` …: EOM rollup r3/r4, the band r7, headers r8, the day ledger
  from r9, then `BLOCKS USED`) · `RC Movement` (the campaigns' day × block matrices **stacked in
  one sheet**, because a sheet can freeze panes only once) · `Checks`. Tabs are created in
  DISPLAY order and written in DEPENDENCY order — the matrices first, because the month tabs
  link INTO them; `EOQ Summary` is filled LAST.
- **VALUES IN, FORMULAS OUT.** The only numbers typed in are the ones SQL published: per day the
  fed ₱/kg, grade kg, eight waste streams, shifts, downtime; per block the arrival kg, resiko kg
  and two prices; per matrix cell the kg fed. **Everything else is an Excel formula**, so
  correcting one waste cell moves the day total, the campaign total, the EOM rollup, the EOQ row
  and the `Checks` tab together. The platform rule "never compute in TypeScript" is intact: the
  ONE local aggregation (`weightedOverPriceSet`) is a CACHE of a formula this module itself
  wrote, documented at its call site, and no app surface reads it.
- **THE LEDGER AND THE MATRIX CANNOT DISAGREE.** A month tab's `TTL FED kg` is
  `='RC Movement'!E<that date's row>` and each `BLOCKS USED` row's `FED WT kg` is that block's
  COLUMN total on the same tab — 572 cross-tab links in the Q3 file. It is also why the matrices
  are built from the **ops-ledger payload** and not from `fetchRcMovementMatrix()`: that one's
  rows are the FED-ONLY span, so a rest day would have no row to link to.
- **EVERY FORMULA CARRIES A CACHED RESULT** (the payload's own figure), so the file reads
  correctly in a viewer that never recalculates — an email preview, a phone quick-look, a Google
  Sheets import. `fullCalcOnLoad` is set, so Excel recomputes on open and the cache is only ever
  the FIRST thing a reader sees. **The consequence for `Checks` is stated on that tab:** the
  cached WORKBOOK column IS the DATABASE column, so it can only read OK until something
  recalculates.
- **`a1.ts` IS THE ONE OWNER OF ADDRESSING.** Every A1 reference, every range and every `'…'!`
  prefix is built there; no sheet builder concatenates a column letter to a row number. That is
  not tidiness — **a column letter is not a constant**: `TTL FED` is `D` for an Owner and `C`
  for Production, so a hand-assembled formula would be right in one build and silently wrong in
  the other, and a wrong reference in Excel is not a crash, it is a plausible number from the
  wrong column. Builders declare a `Layout` of LOGICAL ids (`ttlFed`, `grade:3X50`,
  `block:<batchId>`) and ask it for letters; asking for an absent id THROWS rather than
  resolving to a neighbour. Sheet names are ALWAYS quoted (valid either way, so there is one
  spelling rather than a predicate to get wrong).
- **PRICE GATING BY ABSENCE, not by blanking.** For a `!canViewPrices()` caller the ₱ columns
  are **not written at all** — not blanked, not hidden (a hidden column is one click from
  visible), not zeroed. The Production workbook is a SMALLER file, not a censored one: 821
  formulas against 1,075, four tabs' worth of ₱ headers gone, the `Checks` tab 24 rows instead
  of 39. Proven from the outside: **zero cells contain a ₱** in the recalculated denied build,
  across values, formulas, number formats and cell comments. Production IS allowed to export
  (plan §8 decision 4).
- **NO FORMULA MAY PRINT `#DIV/0!`.** Every ratio, price and per-kilo figure whose denominator
  is itself derived goes through `divBlank()` → `IFERROR(num/den,"")`. Three different failures
  reach those cells and only one is a zero denominator: a campaign with no fed kg, no produced
  kg, no CLOSED block or no block in the price set divides by 0; a denominator CELL holding
  another formula's `""` raises `#VALUE!` (in Excel **text compares GREATER than any number**,
  so an `IF(den>0,…)` test waves the blank straight through — which is why `1-YIELD` and
  `FED PRICE/YIELD` cannot be guarded by a comparison at all); and `SUMPRODUCT` over a range
  holding one such `""` is `#VALUE!`, which is how ONE campaign missing a price would otherwise
  poison the whole GROUP row. **Measured: without the guards a campaign that recorded nothing
  publishes 27 `#DIV/0!` cells, including the EOQ Summary's headline yield, loss, waste % and PC
  cost; with them, 27 blanks and zero errors.** The consequence is deliberate and is the same
  refusal `fn_ops_ledger_group_kpis` makes in SQL — a group figure BLANKS rather than quietly
  averaging a partial population. `safeDiv()` (`IF(den>0,…)`) survives only on the day rows,
  where the denominator is a `SUM` over value cells and is therefore always numeric.
- **THE GROUP ROW PUBLISHES NO RESIKO KG, and the refusal is STRUCTURAL** — there is no such
  column on the tab, so there is no cell to blank. A block fed by two campaigns (78 of 523)
  would have its whole-life shrinkage counted once per campaign. Only the fed-kg-weighted RATIO
  is shown, and the cell carries a comment saying so. Same reason the group has no whole-block
  actual price, only the campaign-attributed one. `TRUE PC COST` is blank until every campaign
  is fully covered (`COUNTBLANK` over the campaign rows) — the SQL rule, said in Excel.
- **DATES ARE EXCEL'S BUILT-IN SHORT DATE** (`numFmtId 14`), written as the pattern both
  ExcelJS and openpyxl MAP onto that id — never a spelled-out pattern, which would freeze the
  date into one locale instead of reading `6/30/2026` on Renzo's Mac. Proven by unzipping the
  file and reading `styles.xml`.
- **`exceljs` NEVER REACHES A CLIENT BUNDLE.** It is a root dependency imported only from
  `lib/operations/excel/**`, whose only importers are the route handler and the verify script.
  Checked after a production build: **0 of 123 client chunks** contain `exceljs` or its
  internals; the one client chunk mentioning the feature carries the fetch URL and a fallback
  filename.
- **`scripts/verify-ops-excel.ts` (`npx tsx`) — 27 assertions, exit non-zero on any failure.**
  It builds the Q3 workbook from a fixture decoded from the mock-up's own live JSON (33/29/19
  days, 19/16/11 blocks, rest days, open blocks, a legitimately blank TRUE PC COST), RE-OPENS it
  and asserts: every formula targets a sheet AND a cell that is actually written (**a dangling
  link in Excel is not an error, it is a 0**); every cached result is the payload's figure; sheet
  names fit 31 characters and are quoted wherever referenced; the price-denied build carries no
  ₱ in any value, formula, number format or comment and no ₱ header survives (the label list is
  DERIVED from the full build's own output, never hand-kept); the GROUP publishes no resiko kg;
  the plan §10 coordinates and freeze panes; Short Date is the built-in id; a rest day is BLANK,
  never a row of zeroes; every division is guarded; and a DEGENERATE campaign (no production, no
  blocks, no price, `group: null`) still builds a four-tab file whose derived cells are blank.
  **Two of its checks deliberately read the FILE rather than the re-opened object**, because
  ExcelJS's reader drops a falsy cached result — a legitimate `<v>0</v>` and a deliberate
  `<v></v>` both come back `undefined`, so asserting on the object would report ~40 phantom
  failures and could never see a genuinely naked formula. `OPS_EXCEL_DUMP_DIR=<dir>` also writes
  the price-denied and degenerate workbooks, for a recalculation pass.
- **THE ONE READING TO KNOW ABOUT ON `Checks`.** `SUM` of nothing is 0 in Excel while the
  database publishes NULL, so a campaign that recorded NO activity at all makes its three
  `SUM`-backed kg rows (`RC fed kg`, `Produced kg`, `Waste kg`) read `workbook 0 · database
  blank · CHECK`. Every derived ratio and price on that same campaign correctly reads
  `OK (blank on purpose)`. It is self-explanatory with both columns side by side and it is the
  plan's own "label rather than hide" category — not a bug to paper over, and not something to
  "fix" by making a total lie about being empty.

---

## Dependencies

**Data layer:** `lib/supabase/server`, `lib/auth` (`canViewPrices`), `lib/supabase/paginate`
(`fetchAllRows`), `types/supabase`. Reads only `view_ops_ledger_*` and
`view_rc_movement_campaign_options`.

**The Excel export (2026-09-18):** `lib/operations/excel/{a1,styles,workbook,month-sheet,
rc-movement-sheet,eoq-sheet,checks-sheet}.ts` + `export/route.ts` + `ops-export.tsx`. The only
new package is **`exceljs`** (root dependency — the app root already had plain `xlsx`, which
writes formulas but no styling; `exceljs` is what the sync worker's report generator already
uses). It is imported ONLY from `lib/operations/excel/**`, whose only importers are the route
handler and `scripts/verify-ops-excel.ts` — never a client component. The builder reads NOTHING
from Supabase: it takes the adapter's payload, so it is as testable as a pure function and is
verified with no database at all.

**UI:** `lib/operations/{types,queries}`, `lib/utils` (`cn`),
**`components/shared/unit-value`** (the platform unit-on-the-left cell, shared with
`/analytics`), **`components/shared/print/{print-card,group-print}`** (the platform print
mechanism, moved out of `/analytics` on 2026-09-16 and shared with it),
`components/ui/{popover,input,sheet,dropdown-menu}`,
`lucide-react`, `lib/toast` (`errorToast`), and **four** files from the inventory module —
`app/(app)/inventory/_shared/blocking-detail-panel` (the shell-agnostic drawer, already shared
by Blocking, RC Movement, the inventory tab shell and the digest's Open Blocks band),
`app/(app)/inventory/blocking/actions#fetchBlockDataForBatch` + its `BlockData` type, and since
2026-09-16 **`app/(app)/inventory/rc-movement/rc-movement-matrix#RcMovementMatrix`** (loaded with
`next/dynamic({ ssr: false })`, so it is a lazy chunk and not part of this route's first load)
together with **`app/(app)/inventory/rc-movement/actions#fetchRcMovementMatrix`** and its
`RcMovementMatrix` type — the RC FED modal. All TENANT code, as this module is; the direction is
ops → rc-movement only, and the matrix is used AS IT STANDS (a second host, not a fork). **Nothing
is imported from `app/dev/**`**, and the drafts there are untouched. Both dialogs use
`components/ui/dialog`, sized through `ops-modal-size.ts`. The Blackwood Table is deliberately
NOT used — this is a read-only ledger with no inline editing, so the grid's whole value
proposition is unused; see the header comment in `ops-ledger-table.tsx`.

**Registered in the navbar:** `getBreadcrumb()` (`Operations` · *Plant operations ledger — day
rows on the campaign clock, with the EOQ rollup*) and `ICTC_MODULES`, next to Analytics.

## See also

- `.agents/plans/ops-ledger-plan.md` — §1 brief, §2 data layer, §3 UI
- `.agents/plans/ops-ledger-excel-plan.md` — the Excel export: §2 values-in/formulas-out, §5
  price gating, §6 the verification list, **§9–§10 Renzo's STANDING format** (round 2)
- `.agents/plans/ops-ledger-excel-mockup/` — the format's executable spec: `build.py` (the
  Python generator that reproduces Renzo's hand-edited `renzo-edited-round2.xlsx` with 0
  differing cells), the four live Q3 JSON fixtures the verify script decodes, and
  `generated-ts-v1.xlsx` — the TypeScript builder's own output, kept beside them for comparison
- `app/dev/ops-ledger/CONTEXT.md` — the three layout drafts and the unification thesis
- `app/(app)/inventory/rc-movement/CONTEXT.md` — the matrix this ledger shares a spine with
- `app/(app)/production/daily/CONTEXT.md` — the shifts/runs/downtime/waste source (L-051/L-051b)
- `CLAUDE.md` → "Views", "Price gating", "Database Rules", "Frozen Panes", "Excel Standard"
