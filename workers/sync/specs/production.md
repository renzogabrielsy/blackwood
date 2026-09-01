# production.md — Daily Production Report (MC) + WASTE PRODUCTION REPORT (Ivy) → 6 tables

Scripts: `extract_daily_production.py` (848 lines), `extract_waste_production.py` (394 lines),
`classify_production_runs.py` (346), `classify_production_downtime.py` (278),
`classify_production_waste.py` (281), `classify_electricity.py` (289), `classify_trucks.py` (289),
`reconcile_production.py` (331), `sync_production.py` (476).

Read SHARED.md first. This is the most complex pipeline: TWO source emails feed FOUR
child-table extractors off a shared PARENT (`production_shifts`) plus TWO independent
natural-key tables (`electricity_readings`, `truck_readings`) with no shift relationship at all.

---

## 1. Pipeline narrative (`sync_production.py`)

1. **Watermark**: `watermark = data_watermark(db, "production_shifts")`. `since = watermark` if present else `"2025-01-01"` — **NOTE: `since` here is NOT offset by any tail-scope days** (unlike deliveries/rc_out's `-3d`), because both extractors treat `--since` as EXCLUSIVE (`> since`, not `>=`) — see extraction spec. `since_gmail = (watermark_date - 1 day)` (a 1-day-back Gmail search buffer, formatted `YYYY/MM/DD`) or `2025/01/01`.

   > **LIVE-WORKER DEVIATION (2026-07-14) — runs-frontier watermark.** The TS worker's `runReport` (`src/reports/production/index.ts`) no longer derives `since` from `data_watermark("production_shifts")`. `production_shifts` is written by BOTH sources: MC's DRIP Daily Production Report AND Ivy's CUMULATIVE monthly WASTE workbook (whose parent-shift upsert creates a shift row for every waste day of the month). Because waste runs ahead of MC, `MAX(production_shifts.transaction_date)` tracks the latest WASTE day, so feeding it back as the EXCLUSIVE `since` made `extractMc` silently drop every MC day-sheet `<=` it — MC's runs/downtime/electricity/trucks stalled with no error the moment waste passed MC's frontier (observed live: runs frozen at 2026-07-03 while waste ran to 2026-07-13). The worker now calls **`db.productionRunsFrontier()`** = `MAX(production_shifts.transaction_date)` among shifts that HAVE a `production_runs` child (`production_runs` is MC-only), mirroring the `view_digest_stream_freshness` production branch (migration `20260714000000`). **This is orchestrator-level only and does NOT affect parity**: the frozen `classifyCase` entrypoint receives `opts.since` as a FIXED fixture input, so parity is unchanged. The **Python oracle keeps the `data_watermark` behavior documented above** — it stays the parity ground truth and needs no change (parity supplies `since` explicitly); mirror the runs-frontier into `sync_production.py:90-91` only if the Python is ever revived as a live path. Regression: `test/reports/production-watermark.test.ts`.
2. **Fetch MC** (Daily Production Report): `from:mccontinedo.ictc@gmail.com subject:"Daily Production Report" after:{since_gmail} -label:"Blackwood-Processed"`.
3. **Fetch Ivy** (WASTE PRODUCTION REPORT): `from:edilloivymae306ictc@gmail.com subject:"WASTE PRODUCTION REPORT" after:{since_gmail} -label:"Blackwood-Processed"`.

   > **LIVE-WORKER DEVIATION (2026-08-29, L-045) — THE SENDER IS A ROSTER.** Both `from:`
   > clauses above are now the whole ICTC roster (`rosterFrom()` from
   > `src/lib/senderRoster.ts`), not one person. **This report is where the incident
   > happened:** MC was out, Ivy sent his Daily Production Report on 2026-08-28 and
   > 2026-08-29, the single-sender query could not see either, and because runs, downtime,
   > electricity and trucks all ride in that one workbook, three streams went stale at once
   > while the reports sat unlabelled in the inbox. The `subject:` predicates are what
   > identify these two reports and are byte-identical; `after:` and the
   > `-label:"Blackwood-Processed"` idempotency guard are untouched; the extractors' own
   > structural validation is unchanged, so a wrong workbook from a roster address still
   > fails loudly. Full rationale and the roster table: **SHARED.md §1.2a**. Parity is
   > unaffected — the frozen `classifyCase` entrypoint never sees a Gmail query.
4. If NEITHER xlsx found → early-return `ok:true`, empty `classified_path`. **If only ONE of the two is found, the pipeline proceeds with an empty extract for the missing side** (`mc = {"runs":[],"downtime":[],"electricity":[],"trucks":[]}` or `ivy = {"waste":[]}`) — runs/downtime/electricity/trucks and waste are classified INDEPENDENTLY even if only one source email arrived this run.
5. **Extract**: `extract_daily_production.py --file {mc_xlsx} --year {int(since[:4])} --all-sheets --since {since}` (if mc_xlsx present); `extract_waste_production.py --file {ivy_xlsx} --all-sheets --since {since}` (if ivy_xlsx present). Both extractors apply the `--since` filter THEMSELVES (see extraction spec) — the orchestrator does no additional Python-side date filtering (unlike deliveries).
6. **Per-section extract files**: writes each of `mc["runs"]`, `mc["downtime"]`, `mc["electricity"]`, `mc["trucks"]`, `ivy["waste"]` to its own `{"rows": [...]}` JSON file (the classifiers expect this key name, NOT the extractor's own top-level key names).
7. **DB window for shifts + children**: `all_dates` = every `transaction_date` from `mc.runs + mc.downtime + ivy.waste` (NOTE: electricity/trucks dates are NOT included in computing this window, since they don't relate to shifts). `lo = min(all_dates) - 3 days`, `hi = max(all_dates) + 3 days` (a padding window on BOTH sides, unlike other pipelines' one-sided tail). If `all_dates` is empty, `lo = hi = since`.
8. **Fetch shifts**: `db.read_rows("production_shifts", since_date=lo, columns=[id, transaction_date, production_batch, shift])`, then Python-filters `<= hi` (the DB read only supports a lower bound via `since_date`; the upper bound is applied client-side).
9. **Fetch children, denormalized**: `_child_db(table, extra_cols)` (sync_production.py:159-171) reads the child table with NO date filter at all (`since_column=None` — fetches EVERY row in the table, not scoped to the window!), then JOINS each child row to its parent shift (via `shift_by_id` lookup built from step 8's ALREADY-windowed shifts) and DROPS any child whose `shift_id` doesn't resolve to a shift in that window (`if not sh: continue`). **This means the child-row fetch is effectively windowed only by transitivity through the shift window, not by its own date filter** — a TS port must replicate "fetch ALL child rows, then filter by joining to the pre-windowed shift set" rather than trying to push a date filter directly onto the child table (which has no `transaction_date` column of its own).
10. **Electricity + truck DB rows**: fetched independently with their OWN `since_date=lo` filter on `reading_date` (these tables DO have their own date column, unlike shift children) — no upper-bound filtering applied here (unlike shifts).
11. **Classify each of the 5 sections** independently via their respective classifier scripts.
12. **Informational reconcile** (best-effort, wrapped in try/except that only logs on failure — never raises): `reconcile_production.py --prod-extract-json {mc file} [--waste-extract-json {ivy file}] --output {report}`. NO `--strict` flag passed — this reconciler's exit code is therefore ALWAYS 0 regardless of content (see gates section).
13. Emit classify envelope with `counts` aggregated across ALL 5 sections' classifications, `codified_rules_applied` listing L-007/L-014/L-025/L-026/L-027/L-028.

### Apply phase (`phase_apply`, sync_production.py:269-455) — FK-safe write order

1. **Collect distinct shift triplets needing upsert**: scan `runs`+`downtime`+`waste` sections for any `NEW` classification carrying `needs_shift_upsert=true`; dedupe by `(transaction_date, production_batch.upper(), shift.upper())`.
2. **Upsert each shift FIRST**, before any child write: `db.insert_if_absent("production_shifts", [payload], natural_key=(transaction_date, production_batch, shift))`. If the insert returns nothing (row already existed — a race with a concurrent process, or the classify-time shift-map was stale), falls back to `db.select_one` to find the existing row's id. Builds `shift_map: {triplet: shift_id}` for use by children.
3. **L-026 combine**: before inserting `production_runs`, groups all `NEW` run classifications by `(resolved_shift_id, customer.upper(), grade.upper())` — for any group with MORE than one row, SUMS `ttl_kg` and `sacks_bags`, and joins `remarks` with `"; "` (`filter(None, [...])` drops falsy remarks before joining) — see rule checklist for the exact combine algorithm.
4. Insert combined `production_runs` rows via `insert_if_absent(natural_key=(shift_id, customer, grade))`.
5. Insert `production_downtime` (cols: `shift_hrs, dt_hrs, dt_mins, dt_reason` — **NO remarks column** on this table, despite the extractor producing a `remarks` field for time-ranges; that field is simply DROPPED at apply time, never written) and `production_waste` (cols: 8 waste streams + `remarks`) via `insert_if_absent(natural_key=("shift_id",))`.
6. Insert `electricity_readings` and `truck_readings` (natural-key tables, no shift FK) — **never writes the DB-generated columns** `diff_kwh`/`consumption_kwh`/`ttl_km` (these are Postgres `GENERATED ALWAYS AS` columns; writing them would be rejected by Postgres anyway, but the code explicitly excludes them from the payload column list rather than relying on that rejection).
7. VALUE_CHANGED rows (ALL 5 sections) → `db.update(table_for[section], {"id": eq}, patch)`, where `patch` strips any of `{diff_kwh, consumption_kwh, ttl_km}` defensively even on an UPDATE diff (belt-and-suspenders — a VALUE_CHANGED diff should never legitimately contain a generated column, since the classifiers never compare them, but the strip is unconditional).
8. MALFORMED (any section) → always `held`.
9. Watermark + label only if `not errors`; labels BOTH MC and Ivy UIDs together in one `mark_processed([mc_uid, ivy_uid])` call if both are present (falsy-filtered first) — a SINGLE labeling call covering both source threads, not two separate calls.

---

## 2. Extraction spec — MC's Daily Production Report (`extract_daily_production.py`)

### Sheet anatomy

One sheet per production DAY, title format `"MM-DD-YY"` (tolerates heavy surrounding whitespace — `SHEET_NAME_RE = r"^(\d{1,2})-(\d{1,2})-(\d{2,4})$"` matched against `sheet_name.strip()`). **`transaction_date` is the SHEET TITLE's date, NOT any in-sheet header cell** (the module docstring explicitly warns: sheet `"05-27-26"` has an in-sheet D4 header reading `"MAY 28, 2026"` — that is the NEXT MORNING's write-up date and must be ignored).

2-digit year → `2000 + yy` unless `--year` override forces the century (`parse_sheet_date`, extract_daily_production.py:225-246).

### `--since` filtering — SHEET-LEVEL, exclusive (`resolve_sheets`, lines 688-736)

Applied to the SELECTED sheet list, not per-row: keep sheets whose parsed title-date is `> since` (strictly greater — exclusive) OR whose title fails to parse at all (kept so the parse-failure warning still surfaces; such a sheet contributes zero dated records anyway). **This is a sheet-level filter, unlike waste's row-level filter** — because every record type on a day-sheet (runs/downtime/electricity/trucks) shares that ONE sheet-title date, filtering at the sheet level is equivalent to filtering every record, and is cheaper.

### Section A — `production_runs` (fixed cell coordinates, verified against real sheets)

| Coordinate | Meaning |
|---|---|
| Row 7 | header row (not parsed for data) |
| Rows 8-12 | run data rows |
| Col D (4) | grade cell, e.g. `"CEBU 3X50"` |
| Col E (5) | sacks/bags |
| Col F (6) | kilos-per-sack (not directly stored) |
| Col G (7) | TOTAL kg (`ttl_kg`) |
| Col H (8) | shift label |
| Row 13, Col C / Col G | `"TOTAL"` reconciliation label / day total (`day_total_g13`) |

**`route_grade(raw_grade)` verbatim algorithm** (extract_daily_production.py:328-361):
```
text = raw_grade.strip().upper()
tokens = text.split()
if len(tokens) == 1:
    grade = tokens[0]
    return ("CEBU", grade, True) if grade in VALID_GRADES else (None, None, False)
grade = tokens[-1]              # LAST token is the candidate grade
customer = " ".join(tokens[:-1]) # everything before it is the customer
if grade in VALID_GRADES: return (customer, grade, True)
return (None, None, False)
```
`VALID_GRADES = {"3X50", "6X50", "8X50", "2X6", "4X8"}` (extract_daily_production.py:79 — L-027, must stay in lockstep with the identical set in `classify_production_runs.py` AND the `production_runs_grade_check` DB CHECK constraint; **any new grade requires updating all three in the same changeset**). A row whose trailing token isn't in `VALID_GRADES` is DROPPED (added to `dropped_grades`, never emitted) — e.g. `"KOREA POWDER (BAGGED)"`, `"LOCAL POWDER"`, `"ZAMBOANGA ..."`.

**Shift resolution (`resolve_run_shift`, L-025, lines 275-297) — verbatim**:
```
code, warn = normalize_shift(label)   # via SHIFT_LABEL_TO_CODE exact-match dict
if code is not None:
    return code, False, None          # explicit label, NOT defaulted
raw = coerce_str(label)
reason = "shift cell blank/absent — defaulted to Morning" if raw is None else
         f"unrecognized shift '{raw}' — defaulted to Morning"
return DEFAULT_RUN_SHIFT, True, reason   # DEFAULT_RUN_SHIFT = "M"
```
`SHIFT_LABEL_TO_CODE` (lines 83-91): `"MORNING SHIFT"`→M, `"MORNING"`→M, `"NIGHT SHIFT"`→E, `"NIGHT"`→E, `"EVENING SHIFT"`→E, `"EVENING"`→E, `"AFTERNOON SHIFT"`→E. **Exact-string-match against the whole cell value uppercased** — NOT a substring/contains check (unlike waste's shift normalizer, which DOES use substring matching — see §waste below, a genuine cross-file inconsistency).

> **TS PORT DEVIATION (2026-08-03, Renzo-approved) — column H is DUAL-PURPOSE.**
> The Python treats column H as "the shift cell" and nothing else, so the L-007 batch
> markers fell into the unrecognized branch. The TS port (`extractMc.ts::resolveRunShift`
> + `productionBatch.ts`) now DISCRIMINATES BY VALUE — never repurposing the column,
> which would break every overtime day. Verified against real sheets:
>
> | Sheet | Column H | Meaning |
> |---|---|---|
> | `07-23-26` | `DAY SHIFT`, `DAY SHIFT`, `OVERTIME`, `OVERTIME` | real shift labels |
> | `07-27-26` | *(blank)* | no label |
> | `08-01-26` | `ENDING`, `ENDING`, `STARTING` | batch-transition markers |
>
> Rules, in order:
> 1. a value in `SHIFT_LABEL_TO_CODE` → that shift, `_shift_defaulted=false`, no warning (unchanged);
> 2. `ENDING` / `STARTING` (trim + case tolerant) → **shift `M` by EXPLICIT DOMAIN RULE**
>    (markers only ever occur on the Morning shift — Renzo, 2026-08-03), `_shift_defaulted=false`,
>    **no warning, no default-note**, and the row carries a batch marker;
> 3. blank → Morning, defaulted, blank-cell warning (unchanged);
> 4. anything else → Morning, defaulted, unrecognized warning (unchanged — this is the
>    branch `DAY SHIFT`/`OVERTIME` take, and it is parity-frozen).
>
> Rule 2 is the ONLY behavioral change. No parity fixture workbook carries a marker, so
> `npm run parity` is unaffected.

A defaulted shift (blank/absent/unrecognized — **no longer including** `"STARTING"`/`"ENDING"`, see the deviation box above) appends the constant note `SHIFT_DEFAULT_NOTE = "shift defaulted to Morning (operator left blank)"` (line 112) into the run's `remarks` via `append_note(None, SHIFT_DEFAULT_NOTE)` — since a run's `remarks` has no other source, this is effectively always either exactly the note string or `None`. **This constant MUST stay byte-identical to the same-named constant in `classify_production_runs.py`** (both files' module comments say so explicitly) — the classifier strips this exact substring before diffing remarks so an already-written Morning row (from before this feature existed) doesn't perpetually re-diff as VALUE_CHANGED.

**MALFORMED-equivalent guards** (row-level warnings, NOT dropped by the extractor — deferred to classify_production_runs.py):
- `ttl_kg is None` → warning, row still emitted.
- `ttl_kg < 0` → warning, row still emitted.
- The classifier is where these ACTUALLY become MALFORMED (weight guard preserved — L-025 only removed the missing-shift MALFORMED reason, not the missing-weight one).

**G13 day-total** (extract_daily_production.py:427-437): trusted (`day_total = g13`) if `C13` (one column left of the grade column) reads exactly `"TOTAL"` after strip+upper; ELSE still falls back to using `g13` if it's non-null, but WITHOUT the trust confirmation (no distinct flag emitted either way — the value ends up in `day_totals[date]` regardless of whether the label matched).

### Section B — `production_downtime` (ONE aggregated row per day, always shift `"M"`)

Fixed coordinates: category = `C24`; time-ranges = `C27` (multiline, newline-split); minutes = `E27` (multiline, PARALLEL to the ranges — each line like `"9 MINUTES"`); reasons = `F27` (multiline).

**Minute parsing** (extract_daily_production.py:457-467): for each line in the minutes cell (split on newlines, blank lines dropped), strip everything except digits/dot via `re.sub(r"[^0-9.]", "", line)`, coerce to float, SUM across all lines. A line that fails to parse (no digits at all) adds a warning but does NOT stop accumulation of the other lines.

**Emission gate**: only emitted if `total_mins > 0` OR (`reasons` non-empty OR `category` non-empty) — i.e. a day with genuinely zero downtime and no category/reason text produces NO downtime row at all (returns `None`, not an empty-but-present row).

`dt_reason = " | ".join([category (if any), "; ".join(reasons) (if any)])` — category first, then all reason lines joined with `"; "`.

`remarks = "Time ranges: " + "; ".join(ranges)` if any ranges present, else `None`. **This `remarks` field is computed by the extractor but the `production_downtime` TABLE HAS NO `remarks` COLUMN** — it is silently dropped at apply time (see §sync_production apply, step 5 above). A TS port should still EXTRACT it (for potential future use / audit trail in the JSON) but must not attempt to write it to the DB.

Output shape: `{transaction_date, production_batch, shift:"M" (HARDCODED), shift_hrs:12 (HARDCODED default), dt_hrs:0, dt_mins: total_mins (NOT YET split into hrs/mins — see below), dt_reason, remarks, ...}`.

**L-014's `dt_mins >= 60` split rule is documented in the ledger but NOT implemented in `extract_daily_production.py`'s code** — the extractor emits `dt_hrs: 0` unconditionally and puts the FULL total minutes (which can exceed 60) into `dt_mins`. The DB constraint `CHECK (dt_mins >= 0 AND dt_mins < 60)` would REJECT any total ≥ 60 minutes at insert time. **Flag for a human decision**: L-014/L-007 describe this as a manual agent-applied split at classify/execute time ("the agent applies both at classify/execute time until extract_daily_production.py is patched"); verify whether `sync_production.py`'s apply phase does this split anywhere in the read code — **it does not appear to** (grep confirms no `dt_hrs`/`60` split logic in `sync_production.py`). This is a REAL, currently-unaddressed gap in the lean orchestrator (as opposed to the old manual-agent workflow) — a TS port must either implement the split explicitly during apply, or the port will hit the same `23514` CHECK violation the ledger describes whenever total downtime minutes reach 60+.

### Section C — `electricity_readings` (3 meters: MAIN, BUNKHOUSE, PUMP)

MAIN: `start_kwh=D54`, `end_kwh=E54`, `meter_multiplier=E60` (falls back to `DEFAULT_METER_MULTIPLIER=120.0` if E60 is blank). BUNKHOUSE (row 65) and PUMP (row 67): `start=col D`, `end=col E`, multiplier ALWAYS `None` passed in (so `_emit_electricity` applies the same 120.0 default internally regardless of meter).

**Emission gate** (`_emit_electricity`, lines 508-546): skip entirely (return `None`) if BOTH `start_kwh` and `end_kwh` are `None`, OR if both (treating `None` as `0`) are exactly `0`. Otherwise emit, with warnings for a missing single side or `end_kwh < start_kwh` (still emitted, just warned). **Never computes/emits `consumption_kwh`** — that's a DB-generated column.

### Section D — `truck_readings` (fixed rows 47, 49, 51 — up to 3 trucks)

Columns: plate=`C`, start_km=`D`, end_km=`E`, total_km=`F` (informational, not stored — `ttl_km` is DB-generated), liters=`H`, gauge_start=`J`, gauge_end=`K` (qualitative text, folded into `remarks`).

**Emission gate**: `moved = (start_km is not None and end_km is not None and end_km > start_km) or (ttl_km is not None and ttl_km > 0)`; `has_fuel = fuel is not None and fuel > 0`. Skip (fully idle row) if `not moved and not has_fuel`. A warning is added if the row moved/fueled but `plate` is blank.

`remarks` folds BOTH gauge readings if present: `"start fuel: {gauge_start}; arriving fuel: {gauge_end}"` (only the non-null half included if one is missing).

### `production_batch` — derived from the plant's RUNNING STATE, not the calendar

**Naming convention** (unchanged): FULL uppercase English month name for all 12 months
(`JANUARY`…`DECEMBER`), no abbreviation exceptions — canonical source is
`workers/sync/src/lib/months.ts`. **Do not confuse with rc_out's mostly-3-letter
convention (rc_out.md §2).**

> **TS PORT DEVIATION (2026-08-03, Renzo-approved) — the VALUE, not the naming.**
> The Python derived `production_batch = MONTH_NAME_UPPER[sheet_month]`. That is wrong
> twice over:
>
> 1. **Batches are not calendar months.** Verified from `production_shifts`, the sequence
>    is strict and unbroken but every batch starts in the PRIOR month and ends in the NEXT:
>
>    | Batch | First shift | Last shift |
>    |---|---|---|
>    | DECEMBER | 2025-11-27 | 2025-12-28 |
>    | JANUARY | 2026-01-02 | 2026-02-02 |
>    | FEBRUARY | 2026-02-02 | 2026-02-27 |
>    | MARCH | 2026-02-28 | 2026-03-30 |
>    | APRIL | 2026-03-30 | 2026-04-30 |
>    | MAY | 2026-04-30 | 2026-05-29 |
>    | JUNE | 2026-05-29 | 2026-06-30 |
>    | JULY | 2026-06-30 | 2026-07-31 |
>
>    A batch can also end EARLY inside its own month (Renzo, 2026-08-03), so "the previous
>    calendar month" is not a safe substitute either.
> 2. **On a changeover day two batches produce on the SAME date.** With one name for both,
>    the two same-grade rows collapse to ONE `(shift_id, customer, grade)` key and apply's
>    L-026 combine SUMS them into a single wrong row. (2026-08-01: `CEBU 3X50` 1,326 kg
>    ending JULY + `CEBU 3X50` 11,830 kg starting AUGUST would have become one 13,156 kg row.)
>
> **The rule** (`src/reports/production/productionBatch.ts`):
>
> | Row | `production_batch` |
> |---|---|
> | marked `ENDING` | the batch that was already running |
> | marked `STARTING` | the **next name in the month sequence** after the running batch (NOT the sheet's calendar month) |
> | unmarked | the batch that was already running |
> | downtime, ORDINARY day (carries no marker) | the batch that was already running |
> | downtime, CHANGEOVER day | **SPLIT across both batches by same-day output** (2026-08-04) |
>
> **Changeover downtime — apportioned, not dumped (2026-08-04, Renzo's decision).**
> MC records downtime ONCE for the whole shift with no marker saying whose it is. On a
> changeover day that single answer is wrong for one of the two batches, and the old rule
> ("an unmarked fact follows the running batch") put the entire stoppage on the batch that
> was ENDING — making every new batch look flawless on its first day and every old one
> look worse than it was. `splitChangeoverDowntime()` (`extractMc.ts`) now emits TWO
> downtime rows, apportioned by each batch's `ttl_kg` on that date.
>
> - **`dt_hrs` + `dt_mins` are split; `shift_hrs` is NOT.** Both batches ran inside the
>   same physical shift, and its length is a fact about the shift, not a share either
>   batch owns.
> - **`dt_reason` is copied verbatim** to both rows. Annotating it ("split across…")
>   would make the classifier see a VALUE_CHANGED against the stored text on every
>   future run, forever.
> - **Conservation is exact.** The second part is `total − first`, never independently
>   rounded, so the two rows always sum back to the minutes MC wrote down. Each part is
>   then PD-5 re-normalized (`hrs += mins/60; mins %= 60`) to satisfy
>   `CHECK (dt_mins >= 0 AND dt_mins < 60)`.
> - **Falls back to ONE row whenever a split would be a guess** — no changeover, zero
>   downtime, or either batch produced nothing measurable. A proportional split against a
>   zero denominator is not a split, it is an invention; the row stays whole and a warning
>   says so.
> - No backfill was needed: the only changeover on record (2026-08-01) carried **0 minutes**
>   of downtime, so the new rule is a no-op there.
>
> The running batch is SEEDED from the DB — `resolveRunningBatch()` over
> `production_shifts` at or below the `since` floor (which, since `since` is sheet-level
> EXCLUSIVE, is strictly before every sheet the run reads) — and then FOLDED FORWARD
> across the run's sheets **in date order**, so a changeover mid-run carries into the
> following days. The emission order stays the WORKBOOK's own order (the sort is on a copy),
> so the parity-critical row order never moves. A changeover day that carries two batches
> (e.g. 2026-06-30 = JUNE + JULY) is disambiguated by first-seen date: the RUNNING batch is
> the one that STARTED most recently.
>
> **A `STARTING` on a dropped grade never advances the batch** — the marker scan applies the
> same `route_grade` allowlist gate as the emitter (L-027).
>
> **COLD START (no prior batch on record).** The running batch falls back to the sheet's own
> CALENDAR MONTH — exactly the pre-fix derivation — and the date is reported in
> `McExtract.batch.coldStartDates` (a `warn` progress line on a live run). On a cold-start
> sheet that ALSO carries a `STARTING`, the fallback names the NEW batch and the closing
> batch becomes the PRECEDING month, so the two still resolve to different batches and the
> changeover collision cannot reappear. Both are explicit, reported guesses — **nothing is
> guessed silently**. The frozen parity entrypoint `classifyCase` runs this path (it does not
> read a seed unless a caller passes `opts.runningBatch`), which is why every fixture keeps
> reproducing the Python byte-for-byte.
>
> **KNOWN RISK (accepted, not mitigated here).** Only a `STARTING` marker advances the batch.
> If MC ever changes over WITHOUT marking it — as happened on 2026-06-30, before the marker
> convention — the sync keeps filing under the old batch instead of silently guessing a new
> one. That is the intended trade-off (no silent auto-resolution, per CLAUDE.md → Sync
> Integrity), and it surfaces as production piling into a stale batch rather than as an error.
>
> **A new batch is ANNOUNCED, never assumed.** The batch NAME appears NOWHERE in the workbook
> (every cell searched). Each changeover therefore emits a `production_batch_started` run
> finding — new batch, date, batch it follows, and how the name was derived — carried on
> `apply.production_batch_starts` and surfaced by `lib/sync/findings.ts` at severity
> `attention`. It is NOT a held row (the rows DID write) and NOT a `HeldKind` (that enum is
> frontend-locked). It is suppressed once the (date, new batch) shift already carries
> production RUNS — a shift that exists with only WASTE does not suppress it, because Ivy's
> cumulative workbook opens such a parent on its own.

### Overall confidence

Mean of `run.confidence` values ONLY (`confs = [r["confidence"] for r in all_runs if r.get("confidence") is not None]`) — downtime/electricity/truck rows have no `confidence` field at all and don't factor into this number. Defaults to `1.0` if there are zero runs (not `0.0`, unlike other extractors' zero-row fallback).

---

## 3. Extraction spec — Ivy's WASTE PRODUCTION REPORT (`extract_waste_production.py`)

### Sheet anatomy

One sheet per MONTH, title `"MONTHNAME YYYY"` (tolerates a leading space, e.g. `" APRIL 2026"` — `SHEET_NAME_RE = r"^\s*([A-Za-z]+)\s+(\d{4})\s*$"`). Header spans rows 2-4; data starts row 5 (`DATA_START_ROW = 5`).

### Column map (VERBATIM — positional, NOT header-signature-driven, unlike flecon)

| Ivy header | KLS value col | Schema field | SACKS col (dropped) |
|---|---|---|---|
| R.S. #1 DUST (RS 1A) | C (3) | `rs1a_kg` | B |
| RS 1B | E (5) | `rs1b_kg` | D |
| FILTER | G (7) | `bf_kg` | F |
| RS 2&3 | I (9) | `rs23_kg` | H |
| R.S. 5 | K (11) | `rs5_kg` | J |
| UNCOOKED/SHELL | M (13) | `trml1_kg` | L |
| STONES | O (15) | `trml2_kg` | N |
| GRIT | Q (17) | `grit_kg` | P |

Plus: `A` (1) = date; `R` (18) = TOTAL WASTE reported (`ttl_waste_kg_reported` — reconciliation-only, NEVER stored in `production_waste`); `S` (19) = buyer note → `remarks`; `V` (22) = shift label (present only on dual-shift days).

**The 8 SACKS columns (B/D/F/H/J/L/N/P) are INTENTIONALLY DROPPED** — `production_waste` has no sacks columns at all.

### Row validity (`--since` is ROW-level here, unlike production's sheet-level)

A row without a parseable date in column A is skipped SILENTLY (drops both the bottom column-SUM footer row and trailing 0-stub rows) — this is a stricter per-row check than production's sheet-level filter, because waste sheets are MONTHLY (one tab per month) while individual ROWS can be carryovers from an adjacent month.

`--since` (exclusive, same semantics as production): `if since is not None and txn_date <= since: continue` (row-level skip, silent — no warning).

**Carryover detection**: `if txn_date.month != sheet_month: row_warnings.append(...)` — the row is STILL EXTRACTED with its TRUE date (never suppressed), just flagged with a note. This is the L-028 scenario (a July-tab row dated June 30).

> **TS PORT DEVIATION (2026-09-01, L-046) — the note no longer implies wrongness.** It still
> fires on exactly the same condition and the date is still the row's true date, but it now
> says where the row was FILED — `"Carryover date 2026-06-30 in sheet 'JULY 2026' (sheet
> month=07) — kept its true date and filed under the JULY batch (the tab names the batch)"`.
> A carryover row is the CHANGEOVER SIGNAL (see the batch box below), not a defect, and a
> note read by an operator must not describe a correct row as a problem.

### Waste stream coercion

Each of the 8 streams: `coerce_float(cell) or 0.0` — **missing cells become `0.0`, matching the schema's `NOT NULL DEFAULT 0`** (unlike most other extractors, which leave missing numeric fields as `None`). Negative values are flagged with a warning but the value is still emitted as-is (not clamped to zero).

### Shift normalization (`normalize_shift`, VERBATIM — SUBSTRING match, unlike production's exact match)

```
s = coerce_str(value)
if s is None: return "M"
up = s.upper()
if "MORNING" in up: return "M"
if "EVENING" in up: return "E"
if "NIGHT" in up: return "E"     # defensive: MC's "NIGHT SHIFT" is the same 2nd shift
return "M"                        # any other unrecognized text also defaults to M
```
**Contrast with `extract_daily_production.py`'s `normalize_shift`, which does an EXACT dict-key lookup against the FULL uppercased string** — waste's version does a SUBSTRING `in` check. This means e.g. a waste-sheet cell reading `"MORNING (PARTIAL)"` would resolve to `"M"` via substring match, while the SAME text on a production-runs sheet would fail the exact-match lookup and fall through to the DEFAULT_RUN_SHIFT="M" anyway via a DIFFERENT code path (unrecognized → defaulted). **The net result (both land on M) happens to coincide for this specific example, but the two functions are NOT interchangeable in general** — a TS port must keep them as two separate functions, not accidentally unify them.

### Reconciliation self-check (extractor-internal, NOT the same as `reconcile_production.py`'s check)

For every extracted row: `summed = round(sum(8 streams), 4)`. Compared against `ttl_waste_kg_reported` (col R) with `RECON_TOLERANCE_KG = 1.0`. Mismatches (including `reported is None`) are collected into `summary.recon_mismatches` — this is purely an internal extractor sanity check surfaced in the JSON; `reconcile_production.py`'s "waste internal" check (see §4 below) RE-SURFACES this exact same list rather than recomputing it.

### `production_batch` (waste's own convention — matches production's, NOT rc_out's)

`NUM_TO_MONTH_NAME[txn_date.month]` — full uppercase month name, derived from the ROW's actual date (which may differ from the sheet's month, per carryover rows).

> **TS PORT DEVIATION (2026-09-01, Renzo-approved) — THE TAB IS THE BATCH (L-046).**
> `extractIvy.ts` derives `production_batch` from the **SHEET (tab) month**, never from the
> row date's calendar month. This is the SAME defect `productionBatch.ts` fixed on MC's side
> on 2026-08-03 (§2 above), one file over — **the calendar is not the batch** — and it is the
> third instance of that confusion (MC runs 2026-08-03; MC changeover downtime 2026-08-04;
> waste, here).
>
> **Why the tab is authoritative.** Ivy files each BATCH's waste in that batch's own tab. So a
> carryover date in the NEXT tab is not an operator slip — **it IS the changeover signal**,
> exactly as `ENDING`/`STARTING` in column H are on the runs side, and it is the only such
> signal Ivy's workbook carries. It is also the reason the L-028 rule below is stated as "must
> resolve to a DISTINCT shift": that rule was always right, and the date-derived batch was
> what prevented it from holding.
>
> **What it cost, measured (run `6649d16f`, 2026-09-01).** Renzo closed AUGUST and opened
> SEPTEMBER on the same day, 2026-08-29, after emptying the tank. Ivy's workbook therefore
> carries that date twice with DIFFERENT figures:
>
> | Tab | Row | rs1a / rs1b / bf / rs23 / rs5 / trml1 / trml2 / grit | TOTAL |
> |---|---|---|---|
> | `AUGUST 2026` | 27 | 550 / 550 / 50 / 196 / 97 / 50 / 0.5 / 16 | 1,509.5 |
> | `SEPTEMBER 2026` | 5 | 550 / 550 / 100 / 179 / 74 / 55 / 0.5 / 20 | 1,528.5 |
>
> Both were stamped `AUGUST`, so both keyed to ONE `(2026-08-29, AUGUST, M)` triplet and one
> `shift_id`; `production_waste`'s `UNIQUE(shift_id)` admitted the first and HELD the second
> `already_exists`. **That row could never self-heal** — `--since` is row-level and exclusive
> (`txnIso <= since -> skip`) and the watermark had already passed 2026-08-29 — so it needed a
> one-time repair (below).
>
> **And the fixture corpus shows the worse variant.** In `production_real_latest` the
> 2026-06-30 row on the `JULY 2026` tab resolved to JUNE's 2026-06-30 shift and classified
> **VALUE_CHANGED against JUNE's stored waste row** — one batch's waste proposed as a silent
> OVERWRITE of another's. Under the fix it resolves to the (already existing) JULY 2026-06-30
> shift instead.
>
> **`transaction_date` is untouched** — still the true date the operator wrote. Only the batch
> the row is FILED under follows the tab. Nothing downstream needed a special case: the
> classifiers already key on the `(date, batch, shift)` triplet, apply already upserts one
> parent per distinct triplet, and `reconcile.ts`'s per-DATE waste total already SUMS every row
> on a date (`wasteByDate`), so a two-batch day totals correctly with no change.
>
> **Parity deviates by construction and is registered.** The Python oracle
> (`extract_waste_production.py`) keeps the calendar derivation and is NOT edited — it stays
> the parity ground truth. `test/parity/expected-deviations.json` carries rule `L-046` for
> `production_real_latest` at `/waste/classifications/**`; all 56 diffs are under that path
> (runs/downtime/electricity/trucks byte-identical), the `/waste/summary` counts are unchanged,
> and most are positional (the canonicalizer sorts classifications by `natural_key.shift_id`).
> Tests: `test/reports/production.test.ts` → `describe("L-046 — the TAB is the batch …")`,
> reproducing the real two-tab 2026-08-29 shape; 4 of its 6 cases fail against the old
> derivation.

---

## 4. Classification spec (5 classifiers, shift-resolution shared pattern)

### Shared shift-resolution pattern (identical `build_shift_map` in all 3 shift-dependent classifiers: runs, downtime, waste)

```
key = (transaction_date, norm_key_part(production_batch), norm_key_part(shift))
map[key] = shift.id   (only if id is not None)
```
`norm_key_part` = trim + UPPERCASE (SHARED.md §4). For each extracted row: build the SAME triplet key (using the row's OWN transaction_date/production_batch/shift, normalized identically), look up in the map.
- Triplet found → `resolved_shift_id` set, `needs_shift_upsert=False`.
- Triplet NOT found → `resolved_shift_id=None`, `needs_shift_upsert=True` — classified as `NEW` regardless (a shift that doesn't exist yet can't have an existing child, so it's unconditionally NEW).

### `classify_production_runs.py` — natural key `(shift_id, customer^, grade^)`

- **MALFORMED gates** (in this exact order): (1) `shift is None or shift.strip()==""` → MALFORMED "missing shift" (DEFENSIVE ONLY per L-025 — extractor output never reaches this since it defaults blank shifts to Morning; only reachable by hand-crafted/external input). (2) `grade not in VALID_GRADES` (SAME 5-element set, duplicated verbatim in this file per L-027 — MUST be updated in lockstep with the extractor's set AND the DB CHECK). (3) `ttl_kg` is `None` or `< 0`.
  > **LIVE-WORKER DEVIATION (2026-07-23) — no-production day is a benign skip, not MALFORMED.** MC's daily report emits a runs row for any VALID grade present in the grade column even when nothing was produced that shift, so the TOTAL-kg cell (G) is left blank. The Python held such a row as MALFORMED via gate (3) (`ttl_kg is None`) — and a held row never advances the MC runs frontier, so a trailing no-production day (e.g. 2026-07-17) re-surfaced as a "to review" finding every sync and choked the run. The TS worker now distinguishes a **genuinely blank** kg cell from a **present-but-unparseable** one: `extractMc.ts::extractRuns` sets `_ttl_blank: true` (optional, omitted when false) via `isBlankCell` — true only for `null`/`""`/whitespace, false for text/date/boolean/negative (the xlsx loader already collapses Excel error cells to `null`, so an error formula reads as blank — accepted edge). `classify.ts::classifyRuns` classifies a valid-grade `_ttl_blank` row as a new benign class **`SKIPPED_NO_OUTPUT`** — NOT written, NOT held, does NOT gate the run — surfaced only as an informational count (`index.ts` progress line; a `skipped_no_output` summary key added ONLY when > 0). A present-but-unparseable or NEGATIVE `ttl_kg` still MALFORMS via gate (3). **This is TS-only and does NOT affect parity**: no oracle fixture carries a blank-kg row (both have `malformed: 0`), the added record field and summary key are omitted when not applicable, so both existing production fixtures stay byte-identical and parity remains 2/2. The **Python oracle keeps the MALFORMED behavior above** (unported) — mirror this only if the Python is ever revived as a live path. Tests: `test/reports/production.test.ts` → "no-production day — blank ttl_kg is a benign skip".
- **Compared (non-key) fields**: `ttl_kg` (tolerance 0.01), `sacks_bags` (tolerance 0.01), `remarks` (string equal AFTER stripping `SHIFT_DEFAULT_NOTE` from the EMAIL side via `strip_shift_default_note` — handles both the standalone-note case and the `" | {note}"`-appended case).
- `strip_shift_default_note` (lines 124-141) removes the marker via 3 sequential `.replace()` calls trying `" | {NOTE}"`, `"{NOTE} | "`, then bare `{NOTE}` — order matters if a remarks string could contain multiple copies, though in practice there is at most one note per row.

### `classify_production_downtime.py` — natural key `(shift_id,)` — UNIQUE(shift_id), exactly 1 row per shift

- **MALFORMED gates**: (1) missing/blank shift. (2) `shift_hrs <= 0` (note: this is checked on `ex.get("shift_hrs")`, which the extractor ALWAYS sets to the hardcoded default `12` — so this gate is effectively unreachable given the current extractor's output, but remains a defensive check against malformed external input).
- **Compared fields**: `shift_hrs`, `dt_hrs`, `dt_mins` (all numeric, tolerance 0.01), `dt_reason`, `remarks` (string equal). **`remarks` IS compared here even though the TABLE has no remarks column** — this classifier operates purely on the extractor's JSON shape and doesn't know about the DB schema's column list; a DB row fetched via `_child_db` in `sync_production.py` simply never HAS a `remarks` key (it wasn't in the `extra_cols` list passed for downtime), so `db_row.get("remarks")` always returns `None` — meaning this comparison effectively becomes "email remarks vs always-None", which would make ANY non-null extracted remarks show up as a perpetual VALUE_CHANGED diff on a field that can never actually be written or resolved. **This is a live bug/trap**: verify against a real run whether downtime's `remarks` field genuinely never causes a spurious VALUE_CHANGED in practice (perhaps because the extracted `remarks` — "Time ranges: ..." — is usually present, making EVERY downtime row perpetually flagged VALUE_CHANGED on this one field, silently no-op'd at apply time since the column doesn't exist to patch). Flag for a human decision: should downtime's classifier stop comparing `remarks` entirely, matching the table's actual schema?

### `classify_production_waste.py` — natural key `(shift_id,)`

- **MALFORMED gates**: (1) missing/blank shift. (2) any of the 8 waste streams `< 0`.
- **Compared fields**: the 8 streams (`WASTE_STREAMS` constant, tolerance 0.01 each) + `remarks` (string equal). `ttl_waste_kg_reported`/`_summed_kg` are EXCLUDED (extractor-side reconciliation aids only, never stored, never compared).

### `classify_electricity.py` — natural key `(reading_date, norm_meter(meter))`

- **MALFORMED gates**: missing `reading_date`, missing/empty `meter`, missing `start_kwh`, missing `end_kwh` — ALL four checked independently and ALL reasons accumulated into one `reasons_bad` list (not short-circuited).
- **Compared fields**: `start_kwh`, `end_kwh`, `meter_multiplier` (tolerance 0.01 via `norm_num` equality, NOT the shared `nums_equal` helper — this file reimplements the comparison inline as `norm_num(a,2) != norm_num(b,2)`, which is EQUALITY AT 2DP, not a tolerance-band check like production's `nums_equal`. **Porting trap**: `norm_num(10.004,2)=10.0` and `norm_num(10.0,2)=10.0` are equal, but `norm_num(10.006,2)=10.01` vs `norm_num(10.0,2)=10.0` are NOT equal here — whereas production's `nums_equal` tolerance-band check would call BOTH of those pairs equal (`abs(diff) <= 0.01`). electricity/trucks classifiers use plain rounded-equality, NOT a tolerance band, despite documenting "tolerance 0.01" in their own docstrings — re-verify this is intentional or a documentation error before porting.) + `remarks` (string equal).
- **Ambiguous-match handling**: if the natural key has >1 DB row (`ambiguous = len(matches) > 1`), the FIRST match is used, confidence is reduced (`0.85` NOOP / `0.7` VALUE_CHANGED instead of `1.0`/`0.95`), and a reason string notes the ambiguity — but this does NOT change the classification outcome, only the reported confidence.
- **Never compares/emits** `consumption_kwh`, `diff_kwh` (DB-generated).

### `classify_trucks.py` — natural key `(reading_date, norm_plate(plate_no))`

Structurally identical to electricity's classifier (same ambiguous-match handling, same plain-rounded-equality-not-tolerance-band pattern). `norm_plate` collapses internal whitespace (`re.sub(r"\s+"," ",...)`) before uppercasing — so `"AAV  6111"` and `"AAV 6111"` key-match. **Compared fields**: `start_km`, `end_km`, `fuel_liters`, `remarks`. Never compares/emits `ttl_km` (DB-generated).

### UNMAPPED handling

None of the 5 classifiers have an UNMAPPED bucket in the rc_out/gsheet sense — the closest analog is `needs_shift_upsert` (a NEW row whose parent shift doesn't exist yet), which is NOT held/blocked, just handled via the FK-safe apply ordering (create the shift first, then the child).

---

## 5. Gates & reconciliation (`reconcile_production.py`)

**CRITICAL: this reconciler is NEVER a write gate**, unlike rc_out's HARD gates. It exits 0 by default ALWAYS. `sync_production.py` never passes `--strict` (grep confirms no `--strict` in the orchestrator's subprocess call at line 203-207) — so even the two "arithmetic, gateable under --strict" checks NEVER actually gate in the lean-orchestrator daily-driver path; they are purely informational in THIS pipeline's actual invocation, despite the reconciler script itself supporting a stricter mode.

### Check 1 — Runs day-total (arithmetic, gateable only if `--strict` were passed, which it never is here)

`runs_sum[date] = sum(run.ttl_kg for that date)` vs `day_totals[date]` (the extractor's G13 sheet total). Tolerance `DAY_TOTAL_TOLERANCE_KG = 1.0`. A date with NO `day_totals` entry is a "gap" (not an arithmetic failure) — `drift_kg: None`, `reason: "no summary.day_totals entry for this date"`.

### Check 2 — Waste internal (re-surfaces the extractor's own `recon_mismatches`, does not recompute)

`waste_arith_failed = any(m.get("reported") is not None for m in waste_mismatches)` — a mismatch entry with `reported=None` (a gap, no TOTAL WASTE cell to compare against) is NOT counted as an arithmetic failure; only a mismatch with a REAL disagreeing `reported` value counts.

### Check 3 — Production vs rc_out drift (PURELY informational, NEVER gates even under `--strict`)

`(sum(runs.ttl_kg) + sum(waste 8-streams)) - rc_out_total_kg` per date. This is documented explicitly as expected-nonzero (feed tank continuous-flow) and can NEVER affect the exit code under any flag combination.

### `>50-NEW` / `confidence<0.7` gates

**Do not exist for production.** (Same note as rc_out.md — these gates are gsheet-specific.)

### Sub-watermark guard

**Does not exist for production** — none of the 5 classifiers accept a `--watermark` argument at all (unlike `classify_rc_out.py`). A settled-date row that somehow classifies as NEW (e.g. because the shift-map window computation missed it) would simply be inserted — there is no defensive re-check. This is a structural difference from rc_out; flag if this is intentional (production's watermark-exclusive extraction should make this scenario rare/impossible by construction) or a latent gap.

---

## 6. Apply spec

### Write order (FK-safe, exact sequence)

1. Distinct shift triplets (from NEW+needs_shift_upsert across runs/downtime/waste) → upsert `production_shifts`.
2. L-026 combine + insert `production_runs`.
3. Insert `production_downtime` (no remarks col) + `production_waste` (8 streams + remarks) — both via `insert_if_absent(natural_key=("shift_id",))`.
4. Insert `electricity_readings` + `truck_readings` (natural-key, no shift; generated cols excluded).
5. Apply VALUE_CHANGED across all 5 sections (generated cols stripped from any patch defensively) — **through the CONDITIONAL writer, see §6a**. The Python wrote these with a bare `db.update`; the TS worker must not.
6. Hold ALL MALFORMED across all 5 sections.

### L-026 combine algorithm (VERBATIM, sync_production.py:320-338)

```
run_news = [c for c in sections["runs"] if c.class == "NEW"]
combined: dict[(shift_id, customer^, grade^)] = {}
for c in run_news:
    sid = resolve_shift(c)
    if not sid: hold "unresolved_shift"; continue
    k = (sid, norm(customer), norm(grade))
    if k in combined:
        combined[k].ttl_kg += rec.ttl_kg (or 0)
        combined[k].sacks_bags += rec.sacks_bags (or 0)
        combined[k].remarks = "; ".join(filter(None, [combined[k].remarks, rec.remarks]))
    else:
        combined[k] = {shift_id, customer, grade, ttl_kg, sacks_bags, remarks}
for payload in combined.values(): insert_if_absent("production_runs", [payload], natural_key=(shift_id,customer,grade))
```
Note this combine happens ONLY across rows within the SAME classify batch's `NEW` list — it does not re-check whether the DB ALREADY has a partial row that should be combined with an incoming one (that scenario would surface as a plain VALUE_CHANGED against the existing row instead, handled by the separate VALUE_CHANGED loop, NOT by this combine logic).

### Payload field lists (INSERT)

- `production_shifts`: `transaction_date, production_batch, shift`.
- `production_runs`: `shift_id, customer, grade, ttl_kg, sacks_bags, remarks`.
- `production_downtime`: `shift_id, shift_hrs, dt_hrs, dt_mins, dt_reason` (NO remarks).
- `production_waste`: `shift_id, rs1a_kg, rs1b_kg, bf_kg, rs23_kg, rs5_kg, trml1_kg, trml2_kg, grit_kg, remarks`.
- `electricity_readings`: `reading_date, meter, start_kwh, end_kwh, meter_multiplier, remarks`.
- `truck_readings`: `reading_date, plate_no, start_km, end_km, fuel_liters, remarks`.

### Audit mechanism

**Manual-INSERT via `write_ingestion_audit` RPC for EVERY table** — none of the 6 production-family tables have an audit trigger (all go through `insert_manual_audit`, never `update_trigger_audit_provenance`).

### Idempotency mechanism

`insert_if_absent` per table with the natural keys listed in SHARED.md §2.5.

### Held-row reasons

`unresolved_shift` (a run/downtime/waste NEW row whose shift triplet never resolved to an id, even after the upsert pass — e.g. the shift upsert itself failed), `already_exists` / `already_exists_or_collision` (the latter specifically for downtime/waste, since a `UNIQUE(shift_id)` collision on those tables is BOTH "already exists" AND potentially "L-028/L-007 collision" needing review — the code comments this ambiguity explicitly), `malformed`.

### Label + watermark

Only if `not errors`. Labels BOTH `mc_uid` and `ivy_uid` together (falsy-filtered) in ONE call.

---

## 6a. § The human-edit latch (LIVE-WORKER DEVIATION, 2026-08-03)

**The defect.** Step 5 above turned every `VALUE_CHANGED` into `db.update(table, {id: eq.…}, patch)`. The app edits the very same tables (`app/(app)/production/{daily,trucks,electricity}/actions.ts`), so the moment Renzo corrects a number by hand, MC's workbook still says the old value, the next run classifies `VALUE_CHANGED`, and the sync reverts him — silently. That is the exact failure CLAUDE.md's Sync Integrity section forbids. Renzo raised it himself: *"sync has to know when i edited something in the app and not blindly sync and overwrite."*

Migration `supabase/migrations/20260803080000_production_human_edit_guard.sql` (applied live).

### The model — a monotone LATCH, not the schedule's ownership record

Two nullable columns on all six tables: `human_edited_at` (NULL = sync-owned; NOT NULL = the sync will not update it) and `human_edited_by` (display only — the guard never reads it).

Deliberately lighter than `production_schedule`'s `owner` + `pending_upstream` + `row_version`:

> **The schedule side of this comparison no longer exists (2026-08-28).** `production_schedule`, its ownership model and the worker's Stage-3c refresh were removed — code at `_archived/prod-schedule-v1/worker/`, spec at `_archived/prod-schedule-v1/specs/prod_schedule.md`, DB objects dropped by `supabase/migrations/20260828013000_drop_production_schedule.sql`. **The table below is kept because it is the reasoning for the LATCH, which is live and unchanged**: it says why the production FACT tables carry only two nullable columns, and that argument stands on its own whether or not the heavier design it was measured against still ships. Nothing in this spec's live behaviour depends on the schedule.

| Schedule has | Production facts don't, because |
|---|---|
| `owner` enum | The schedule has TWO upstreams (Joseph's email, Renzo's PROD SCHED tab) and must know which one to hand a released day back to. A production fact has exactly ONE (MC's / Ivy's workbook), so ownership is binary — a nullable timestamp IS the boolean, with the "when" for free. |
| `pending_upstream` | The plan is forward-looking, so a withheld value must survive until arbitrated. MC's/Ivy's workbook is CUMULATIVE — it still says the same thing tomorrow — so the run finding re-fires every run on its own. A parked copy would be a second, drifting record of something the source restates for free. |
| `row_version` | Optimistic concurrency answers "did this row change since I read it". The latch answers "has a human EVER touched it" and only the explicit release moves it back, so there is no ABA hazard for a version token to catch. Threading a version through 5 classifiers and 6 tables would buy nothing. |

### How the stamp is set — by TRIGGER

`fn_stamp_human_edit` fires BEFORE INSERT OR UPDATE on all six tables. `auth.uid()` non-null (an app session) → stamp, unconditionally; `auth.uid()` NULL (the worker's service-role key, whose JWT carries no `sub`) → leave alone. A guard the app can forget is useless, and these tables have eight app write sites. The app's actions also pass `human_edited_at` explicitly — belt and braces, and it keeps the claim legible at the call site. `human_edited_by` is resolved THROUGH `profiles` so a user with no profile row degrades to a NULL "by" instead of 23503-ing the operator's save.

### How the sync writes — `fn_apply_production_upstream(p_ops)`

`db.applyProductionUpstream(ops)` is now the ONLY update path; `ops` are `{table, id, patch}`. Each of the five UPDATEs carries `human_edited_at IS NULL` **in its own WHERE**, in ONE statement with the outcome classification (data-modifying CTEs), so there is no read-then-write. Outcomes: `applied | human_edited | missing | empty_patch | unsupported_field`. A patch key outside the per-table allowlist refuses the whole op — a new classifier field must be added to the RPC deliberately, never smuggled into a fact table. `production_shifts` is absent from the allowlist (the sync only inserts shifts). Non-`human_edited` refusals go to `errors[]`, which already blocks the watermark bump + the Gmail label.

### What the operator sees

A refusal becomes a `ProductionHumanEdit` note on `apply.production_human_edits` → `lib/sync/cases-fold.ts::collectProductionHumanEdits` → a `production_human_edited` run finding ("Row you edited — the report disagrees") naming the row and BOTH values, severity `attention`. Run-visibility only: NOT a held row (nothing to retry) and never a `HeldKind` (frontend-locked). `outcome` distinguishes `known_before_write` from `refused_by_db` (the save/sync race).

`ProductionCompact.human_edited_ids` carries the advisory list. It is read from the SAME queries that build the classify window (`human_edited_at` was added to those column lists), so it costs no extra round trip, and it is inert for classify — the classifiers read named fields and echo the EMAIL row as `record`, never the DB row. **Parity is untouched (12/12).**

### The way back

`fn_release_production_rows(table, ids)` clears the latch. Without it ownership ratchets one way and the data slowly freezes — the failure the schedule work called out. Release is EXPLICIT only: a row is never auto-released just because the workbook later agrees (that would break "a row a human edited is never overwritten"). The stamp cannot be cleared by an ordinary write — the trigger re-stamps any authenticated PATCH, including one sending `human_edited_at: null`; the RPC announces itself with the transaction-local GUC `blackwood.release_human_edit`. App entry point: `releaseProductionRows` in `app/(app)/production/actions.ts`. Read model: `view_production_human_edited`.

### The write path this guards went LIVE on 2026-08-04

Until then it was **dormant, and silently so**. The classifiers emit `{field:{db,email}}` (runs/downtime/waste) and `[{field,emailValue,dbValue}]` (electricity/trucks); step 5's patch builder read a `.new` key **neither shape carries** — faithfully mirroring `sync_production.py` — so every patch came out empty, every op was skipped, and `updates` was always 0 for production. The sync had **never applied a single correction** from MC's or Ivy's workbook, and reported success each time.

Step 5 now builds the patch from `changedFields()` — the same normalizer the refusal findings already used, which understands both shapes and drops the generated columns in one place. Renzo authorised switching it on (2026-08-04) precisely because the latch above is now underneath it: MC's values can only land on rows no human has claimed.

**One landmine was found and defused in the same change.** `downtimeFieldDiff` compared a `remarks` field, but **`production_downtime` has no `remarks` column** — the extractor builds one (`"Time ranges: …"`) and the insert path drops it, so the DB side was permanently absent and every downtime row carrying time ranges was a self-renewing phantom `VALUE_CHANGED`. Harmless while dormant; on the first live run it would have put a non-allowlisted key in the patch, and `fn_apply_production_upstream` refuses the **whole op** on one unknown key (`unsupported_field`) — taking that row's genuine `dt_hrs`/`dt_mins`/`dt_reason` corrections down with it. `remarks` is no longer diffed for downtime, and `DowntimeDbRow` no longer declares it.

**The refusal FINDING fired throughout the dormant period**, because it is emitted before the empty-patch skip: the disagreement was real whether or not there was a write to attempt.

Regression cover: `test/reports/production-value-changed-patch.test.ts` — both diff shapes drive `applyProduction` from **real classifier output** (no hand-shaped `new` key), generated columns are asserted out, the phantom `remarks` is asserted absent, and a mirror of the RPC's allowlist asserts no classifier can emit a key the RPC would refuse. Five of its eight tests fail against the old builder.

### Re-proving it against the live DB

Rolled-back `DO` block (MCP `execute_sql`), accumulating a `log text` and ending in `RAISE EXCEPTION E'PROOF:%', log`; fingerprint the six tables (`md5(string_agg(to_jsonb(z.*)::text ORDER BY …))`) before and after to prove nothing stuck. Simulate an app session with `set_config('request.jwt.claims', json_build_object('sub', <profiles.id>)::text, true)` and the sync with `set_config('request.jwt.claims','',true)`. Covered: apply-vs-untouched, app edit latches, apply-vs-latched refused, PATCH cannot clear the stamp, release + re-apply, insert still works, cross-table batch, `unsupported_field`, `missing`, idempotent re-release, bad table rejected.

---

## 7. Rule checklist

| Rule | Where | Parity test must assert |
|---|---|---|
| L-007 (STARTING/ENDING batch boundary) | **PORTED 2026-08-03** — `extractMc.ts::resolveRunShift` discriminates column H by value; `productionBatch.ts` folds the running batch. (Python only ever defaulted the SHIFT and never inferred the batch.) | A run row with column H = `STARTING`/`ENDING` resolves to shift `M` with `_shift_defaulted=false`, **no note and no warning**; `ENDING` files under the running batch and `STARTING` under the next name in the sequence, so a changeover day yields TWO distinct `production_shifts` parents and the L-026 combine cannot merge the two same-grade rows. Covered by `test/reports/production-batch-markers.test.ts`. |
| batch-from-running-state (2026-08-03) | `productionBatch.ts::resolveRunningBatch` + `buildBatchPlans`; seeded in `index.ts::runReport` | An ordinary day past a month boundary keeps the RUNNING batch (not the calendar month); a changeover on the 30th of the prior month still opens the NEXT name; cold start falls back to the calendar and reports the dates; a changeover emits one `production_batch_started` finding naming the new batch, the date, and the batch it follows. |
| L-014 (dt_mins>=60 split) | **NOT implemented in code** — ledger-documented manual step only | Flag: a downtime day totaling ≥60 minutes will fail the DB CHECK constraint unless the TS port implements the split explicitly during apply. |
| L-025 (blank shift → Morning default) | extract_daily_production.py:275-297, `SHIFT_DEFAULT_NOTE` constant duplicated in classify_production_runs.py:84 | A blank/absent/unrecognized shift cell (e.g. `DAY SHIFT`, `OVERTIME`) → `shift="M"`, `_shift_defaulted=true`, note appended; an EXPLICIT "MORNING SHIFT" cell → same `shift="M"` but `_shift_defaulted=false`, no note. **`STARTING`/`ENDING` are NO LONGER on this path** — see the L-007 row above. |
| L-026 (combine duplicate shift+customer+grade rows) | sync_production.py:320-338 | Two NEW run rows resolving to the same `(shift_id,customer,grade)` combine into ONE inserted row with summed `ttl_kg`/`sacks_bags`. |
| L-027 (4X8 / 3-gate grade allowlist) | extract_daily_production.py:79, classify_production_runs.py:71 | `VALID_GRADES` sets in BOTH files contain exactly `{3X50,6X50,8X50,2X6,4X8}`; a grade outside this set is dropped at extract (silent) and/or MALFORMED at classify. |
| L-028 (month-transition 2nd waste row = new shift) | **The "IF" is what L-046 supplied.** `extract_waste_production.py`'s carryover detection is a warning only, and its date-derived `production_batch` gave BOTH rows the same batch — so the two never resolved to different shifts and `UNIQUE(shift_id)` collided instead of separating them. `extractIvy.ts` now derives the batch from the TAB (L-046 row below), which is what makes this rule hold. | A carryover waste row dated on the outgoing month's last day, appearing on the NEW month's sheet, must resolve to a DISTINCT shift (different production_batch) rather than colliding with the outgoing shift's existing waste row. |
| L-046 (the TAB is the batch) 2026-09-01 | `extractIvy.ts::extractWasteSheet` — `production_batch = NUM_TO_MONTH_NAME[sheetMonth]`, never the row date's month. Python oracle unchanged; parity deviation registered for `production_real_latest` at `/waste/classifications/**`. | Two waste rows on ONE date, one per tab, extract under their OWN tabs' batches with their OWN figures (no crossover); only the carryover row carries a note and the note names the batch it was filed under; classify gives them DIFFERENT `shift_id`s so the second is NEW, never a VALUE_CHANGED overwrite of the first; apply upserts TWO `production_shifts` parents and inserts BOTH waste rows with no `already_exists` hold. An ordinary in-month row is unchanged. Covered by `test/reports/production.test.ts` → `describe("L-046 …")`. |
| parent-shift-first FK order | sync_production.py apply step 1-2 | Shifts always insert/resolve BEFORE any child row referencing them is attempted. |
| generated-cols-never-written | sync_production.py:413-415 | `diff_kwh`, `consumption_kwh`, `ttl_km` never appear in any INSERT or UPDATE payload. |

---

## 8. Fixture shopping list

- Real MC Daily Production Report sheet with: a normal CEBU 3X50 run, a KURARAY-customer run, a dropped-grade row (KOREA POWDER), a blank-shift run, a "STARTING"/"ENDING" batch-boundary run pair on the same date, a downtime block with multi-line minutes ≥60 total, an idle (skip) truck row, a moving truck row, an electricity MAIN reading, an idle BUNKHOUSE reading (must be skipped).
- Real Ivy WASTE PRODUCTION REPORT sheet with: a normal single-shift day, a dual-shift day (MORNING SHIFT + EVENING SHIFT rows), a carryover row (date's month ≠ sheet's month), a row whose TOTAL WASTE reported disagrees with the summed streams by >1kg.
- A synthetic month-transition fixture reproducing L-028 exactly: two same-date waste rows, one from the outgoing month's tab, one from the new month's tab as a carryover, both needing to land under DISTINCT shifts.
- A duplicate-run-row fixture reproducing L-026: two run rows for the same shift/customer/grade (e.g. "DAY SHIFT" 16,380kg + "OVERTIME" 6,890kg) that must combine to 23,270kg on insert.
- A downtime day totaling exactly 60 minutes and one totaling 125 minutes, to pin down the CURRENT (buggy, unsplit) `dt_mins` value the extractor emits, and to test whatever split logic the TS port decides to add.
- An electricity/truck fixture with values just inside vs just outside the 0.01 rounded-equality boundary (NOT a tolerance band — see porting trap) to confirm the TS port replicates plain-rounded-equality, not a tolerance-band comparison, for these two classifiers specifically.

---

## 9. Porting traps (production-specific)

1. **`dt_mins >= 60` is never split in code**, despite the ledger describing it as a standing rule. A literal byte-parity port would reproduce this bug (and its downstream DB CHECK violation) unless a human decides to actually implement the fix during porting. **This must be flagged, not silently ported as a known-bug or silently fixed** — surface to the user.
2. **`classify_production_downtime.py` compares a `remarks` field the DB table doesn't have.** Depending on how the TS port's DB-row-fetch shapes the "denormalized child" object (mirroring `sync_production.py::_child_db`, which explicitly OMITS `remarks` from `production_downtime`'s `extra_cols`), this comparison is comparing "extracted remarks" against "always None" — likely causing every downtime day with any extracted remarks text to permanently classify VALUE_CHANGED even though there is no column to patch. Flag for a human decision on whether to drop this comparison.
3. **`classify_electricity.py`/`classify_trucks.py` use PLAIN ROUNDED EQUALITY (round to 2dp, then `==`), not a `nums_equal`-style tolerance BAND**, despite their own docstrings claiming "numeric tolerance 0.01". This differs meaningfully from `classify_production_runs/downtime/waste.py`'s actual tolerance-band `nums_equal` helper. A value pair like `(10.006, 10.0)` classifies EQUAL under the tolerance-band functions but classifies DIFFERENT under electricity/trucks' plain-rounded-equality (since `round(10.006,2)=10.01 != round(10.0,2)=10.0`). Port each classifier's ACTUAL comparison, not its docstring's claim.
4. **`normalize_shift` exists as TWO DIFFERENT functions** — exact-dict-match in `extract_daily_production.py`, substring-`in`-match in `extract_waste_production.py`. Do not unify into one shared helper without an explicit decision; they are used for different sheets with different operator conventions.
5. **`production_batch` has THREE different derivation conventions across the whole ICTC pipeline**: production/waste use full-month-name always (`MONTH_NAME_UPPER`); rc_out uses 3-letter `%b` EXCEPT May/June overridden to full words; gsheet's RC OUT extractor just takes whatever raw text is in the Sheet's column B verbatim (no derivation at all). A TS port must NOT create one shared "derive production_batch" utility across pipelines — each pipeline's convention is a distinct, independently-evolved historical artifact. **The NAMING convention is not the same question as WHERE THE NAME COMES FROM**, and the two Python extractors are wrong on the second: MC's derived it from the sheet DATE (fixed 2026-08-03 — it comes from the plant's running state, `productionBatch.ts`) and Ivy's derived it from the ROW date (fixed 2026-09-01, L-046 — it comes from the TAB). Both fixes are TS-only; both leave the full-month-name spelling untouched.
6. **`_child_db`'s no-date-filter-then-join-filter pattern** (fetch ALL rows of a child table, THEN drop any whose shift isn't in the pre-windowed shift set) means a TS port's equivalent function must NOT try to optimize this into a single windowed query via a SQL JOIN unless it verifies the join produces IDENTICAL results — in particular, a child row whose `shift_id` points to a shift OUTSIDE the `[lo,hi]` window (e.g., a stale/orphaned FK, which shouldn't normally happen but the code defensively handles it) is silently DROPPED from the classifier's DB view entirely, meaning it becomes invisible to dedup and could theoretically be re-inserted as a duplicate. This is arguably a latent edge-case bug worth flagging, not necessarily porting faithfully without comment.
7. **Downtime and waste's `natural_key=("shift_id",)` is a ONE-TUPLE key** — a TS port's `insert_if_absent`-equivalent must handle a natural key of length 1 the same way it handles length-3+ keys (no special-casing that assumes multi-column keys).
