# 2026-08-28 — Production schedule removed, archive-first

> Renzo: *"Lets take out fully the prod schedule feature from the dashboard, from our pages and
> from our sync. I find it redundant with what I already maintain with my employees on google
> sheets. Archive everything first instead of deleting... I would eventually want to remake this
> prod sched feature as something that is purely based on the google sheet prod schedule and is
> READ ONLY."*

Branch: `feat/archive-prod-schedule` (off main @ `de72af2`).

## TL;DR
The whole feature — table, views, RPCs, digest band, schedule/setups pages, worker Stage-3c and
the Joseph Go email fetch — is out, with EVERYTHING recoverable: data + DDL in the locked
`graveyard` schema (+ `_archived/prod-schedule-v1/db/RESTORE.sql`, md5-verified against the DB
copy), all source files moved (never deleted) to `_archived/prod-schedule-v1/`. **Deleting the
archive is a separate decision Renzo has NOT made.** The v2 read-only-gsheet vision is recorded,
not designed.

## The archive (what "nothing lost" means concretely)
- `graveyard.production_schedule_20260827` — 273 rows (2026-01-01…09-30; 35 human-owned, 24 with
  parked `pending_upstream`), verified `EXCEPT ALL` = 0 both directions vs live before the drop.
- `graveyard.prod_schedule_ddl_20260827` — 8 objects' replayable DDL incl. grants/RLS/comments
  AND the pre-rewrite `view_digest_stream_status`/`_freshness` (the freshness rewrite is
  reversible too). Same DDL md5-identical in `_archived/prod-schedule-v1/db/RESTORE.sql` with
  restore order.
- `graveyard` schema: zero grants to anon/authenticated/service_role, RLS on with no policies.
- Code: 24 app files (digest schedule band + week-strip + view toggle, `production/schedule/`,
  `production/setups/`, `setup-projection`, 3 scripts), worker `reports/prodSchedule/` + 2 test
  files + proof script, `specs/prod_schedule.md` → all under `_archived/prod-schedule-v1/` with a
  README (why/what/how-to-restore).

## Decisions made (and by whom)
- **`missed_working_days` re-derived from observed activity** (a working day = any other stream
  reported), replacing the schedule calendar. Back-tested 239 days × 5 streams: 1,188/1,195
  verdicts identical; 6 new fires are arguably truer signals; 1 lost. **Structural blind spot,
  documented at migration + `lib/digest/day-status.ts` + `components/digest/CONTEXT.md` +
  `workers/sync/src/lib/streamStaleness.ts`: a day NO stream reports cannot be known to be a
  working day — a total plant-wide outage reads as a holiday.** Do not patch at the frontend.
- **Plan-driven digest states removed rather than faked**: the running/rest beacon, Planned
  setup, Projected out, the `rest` DayState, the flow chart's planned-rest band. `fedKg > 0` as
  a "running" proxy was considered and rejected (RC OUT files next morning → false "at rest").
- **Historic renderability kept everywhere**: `schedule_conflict` finding kind still parses and
  renders in the sync panel, cases-fold, and the Excel workbook builder (all marked HISTORICAL,
  no producer); worker stage letters 3d/3e not renumbered (historic progress logs name them).
- **Orphaned-but-alive, Renzo to rule (deliberately untouched):** `production_setups` TABLE
  (UI archived; six files restore it) and `view_digest_prod_actual_tons` (zero readers; its own
  migration header names the deleted plan as its purpose). Rule coined: *a view doesn't earn a
  grave — the graveyard is for what git can't recover.*

## Migrations + ship order (ORDER IS LOAD-BEARING)
1. `20260828012428_archive_production_schedule.sql` — APPLIED (self-refusing if counts/DDL blank).
2. Merge → Vercel deploy AND `cd workers/sync && npm run deploy` (FLY_ACCESS_TOKEN from
   ~/.fly/config.yml in the same command — sandbox quirk).
3. `20260828013000_drop_production_schedule.sql` — apply ONLY after both deploys.
4. `npx tsx scripts/verify-worker-view-grants.ts` must report **4 views, zero findings**
   (view_production_schedule_state leaving the derived list IS the proof the worker shipped).
5. `supabase gen types typescript --linked > types/supabase.ts` — only after the drop; second
   commit.

## Gates at merge time
Repo: tsc clean · build clean (both routes absent from manifest) · lint **147/16 — NEW BASELINE**
(was 167/28; `_archived/` now in eslint globalIgnores, which had been silently linting
dashboard-v1) · verify-table-core 80 · verify-schedule-conflict-fold 6/6 · verify-findings 54 ·
e2e 57. Worker: typecheck clean · tests **826/826** (55 files; 2 schedule test files archived) ·
parity 12/12 · container-build OK · verify-worker-view-grants 4 views/0 findings.

## Next concrete action
Renzo verifies the archive is complete (the digest, the graveyard tables, `_archived/`), THEN
rules on: (a) deleting the graveyard archive (his stated step 2 — not before his explicit go),
(b) `production_setups` table, (c) `view_digest_prod_actual_tons`, (d) when to design the
read-only gsheet-based schedule v2.
