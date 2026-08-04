# 2026-08-04 — Sync corrections go live, the batch trigger is fixed, QC entry becomes a spreadsheet

## TL;DR

Worked the list Renzo triaged at the end of the 2026-08-03 session, plus four decisions he
made at the start of this one. **Eight items, three promotions to `main`, all deployed.**

The headline: **the production sync had never applied a single correction.** Not "rarely" —
never. It looked for a field name no classifier has ever emitted, so every patch came out
empty, every op was skipped, and the run reported success. It is now switched on, with tests
that fail against the old code.

Two latent faults were found while fixing other things, and both would have fired on the
first live run of something else: a **phantom `remarks` column** on downtime that would have
made the database refuse whole downtime updates, and a **third instance of BUG-017** where
editing a delivery's weight recomputed the batch to the number it already had.

Also: the QC add-draw composer Renzo disliked was deleted and rebuilt as spreadsheet rows.

---

## What shipped (all merged to `main`, all deployed)

| Merge | What |
|---|---|
| `8ff1c77` | Production correction apply fix, staleness alert, BUG-017 + BUG-018 |
| `566d68a` | QC ledger opens a month with no receipts |
| `478b0c0` | QC add-draw → spreadsheet entry rows |

### The dormant writer (production sync)
`workers/sync/src/reports/production/apply.ts` built its patch by looking for a `new` key.
`runs`/`downtime`/`waste` emit `{field:{db,email}}`; `electricity`/`trucks` emit
`[{field,emailValue,dbValue}]`. **Neither has ever carried `new`.** Patch always `{}`, op
always skipped, `updates` always 0. Now built from `changedFields()` — the same normalizer
the refusal findings already used, which understands both shapes and drops the generated
columns in one place.

**The landmine found while fixing it.** `downtimeFieldDiff` compared a `remarks` field, but
**`production_downtime` has no `remarks` column**. The extractor builds one
(`"Time ranges: …"`), the insert path drops it, so the DB side was permanently absent —
every downtime row with time ranges was a self-renewing phantom `VALUE_CHANGED`. Harmless
while dormant. On the first live run it would have put a non-allowlisted key in the patch,
and `fn_apply_production_upstream` refuses the **whole op** on one unknown key
(`unsupported_field`) — taking that row's real `dt_hrs`/`dt_mins`/`dt_reason` corrections
with it. Removed from the differ and from `DowntimeDbRow`.

Cover: `test/reports/production-value-changed-patch.test.ts` — real classifier output, no
hand-shaped fixtures, plus a mirror of the RPC's allowlist asserting no classifier can emit
a key the RPC would refuse. **5 of its 8 tests fail against the old builder** (verified by
reverting).

### Staleness alert (Stage 3e)
`view_digest_stream_status.missed_working_days` had been computed since 2026-08-03 and
**nothing read it**. Now `workers/sync/src/lib/streamStaleness.ts` → a `stale_stream` run
finding. The lateness arithmetic is NOT reimplemented — rest days and not-yet-due next-day
reports are already excluded in SQL, so the threshold is a bare `> 0`; `>= 3` escalates to
`high`. An unreadable count is treated as NOT stale on purpose: an alert that cries wolf is
an alert that gets ignored. Non-fatal by contract — a watchdog that can fail the thing it
watches is worse than no watchdog.

### BUG-017 + BUG-018 — one migration (`20260804060000`, applied live)
`tr_blackwood_delivery` was a **BEFORE** trigger whose branches recompute from `deliveries`,
so every recompute read a table that disagreed with the write about to happen. Now **AFTER**,
with all branches sharing one idempotent `fn_recompute_batch_state(batch_code)`.

- **Third instance, never named in the ledger:** the `cost_basis`/`weight_kg` UPDATE branch
  re-read the row's OLD values, so **editing a delivery's weight recomputed the batch to
  the number it already had.**
- **BUG-018 — Renzo chose delivery-weighted.** `SUM(cost_basis × weight_kg) / SUM(weight_kg)`,
  consumption ignored — the definition every other price surface already recomputes.
  **216 of 693** batches disagreed, 61 by more than half a centavo, worst ₱65.65/kg. All 693
  recomputed; **0 differ** after the column's own `numeric(12,2)` rounding.
- **Zero weight drift** existed beforehand, so no weights moved.
- Proven live then rolled back: a 10,695 kg move now moves BOTH batches exactly; a +1,000 kg
  weight edit now actually moves the batch.
- **Deliberately out of scope:** `quality_stats` has the same shape of problem (weighted by
  a consumption-net `current_weight`, only maintained on INSERT). Left byte-identical. It is
  the obvious next candidate.

### Changeover downtime, split
`splitChangeoverDowntime()` in `extractMc.ts`. Apportioned by each batch's same-day `ttl_kg`.
`dt_hrs`/`dt_mins` split; **`shift_hrs` does not** — both batches ran inside the same physical
shift and its length is not a share either owns. `dt_reason` copied verbatim (annotating it
would make every future run see a VALUE_CHANGED forever). **Conservation is exact** — the
second part is `total − first`, never re-rounded. Falls back to one row when either batch
produced nothing. **No backfill needed:** the only changeover on record (2026-08-01) carried
0 minutes.

### Net Flow anchored to the last complete day
`DERIVED_KPI_INPUTS` + `resolveCompleteThroughDate` / `resolveCompletePrevDate` in
`lib/digest/day-status.ts`. Anchors to `min(rc_in.through, rc_out.through)` — valid because
`through_date` is a high-water mark, so the earliest is the latest date none can still change.
The previous comparison day is the BINDING (furthest-behind) stream's `prevReportedDate`, not
one calendar day back (which lands on a rest day half the time). Carries the standard
`AsOfChip` only when the anchor trails today. Verified live: both streams through Aug 3 →
**−21,726 kg** (10,695 in − 32,421 out) against Aug 1's +22,038, no chip.

### QC ledger — empty months, then spreadsheet entry
`resolveQcMonth` accepts any well-formed `?m=YYYY-MM` (`isValidMonthKey` still rejects
`?m=banana` / `?m=2026-13`); the picker no longer disables empty months and always offers the
current year. `monthKeys` deliberately still means "months that HAVE receipts" — padding it
would make the `· no data` suffix lie.

Then the rebuild. Renzo, on the panel shipped the day before: *"I don't like it in general.
When we do add draw, it should create 10 new empty rows underneath the latest row… act like
an excel sheet."* `add-draw-panel.tsx` (955 lines) **deleted**; `qc/draw-entry-rows.tsx` is
the replacement.

- `Add draw` → 10 blanks in a trailing block; `10 more rows` adds another 10; a day header's
  `+ ADD` puts one blank INSIDE that day.
- **`anchorDate` is fixed at creation, NOT `recvDate`** — the date is typable, so keying
  layout off it would make a row jump blocks between two keystrokes of retyping it.
- **Three new columns because the RPC requires them:** `Mach` (a draw cannot be saved without
  `partner_equipment_code`, and there was no column at all), `Bags`, `Side`. 12 → 15 columns,
  min-width 1,146px. **`LABEL_SPAN` is now derived** from `COLS`, so it can never drift again.
- `PLANT` stays derived and un-typable (for a tank draw the plant IS the sample group's
  warehouse key — a wrong one files the row into a phantom group).
- `addQcDraws` is a **loop over `addPartnerDraw`, not a second RPC**, run **sequentially**
  because the RPC resolves the running batch from rows already logged; parallel would
  misresolve on a changeover day.
- Untouched blanks are never errors; a refusal keeps what was typed; a `duplicate_warning`
  re-sends confirmed on the next Save.

---

## Critical learnings

1. **A writer that silently no-ops reports success.** The production sync ran green for its
   whole life while applying nothing. Any code path whose failure mode is "wrote nothing"
   needs a test that asserts it wrote SOMETHING, from real upstream output — not a fixture
   hand-shaped to reach the code.
2. **Test fixtures that work around a bug hide it.** `production-human-edit.test.ts` injected
   a synthetic `new` key *specifically* so the dormant write path would be reachable, with a
   comment saying so. The workaround was documented and the bug still survived weeks.
3. **A BEFORE trigger that recomputes from its own table is always wrong.** Three separate
   bugs (BUG-016a, BUG-017, and the unnamed weight-edit case) with one cause. If a trigger
   aggregates the table it fires on, it belongs AFTER.
4. **Check the column exists before diffing it.** `production_downtime.remarks` was compared
   for months against a column that has never existed. The file header even said
   "(NO remarks col)".
5. **`git add .` is unsafe when two sessions share a repo.** A concurrent session's in-flight
   RC-Deliveries work got swept onto `main` in the first promotion. By the third it was
   staged path-by-path instead — see below.
6. **`git checkout main` does not remove untracked files.** Building "on main" in the working
   tree still compiles another session's files. The guardian caught this and built a detached
   worktree at the merge commit instead, which is what Vercel actually builds.

---

## Current state

- `main` = `478b0c0`. Worker tests **674 passing** (was 647). App builds clean from the
  committed tree.
- Migration `20260804060000` applied live; repo matches production.
- All five report streams current through 2026-08-03, 0 missed working days.

### ⚠️ Open loose ends

1. **`app/(app)/cenapro/CONTEXT.md` is written but UNCOMMITTED.** It carries my QC
   spreadsheet-entry docs AND another session's in-flight RC-Deliveries docs. Committing it
   would have shipped documentation of tables that do not exist on `main`. **Commit it once
   their work lands.** The QC code is already on `main` without its doc update — deliberate,
   and said so in the commit body.
2. **Two files from the other work line are on `main` from the first promotion:**
   `lib/cenapro/rc-formula.ts` and `scripts/verify-rc-formula.ts`. **Nothing imports them**,
   so there is no build or runtime risk — but their migration never went with them. Revert
   `cf32462` if that half-state is unwanted.
3. **A concurrent session is actively editing this repo** (`app/(app)/cenapro/deliveries/`,
   `scripts/cenapro/`, two `20260804*` migrations, `types/supabase.ts`, `CLAUDE.md`). Its
   `deliveries/actions.ts:140` does not compile. Do not stage it, do not "fix" it.

---

## Next concrete action

1. **Watch the first sync run after this deploy.** It is the first time the production
   correction writer has ever executed. The human-edit latch is underneath it, so anything
   Renzo corrected by hand is protected — but nothing has exercised the five-section writer
   in production before.
2. **Renzo tests the QC spreadsheet entry on the live app** — typing a real partner draw
   end to end. It has been type-checked and linted but never driven in a browser (the route
   is auth-gated and the in-app browser has no session).
3. Commit the owed `cenapro/CONTEXT.md` once the RC-Deliveries session lands.
4. `quality_stats` is the next `fn_update_blackwood_state` candidate — same shape as BUG-018,
   deliberately left alone.
