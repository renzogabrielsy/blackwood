# 2026-09-14 — Downtime fix (L-051/L-051b), the three ops-ledger drafts, and a DATABASE INCIDENT (unresolved at handoff)

> Continues `2026-09-07-products-inventory.md` (and 2026-09-12's L-050 re-price fix, Fly v27).
> **READ §1 FIRST — the Supabase database was HUNG at handoff time and needs a dashboard restart.**

## 1. THE INCIDENT — what happened, what to do first
- **State at handoff (2026-09-14 ~12:30 PHT):** Postgres has written NO log line since 03:46 UTC
  (11:46 PHT), not even its 5-minute checkpoint; Supavisor reports `Failed to connect to database:
  {:error, :timeout}` on every checkout; PostgREST returns Gateway Timeout; the MCP SQL tool times
  out. **The live site is down** (every page reads the DB). Renzo was asked to **Restart project**
  from the Supabase dashboard (Project Settings → General → Restart project). Not done yet at writing.
- **Cause (from `postgres_logs`):** the `ops-ledger-data` agent applied migration
  `20260914033037_ops_ledger` (8 views + 2 functions) at 03:30 UTC, then at 03:41 created
  **`fn_ops_ledger_verify()`** — a SECURITY DEFINER probe that `count(*)`s and cross-checks EVERY
  new view over the WHOLE history in one call — and ran it at 03:45. The new views stack on
  `view_rc_movement_campaign_cells` + `view_production_daily` + `view_analytics_*` unfiltered, so one
  call recomputed years of feeding/production several times over; the instance went unresponsive
  (most likely OOM) at 03:46. The four `42501 permission denied for view view_ops_ledger_day` lines
  at 03:45 in Renzo's screenshot are expected (the views are `authenticated`-only by design) and are
  NOT the cause. **My briefing error: I asked for whole-history proofs on unmeasured views.**
- **Nothing was deleted or altered on existing objects.** The migration only ADDS
  `view_ops_ledger_campaign_span / _shift / _day / _day_grade / _day_block / _day_blocks_used /
  _campaign_grades / _campaign_kpis`, `fn_ops_ledger_group_kpis(text[])`, `fn_ops_ledger_verify()`.
  Nothing in the app references them yet (no page, no worker).
- **FIRST STEPS AFTER THE RESTART, in order:**
  1. `select 1`; then `pg_stat_activity` — terminate anything long-running on `view_ops_ledger%`.
  2. **`DROP FUNCTION public.fn_ops_ledger_verify();`** (a migration) so it can never be called again.
  3. `SET statement_timeout = '5s'` and `EXPLAIN ANALYZE` each `view_ops_ledger_*` FILTERED to ONE
     campaign (`production_batch = 'JULY' and campaign_year = 2026`). If any exceeds ~1 s, redesign
     that view as a campaign-filtered set-returning function (filter BEFORE aggregating) — never
     query these unfiltered again. `view_ops_ledger_campaign_kpis` and the group RPC must also be
     measured. Consider whether `view_rc_movement_campaign_cells` itself needs an index/materialization.
  4. Only then resume the build (§4).

## 2. Shipped today (all on `main`, live)
- **L-051 — downtime from MC's TIME RANGES, not her typed DURATION** (`a1b639f`, merge `9f6ad0b`,
  Fly **v28**): DURATION was blank since 2026-08-01 (Aug/Sep read 0 h) and covered only the first
  range in July; `"1 HOUR & 40 MINUTES"` parsed as 140. New `downtimeRanges.ts` (plant-day AM/PM rule,
  open/backwards ranges named, DURATION as cross-check → `downtime_duration_mismatch`),
  `shiftHours.ts` (derived, 12 h only on an OVERTIME signal), new columns `dt_ranges`,
  `shift_hrs_source` (migration `20260914013652`). Backfill 62 rows: 10.55 h → 51.18 h.
- **L-051b — Renzo's three rulings** (`f003570`, merge `7210110`, Fly **v29**): normal shift = **9 h**
  (`DEFAULT_SHIFT_HRS` in `shiftHours.ts` and `ledger-derive.ts`; five app literals collapsed to one;
  `shift_hrs_source = 'default_9h'`, 48 rows re-stamped); **no pre-sync backfill**; **"NO STOP(PING)
  OPERATION" = incident, not downtime** — matched per range, exact phrase family only (four "STOPPED
  …" reasons must NOT match), new `dt_incident_ranges` column (migration `20260914021704`), finding
  `downtime_incident_no_stop`; 2026-08-11 back to 0 h with its range preserved (Aug = 13.82 h).
  **Left alone on purpose:** 25 rows (June 2026 + 05-28/29) still `shift_hrs = 12`, source NULL —
  no surviving workbook to read an overtime signal from.
- **Three interactive ops-ledger drafts** (`65372f6` + `2a8122a`, merge `f9c7c01`) at
  `/dev/ops-ledger` (A Excel-faithful · B Group-first · C Split lens), mock data only, gated in
  production by `isPrivileged()` (signed-in Owner/Admin/Dev; 404 otherwise). **Renzo reported a 404
  while signed in** — unresolved; likeliest cause is the navbar Shield impersonation cookie
  (`dev_mock_role`) set to a non-privileged role. Verify before assuming the gate is broken.
- **Decisions taken:** Renzo picked **Split lens (C)**; the real page goes to a **NEW route
  `/operations`**; block columns keep RC Movement's behaviour (no sort/filter, header opens the block).
  Unification thesis: ledger and RC Movement = one day-row spine on the campaign clock with column
  groups switched on; "RC Movement" is a preset (the per-block group).

## 3. Uncommitted work parked on branch `feat/ops-ledger` (WIP — DO NOT MERGE)
Migration `20260914033037_ops_ledger.sql` (APPLIED to the linked project), `lib/operations/{types,queries}.ts`,
`app/(app)/operations/CONTEXT.md`, `.agents/plans/ops-ledger-plan.md`, `scripts/verify-ops-ledger.ts`,
CLAUDE.md + TIMELINE.md edits, regenerated `types/supabase.ts`. **The views are correct in intent but
UNMEASURED; the verify probe is the thing that took the database down.** Treat everything in §3 as
a draft to be measured, not trusted.

## 4. Next concrete action
Restart DB → §1 steps 1–3 → fix/replace `fn_ops_ledger_verify` with per-campaign, timed checks →
finish the data layer (measured) → frontend pass: `/operations` Split-lens page on real data
(campaign group builder `?campaigns=`, KPI strip from `fn_ops_ledger_group_kpis`, column groups,
per-block lens from `view_ops_ledger_day_block`, day expand from `view_ops_ledger_shift` +
`_day_blocks_used`, ₱ gated by `canViewPrices()`), navbar entry, docs.

## Lesson (add to memory/ledger)
**Never let an agent run whole-history proofs against a new view stack.** Measure each new view on
ONE partition with `statement_timeout` first; a SECURITY DEFINER "verify everything" function is a
denial-of-service button. Also: two agents in one working tree cross branches — use worktrees.
