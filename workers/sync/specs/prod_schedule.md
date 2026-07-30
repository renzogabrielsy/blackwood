# prod_schedule — the production PLAN refresh (Stage 3c)

> Spec for `workers/sync/src/reports/prodSchedule/**` — the sync worker's
> production-schedule refresh. Not a "report" in the ingestion sense (no Mail-Clerk
> manifest entry, no held rows, no `apply`/`classify` envelope, no parity fixture): it is
> an orthogonal, NON-FATAL stage that keeps `public.production_schedule` in step with two
> upstreams, and since **2026-07-30** it does so **conditionally**.

---

## 0. Contract (unchanged, and load-bearing)

`refreshProductionSchedule()` **swallows every failure** and returns `ok:false` + an
`error` string. `runSync.ts::refreshProdSchedule` wraps it again. **A schedule failure can
never fail the daily sync.** Anything added here must preserve that.

The stage writes **only** `production_schedule`. It touches no inventory or report table.

---

## 1. Upstreams

| Upstream | Owner | What it decides |
|---|---|---|
| Google Sheet, **PROD SCHED** tab | Renzo | the baseline calendar + **tonnages/grades** |
| Joseph Go's emailed **PRODUCTION SCHEDULE** workbook | Joseph | the **scheduling** — work/rest days, setups, shift hours, holiday/leave/pahubas day-types |

`mergeSchedules()` (`parse.ts`) overlays Joseph on Renzo: Joseph's scheduling wins,
Renzo's tonnage is kept on work days and zeroed on Joseph's non-work days, and a day
Joseph does not cover stays 100% Renzo's (`source` stays `gsheet:PROD SCHED`). Joseph
unavailable/unparseable → a Renzo-only refresh; that is a fallback, never an error.

**Date parsing is timezone-independent on purpose** (`XLSX.SSF.parse_date_code` on the raw
serial). Do not regress to `cellDates:true` — it anchors to local midnight and shifted
every `plan_date` one day early on a UTC+8 host.

---

## 2. Ownership — "follow until touched"

`production_schedule.owner` (migration `20260730060000_production_schedule_ownership.sql`):

| owner | meaning | may the sync write it? |
|---|---|---|
| `joseph` | following the email | **yes** |
| `gsheet` | Renzo's baseline, no Joseph coverage | **yes** |
| `human` | edited in the app | **NO** — the upstream value is parked |
| `actual` | production already reported for the date | **NO** — frozen for everyone |

`actual` is **derived, never stored**. The authoritative freeze signal is *"a
`production_shifts` row exists for that `transaction_date`"*, exposed as
`view_production_schedule_state.is_reported` / `.effective_owner`. It is re-evaluated on
every read AND inside every write statement, so it can never go stale.

Editing in-app is what flips ownership to `human` — there is no separate lock toggle.
**Lock granularity is the whole day** (approved decision): any field edit takes the date.

---

## 3. `source_rev` — the revision identity

```
source_rev = `${row.source}|${messageTag}|${dayHash12}`
```

| Segment | Value |
|---|---|
| `row.source` | the provenance tag already stored on the row — `joseph:REV5` \| `gsheet:PROD SCHED` |
| `messageTag` | `gm<threadId>.<uid>` for the Joseph email the overlay came from; `-` on Renzo-only days |
| `dayHash12` | first 12 hex of `sha256(canonicalDayPayload(row))` — **that one day's** plan payload, grade keys sorted, numbers normalized |

**Why threadId+uid and not the RFC-822 Message-ID.** `lib/gmail.ts`'s `FetchedEmail`
carries `uid` and `threadId` but no Message-ID header; adding one means changing the live
IMAP fetch, which cannot be tested against Gmail (and Gmail's connection budget on this
account is tight — see BUG-019). threadId+uid IS Gmail's message identity and has the
property rule 1 actually needs: **stable across re-fetches of the same message**.

**Why per-day and not per-workbook.** A one-day change must rewrite one row, not the whole
calendar. Renzo-only days deliberately exclude the message tag so a new Joseph email does
not churn the part of the calendar he never mentioned.

---

## 4. The six rules (`plan.ts::planScheduleUpstream`, PURE)

Evaluated per `plan_date`, in this order:

1. **Incoming `source_rev` already on the row — or already PARKED on it → write NOTHING.**
   Not a careful write; **no write at all**. This is the load-bearing rule: the old stage
   re-applied the same email every run, and that re-application was the clobber mechanism.
   In the steady state this stage now performs **zero writes**.
2. **`is_reported` → FROZEN.** Never written, whoever owns it. Also re-checked in SQL.
3. **`owner = 'human'` and the value DIFFERS → do not write the row.** Park the incoming
   value in `pending_upstream` and raise a run finding naming the date.
4. **`owner = 'human'` and the value EQUALS the current one → RECLAIM.** Clear
   `pending_upstream`, hand ownership back to the upstream owner. Reality caught up; not a
   conflict.
5. **A day the upstream no longer mentions is never named in an op → untouched.** Absence
   is never deletion (`fn_apply_schedule_upstream` has **no DELETE at all** — the flecon
   BUG-015 class of bug is structurally impossible here).
6. **Every planned write carries the `expected_row_version` and `expected_owner` it was
   planned against**, and the SQL re-checks both in the same statement as the write.

Field comparison (`changedPlanFields`) is tolerant of PostgREST round-trip noise: numerics
compare at 1e-6, `grades` compares as a sorted key/number set, `''` and `null` are the
same absence. That is what prevents phantom conflicts.

---

## 5. Atomicity — `fn_apply_schedule_upstream(p_ops jsonb)`

The planner's read of `view_production_schedule_state` is **advisory**. The truth is three
guards, all inside the WHERE of the statement that writes:

```
row_version = expected_row_version          -- optimistic concurrency
owner       = expected_owner                -- ownership cannot have flipped
NOT EXISTS (production_shifts on that date) -- actuals freeze
```

All three writes (insert / apply+reclaim / park) plus the outcome classification are **one
statement** built from data-modifying CTEs. There is no read-then-write anywhere. A row
that fails a guard is not written and comes back labelled:

| action | success outcome | refusal outcomes |
|---|---|---|
| `insert` | `inserted` | `frozen`, `exists` |
| `apply` | `applied` | `frozen`, `version_conflict`, `missing` |
| `reclaim` | `reclaimed` | `frozen`, `version_conflict`, `missing` |
| `park` | `parked` | `frozen`, `version_conflict`, `missing` |

`park` writes **only** `pending_upstream` (+ `row_version`). Every plan field stays exactly
as the human left it.

The counterpart `fn_save_schedule_day(plan_date, expected_row_version, patch,
clear_pending)` is the **in-app write path** (Phase B): it flips `owner` to `human`, stamps
`human_edited_at`/`human_edited_by = auth.uid()`, bumps `row_version`, and is subject to
the same version + freeze guards in its own UPDATE's WHERE. `p_clear_pending` defaults to
**false** — an unrelated edit must not silently discard a parked proposal.

---

## 6. What the operator sees

A parked day becomes:

- a row in **`view_production_schedule_conflicts`** (both sides, `pending_source_rev`,
  `changed_fields`, `human_edited_at`);
- a **`schedule_conflict` run finding** — `result.reconciliation.schedule_conflicts` →
  `lib/sync/cases-fold.ts::collectScheduleConflicts` →
  `lib/sync/findings.ts::fromScheduleConflict`, severity `attention`. **No new `HeldKind`**
  (that enum is frontend-locked); this is a reconciliation kind, like `block_diff` and
  `batch_closed`;
- a `warn` progress beat on the run: *"N day(s) you edited were left alone — Joseph's
  version is waiting for your decision."*

The digest's pending-conflict count is a head-count read:

```ts
supabase.from('view_production_schedule_conflicts')
        .select('plan_date', { count: 'exact', head: true })
```

served by the partial index `idx_production_schedule_pending_upstream`.

---

## 7. Files

| File | Role |
|---|---|
| `src/reports/prodSchedule/parse.ts` | PURE parse + merge (verbatim port of the two verified root scripts) |
| `src/reports/prodSchedule/plan.ts` | **PURE** — `source_rev`, field comparison, the six rules |
| `src/reports/prodSchedule/refresh.ts` | orchestration: download → merge → stamp → snapshot → plan → apply |
| `src/reports/prodSchedule/josephEmail.ts` | guarded IMAP fetch on **the shared session** (BUG-019); supplies `messageTag` |
| `src/lib/db.ts` | `readScheduleState` + `applyScheduleUpstream`. **`upsertProductionSchedule` was REMOVED** — nothing may write this table unconditionally again |
| `src/workflows/runSync.ts` | Stage 3c wrapper; folds conflicts into `result.reconciliation` |
| `test/reports/prodSchedule.test.ts` | the parse/merge port |
| `test/reports/prodSchedule-conditional.test.ts` | the six race conditions (26 tests) |
| `scripts/prod-schedule-proof.ts` | live end-to-end proof — also goes through the planner, so it cannot clobber either |
| `supabase/migrations/20260730060000_production_schedule_ownership.sql` | the schema + both RPCs + both views |

---

## 8. Notes for the next agent

- **Never reintroduce a blanket upsert on `production_schedule`.** If you need a bulk
  repair, write it as ops through `fn_apply_schedule_upstream`, or do it by hand in SQL
  with an explicit, reviewed statement.
- The first run after the migration re-stamps every row once (`source_rev` was NULL, and
  NULL never equals an incoming rev) — that is expected and happens exactly once.
- The stage has **no parity fixture** and is not part of `npm run parity`; it never had
  one, because it has no Python oracle (the root scripts were the spec, and they are
  already ported byte-for-byte and pinned by `prodSchedule.test.ts`).
- Phase B (the in-app editor) needs only: read `view_production_schedule_state`, call
  `fn_save_schedule_day` with the loaded `row_version`, and surface
  `view_production_schedule_conflicts`. The data layer is done.
