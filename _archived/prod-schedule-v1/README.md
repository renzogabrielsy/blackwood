# Production Schedule v1 — Archived (2026-08-28)

This is the **in-app production PLAN** feature: the editable month grid
(`production_schedule`), its Home-Digest bands (week strip, rolling 10-day preview,
plant-status plan facts), the `/production/schedule` and `/production/setups` routes, the
setup library + its projection math, and the two one-off scripts that populated the plan.

## Why it's here

Renzo's call, 2026-08-28: **the plan is redundant with his Google Sheet**, which is and
remains the real master. Maintaining a second editable copy of it inside Blackwood bought
nothing and cost an ownership model (`owner` / `pending_upstream` / `row_version`), a
conflict-arbitration UI, and a sync stage. A **future v2 will be READ-ONLY and
gsheet-backed** — it will not resurrect this write path, so nothing here should be
restored wholesale.

Archived rather than deleted, exactly like `_archived/dashboard-v1/`, so the reasoning and
the shape of the solved problems stay recoverable.

## What was moved here (preserving structure)

| Original location | Archived location |
|---|---|
| `components/digest/schedule-*.tsx`, `schedule-*.ts` (11 files) | `components/digest/` |
| `components/digest/week-strip.tsx` | `components/digest/week-strip.tsx` |
| `components/digest/home-view-toggle.tsx` | `components/digest/home-view-toggle.tsx` |
| `components/production/setup-form-dialog.tsx` | `components/production/setup-form-dialog.tsx` |
| `app/(app)/production/schedule/` (page + actions) | `app/(app)/production/schedule/` |
| `app/(app)/production/setups/` (page + manager + actions) | `app/(app)/production/setups/` |
| `lib/production/setup-projection.ts` | `lib/production/setup-projection.ts` |
| `scripts/verify-setup-projection.ts` | `scripts/verify-setup-projection.ts` |
| `scripts/sync-prod-schedule.ts` | `scripts/sync-prod-schedule.ts` |
| `scripts/joseph-prod-sched.ts` | `scripts/joseph-prod-sched.ts` |

`home-view-toggle.tsx` came along because its only job was the `Digest | Schedule`
segmented control; `/` now has exactly one surface again and the `?view=` /`?month=`
params mean nothing there.

## The database side

- **`db/RESTORE.sql`** — the archived DDL. The data and object definitions also live in the
  **`graveyard` schema**.
- The live objects (`production_schedule`, `view_production_schedule_state`,
  `view_production_schedule_conflicts`, `fn_save_schedule_day`,
  `fn_release_schedule_day`, `fn_apply_schedule_upstream`) are dropped by a **held
  migration that runs only after this code change is deployed** — the app must stop reading
  them first.
- **`public.production_setups` is NOT dropped and NOT archived.** It is live reference data
  with all its rows and grants. Only its *UI* moved here; the table is now orphaned, which
  is a decision for Renzo, not a side effect of this removal. It was always safe to orphan:
  `production_schedule.setup` was deliberately free text with **no FK** to it.

## What deliberately stayed in the live tree

- **`sync_runs.result.reconciliation.schedule_conflicts` still parses and still renders.**
  `app/(app)/sync/types.ts` (`ScheduleConflict`), `lib/sync/cases-fold.ts`
  (`collectScheduleConflicts`) and `lib/sync/findings.ts` (the `schedule_conflict` kind)
  are UNCHANGED except for a "historical — no live producer since 2026-08-28" note.
  Historic run payloads in the database still carry those findings and the Sync panel pages
  through past runs; a kind the panel cannot parse would render as a blank card.
  `scripts/verify-schedule-conflict-fold.ts` stays green and is the proof of that.
  What was removed is the **write** affordance — `schedule-conflict-dialog.tsx`, the only
  caller of `takeUpstreamProposal` / `keepMineClearPending`.
- **`view_digest_stream_status.missed_working_days`** no longer counts
  `production_schedule.shifts > 0` days (the backend changed its definition to "days on
  which any other stream reported"), so the digest's lag-aware KPI states survive the plan's
  removal untouched.
- `components/digest/shell.ts` (`HOME_SHELL_CLS`) — still the `/` page-shell container; it
  merely stopped being *shared* with a second door.

## Notes

- `_archived/` is in `tsconfig.json`'s `exclude` and in `eslint.config.mjs`'s
  `globalIgnores`, so the dangling `@/...` imports in these files do **not** break
  typecheck, lint or build.
- It lives **outside `app/`**, so Next.js does not route or compile it.
- **Restorable via git history** — see the move commit, or `git mv` these back.

---

# The sync worker (added 2026-08-28)

The app half above stopped *reading* the plan. This half stopped *writing* it. Until this
landed, the Fly worker still called `fn_apply_schedule_upstream` on every run — and
**merging to `main` does not deploy the worker**, so the held drop migration could not be
applied safely until `cd workers/sync && npm run deploy` had shipped this change.

## What was moved here (relative to `workers/sync/`)

| Original location | Archived location |
|---|---|
| `src/reports/prodSchedule/` (`josephEmail.ts`, `parse.ts`, `plan.ts`, `refresh.ts`) | `worker/src/reports/prodSchedule/` |
| `test/reports/prodSchedule.test.ts` | `worker/test/reports/prodSchedule.test.ts` |
| `test/reports/prodSchedule-conditional.test.ts` | `worker/test/reports/prodSchedule-conditional.test.ts` |
| `scripts/prod-schedule-proof.ts` | `worker/scripts/prod-schedule-proof.ts` |
| `specs/prod_schedule.md` | `specs/prod_schedule.md` |

`plan.ts` is the piece worth reading if a v2 is ever attempted: the six conditional-write
rules, `computeSourceRev`, and the "unchanged revision writes NOTHING" steady state. It is
also the only surviving description of what `fn_apply_schedule_upstream`'s ops payload
looked like, which pairs with `db/RESTORE.sql`.

## What changed in the live worker

- **Stage 3c is gone** from `src/workflows/runSync.ts`, along with its `refreshProdSchedule`
  wrapper. The stage letters after it are **deliberately not renumbered** — `3d` and `3e`
  appear under those names in every historic run's progress log.
- **`src/lib/db.ts`** lost `readScheduleState()` (read `view_production_schedule_state`) and
  `applyScheduleUpstream()` (called `fn_apply_schedule_upstream`). Both objects are dropped
  by the migration, so leaving either would have guaranteed a 42P01/42883 on the next run.
- **`src/reconcile/rcOutStage.ts`** dropped `schedule_conflicts` from
  `ReconciliationChannel`. It is NOT re-declared as a legacy optional field: that type
  describes what a run *writes*, and an unfillable slot invites someone to fill it.
- **The run no longer opens Joseph Go's mailbox** (`kitz323@yahoo.com`) and no longer
  downloads the Google Sheet a second time for the PROD SCHED tab. A run's Gmail users went
  from 7 to 6 — `test/lib/gmailSession.test.ts` measures the topology, so its before/after
  counter moved with it.

## What deliberately stayed in the live worker

- **The `schedule_conflict` Excel renderer** (`src/reports/excel/workbook.ts`) — the same
  decision, for the same reason, as the app keeping its renderer. It has no producer and
  cannot fire on a new run; it exists so a workbook regenerated over a historic
  `sync_runs.result` still labels both sides of the fact. Do not add a producer.
- **`src/lib/streamStaleness.ts` and `src/reports/reportNotReceived.ts`** — untouched in
  behaviour, prose only. Both read `view_digest_stream_status.missed_working_days` and
  neither ever re-derived the calendar, which is exactly why the definition could change
  underneath them (planned days with `shifts > 0` → days any other stream reported) without
  a line of logic moving. A second copy of that rule in the worker would have had to be
  found and rewritten.
- **The BUG-019 post-mortems** in `src/lib/gmail.ts`, `src/lib/gmailSession.ts`,
  `src/workflows/mailClerk.ts`, `src/workflows/reportDeps.ts` and `specs/SHARED.md` §1.8 —
  annotated, not rewritten. The schedule fetcher was one of the seven sessions that broke
  production in July; deleting it from the account of what happened would make the fix look
  like it was solving a smaller problem than it was.

## Gates at the time of archiving

`npm run typecheck` ✓ · `npm test` ✓ · `npm run parity` ✓ · `npm run verify:container-build`
✓ · repo-root `npx tsc --noEmit` ✓ · `npx tsx scripts/verify-worker-view-grants.ts` reports
**four** views (`view_blocking_grid`, `view_digest_stream_status`,
`view_digest_unpriced_deliveries`, `view_flecon_bag_balance`), zero findings —
`view_production_schedule_state` left that list on its own, because the script derives it
from string literals in `workers/sync/src`. **That count is the ordering signal for the drop
migration:** if it still names the schedule view, the worker has not been updated and
migration B must not be applied.
