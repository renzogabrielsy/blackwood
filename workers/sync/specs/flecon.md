# flecon.md — FLECON BAGGED (Ivy) → `flecon_bag_movements`

Scripts: `extract_flecon_bags.py` (667 lines), `classify_flecon_bags.py` (330 lines),
`sync_flecon.py` (249 lines). This is a **packaging-material** (empty jumbo/flecon bag stock)
pipeline — NOT charcoal — and uses a fundamentally different model (REPLACE-BY-DATE / day-set
diff) from every other report type, because the source register legitimately has repeated
identical-looking rows within a day with no stable per-row natural key.

Read SHARED.md first.

> **2026-07-27 — the TS port now DIVERGES from the Python on three safety points (BUG-015).**
> The Python (and the original port) silently dropped every `< since` row behind a bare
> counter, computed `balance_crosscheck` and threw it away, and did REPLACE-BY-DATE as a
> non-transactional DELETE-then-INSERT that could wipe a day with no audit row. Those three
> defects caused real data loss in production. §2a, §3a and §5a below are the TS behaviour;
> the Python remains the ORACLE for the classify envelope only, which is unchanged (parity
> 12/12 — every addition is extract-level telemetry or apply-level guarding, never a
> classify-envelope field).

---

## 1. Pipeline narrative (`sync_flecon.py`)

1. **Watermark**: `watermark = data_watermark(db, "flecon_bag_movements")`. If present, `since = watermark - 3 days` (tail-scope), Gmail `since_gmail` same offset. If ABSENT (first run ever), `since = "2026-01-01"` (hardcoded — NOT `2025-01-01` like other pipelines' first-run default; flecon's DB history starts 2026) and `since_gmail = "2025/12/31"` (one day before, so the Gmail `after:` filter is inclusive of Jan 1).
2. **Fetch**: `from:edilloivymae306ictc@gmail.com subject:"FLECON BAGGED" after:{since_gmail} -label:"Blackwood-Processed"`. No xlsx → early-return `ok:true`.
3. **Extract**: `extract_flecon_bags.py --file {xlsx} --since {since}` (NOT `--all-sheets` — see extraction spec; this workbook has ONE cumulative sheet per YEAR, not per day/month, so there's nothing to select from a list the way other pipelines do).
4. **Classify**: `classify_flecon_bags.py --extract-json {extract} --since {since} --output {classified}` — the classifier SELF-FETCHES the DB movements, bag-type registry, and balance-view via `lib/db.py` internally (no `--db-rows-json` etc. passed by the orchestrator; those flags exist purely for OFFLINE/test invocation).
5. **Emit envelope**: `counts.insert = new_days`, `counts.update = date_changed_days`, `counts.flagged = 1 if column_flagged else 0` (a SINGLE flag bit, not a per-column count, despite there possibly being multiple unmapped/missing columns).

### Apply phase (`phase_apply`, sync_flecon.py:136-228) — REPLACE-BY-DATE

For each date in `per_date` (only dates classified NEW or DATE_CHANGED — NOOP days never appear here at all, by construction of the classifier):

1. If `date < since` (the bounded floor), HOLD (`reason: "below_since_floor"`) and skip — settled history is NEVER touched even if somehow present in `per_date` (defensive; shouldn't normally happen since the classifier only walks dates `>= since`).
2. Map every movement's `bag_type_code` to a `bag_type_id` via `code_to_id` (built from the classifier's own resolved map, echoed back in the classified JSON). If ANY movement on that date has an unmapped code, the ENTIRE DATE is held (`reason: "unmapped_bag_type_code"`) — no partial write for that date.
3. `DELETE FROM flecon_bag_movements WHERE transaction_date = eq.{d}` (unconditional — via raw `db._session.delete(...)`, NOT a wrapped `DBClient` method; this is the only place in the whole codebase that reaches into `db._session` directly rather than using a public `DBClient` method).
4. `INSERT` the mapped rows (if any — a date could legitimately have ZERO movements after mapping, e.g. if it was previously NEW with data but is now being re-synced with an empty day, though this is an edge case).
5. ONE manual audit row per replaced date, `operation="REPLACE"` (the widened `audit_logs.operation` CHECK constraint per L-032), keyed to the FIRST inserted row's id as the audit record_id (if `rows` was non-empty and insert succeeded — `marker_id = ins[0]["id"] if rows and ins else None`; if the date's replacement resulted in zero rows, NO audit row is written for that date at all).
6. Column flags (`unmapped_or_missing_columns`) are ALWAYS added to `held` upfront if present, regardless of per-date outcomes — this is a standing warning across the whole run, not tied to any specific date.
7. Label + watermark only if `not errors` AND no `held` entries with reason `unmapped_bag_type_code` or `unmapped_or_missing_columns` remain (`held_dates` check, sync_flecon.py:211) — a STRICTER label condition than other pipelines (explicitly checks for these two specific held-reasons, not just `not errors`).

---

## 2. Extraction spec (`extract_flecon_bags.py`)

### Workbook anatomy

**ONE tab per YEAR** (e.g. `"JANUARY 2026"` = the entire year 2026's cumulative log, despite the tab NAME looking month-specific — this is a real, deliberately-preserved quirk of the operator's naming, NOT a bug). In-sheet month SECTION headers (bare month-name rows) subdivide the year visually but are not separate tabs.

### Sheet selection (`select_year_sheet`, lines 218-236)

If `--year` given: find sheets whose name contains that year as digits (`target in n.replace(" ", "")`), prefer the LAST match if multiple; if none match, fall back to the workbook's LAST sheet with a warning. If `--year` omitted: always use the workbook's LAST sheet (assumed to be the current cumulative year tab). **Cell E2 may carry a STALE "YEAR 2025" label — this is explicitly NEVER trusted** (design decision noted in the docstring); only the tab name + row dates are trusted.

### Header geometry — MULTI-ROW, COMBINED SIGNATURE (the 2026-07-02 resilience rewrite)

- Row 4: `A="DATE"`, `B="PARTICULAR"` (both checked via `normalize_sig` equality — i.e. lowercased, non-alphanumerics stripped — so this tolerates trivial formatting differences but not a genuinely different label).
- Bag-type identity is spread across header ROWS 3, 5, 6 (`HEADER_SIGNATURE_ROWS = (3,5,6)`) for each bag-type COLUMN starting at column C (`COL_C = 3`). A single header row is AMBIGUOUS on its own (e.g. columns M and N might BOTH say "FG" on row 5) — `build_column_signature(ws, col)` joins the non-empty cell text from rows 3/5/6 (in that fixed order) with a space into ONE combined signature string per column, which IS expected to disambiguate.
- `locate_header_block(ws)` (lines 242-255) HARD-ERRORS (exit code 4, no JSON rows emitted) if row-4 A/B don't normalize to `"date"`/`"particular"` OR if NO column in the scanned range produces any non-empty signature at all — this is a deliberate "never silently emit 0 rows" guard.

### Column mapping algorithm (`map_columns`, lines 272-370) — VERBATIM, two-pass

**Registry**: `flecon_bag_types` rows, each `{code, source_label, source_column, sort_order, label}`. `reg_by_nsig = {normalize_sig(source_label): [entries]}` (a list per normalized signature, since duplicates are possible before disambiguation). `last_col = max(DEFAULT_LAST_BAG_COL=16 ['P'], *any registry source_column indices)` — the scan range is `COL_C..last_col`, so a registry entry pointing PAST column P widens the scan.

**Pass 1 (exact normalized match)**: for each column `C..last_col`, compute its combined signature, normalize it, and look up `reg_by_nsig[nsig]`. If EXACTLY one registry entry has that exact normalized signature → matched, code claimed. If MORE than one entry shares that exact signature → left UNMAPPED with an "ambiguous" warning (never guesses which one).

**Pass 2 (conservative contains-fallback)**: for columns STILL unmatched after pass 1, for every registry entry NOT already claimed by an exact match, check if the registry's normalized label is a SUBSTRING of the column's signature OR VICE VERSA (`rn in nsig or nsig in rn`). Collect all such candidates' codes into a deduped set; if EXACTLY one candidate code → matched. If more than one → left UNMAPPED with an "ambiguous, never guessed" warning.

**Never falls back to positional/fixed-column matching** — a column that fails BOTH passes is permanently unmapped for this run (surfaced via `unmapped_columns`, never silently assigned by position, even though the module comment mentions the historical fixed-column model as what this REPLACED).

### Opening balances (row 7, "Forwarded Balance")

`extract_opening_balances` (lines 421-428): for each MATCHED column, `coerce_int(cell)`; only included in the output dict if non-null AND non-zero (a blank/zero opening balance is simply OMITTED from the dict, not represented as `0`).

### Movement extraction — date carry-forward, month-header reset, marker-row skip, balance-snapshot capture (`extract_movements`, lines 434-521)

Walk `FIRST_DATA_ROW (8)` to `ws.max_row`:

1. **Populated matched columns for this row**: for every column IN `col_to_code` (matched columns only — unmapped columns are NEVER read for movement values at all, even if they carry data), `coerce_int(cell)`; keep `(col, value)` pairs where value is non-null AND non-zero.
2. **Month-name section row**: column A is alpha text (not a date), column B is empty, AND that text (uppercased) is one of the 12 `MONTH_NAMES` → this is a section header. **RESETS `carried_date = None`** (so a month header can't leak the PRIOR month's carried date into the NEXT bare sub-row that has no date of its own) and `continue`s (no movement emitted for this row).
3. **Balance-snapshot row**: NO date AND NO particular text, but non-zero matched-column values present (typically one specific row near the bottom, ~row 499) → captured ONCE into `balance_snapshot` (a `{code: qty}` dict), NEVER emitted as a movement. A SECOND such row later in the sheet is ignored with a warning (only the FIRST one is kept).
4. **Date carry-forward**: if the row has its OWN parseable date in column A, `carried_date` is updated to it. (Applied AFTER the month-header-reset check and the balance-snapshot check, so those two special row types don't accidentally update `carried_date` themselves even if they happen to have a date-like cell — though by construction neither of those row types HAS a date.)
5. **No matched-column quantity on this row** (`not cols`): if `particular` text is present, counted as a `skipped_markers` tally (e.g. `"RS 1 ZAMBOANGA"` rows — bare informational markers with no bag quantity). If particular is ALSO absent, silently skipped with no tally at all.
6. **No carried date yet but a quantity is present**: warning `"bag quantity present but no date in context"`, row skipped entirely (no movement emitted).
7. **`--since` tail-scope**: `if since is not None and carried_date < since: dropped_before_since += len(cols); continue` — dropped BEFORE emission, tallied by COLUMN COUNT (`len(cols)`, i.e. counts each populated column on that row separately), not by ROW count.
8. **Emission**: one movement PER populated matched column (handles the rare multi-column row — a blend/recount touching two bag types on the same date): `{transaction_date, particular (verbatim, both ZAMBOANGA spellings preserved distinctly), bag_type_code, qty_delta (signed int), source_row}`.

### §2a. TS-ONLY — dropped/mis-dated row telemetry (BUG-015 defect A, 2026-07-27)

`dropped_before_since` is still tallied exactly as the Python does (by COLUMN count), and no
row's date is ever rewritten. What is NEW is that the TS extractor also returns:

- `sheet_year` — the tab's own 4-digit year, parsed from the sheet name (`JANUARY 2026` → 2026).
- `flagged_rows: FleconFlaggedRow[]` — one entry per (row, populated column) that was
  **dropped by the `since` floor** and/or dated **outside the tab's own year**, carrying
  `{transaction_date, source_row, particular, bag_type_code, qty_delta, dropped, out_of_year}`.

Neither field is consumed by `classify` — the classify envelope is byte-identical, so parity
is unaffected. `apply` turns them into held rows (§5a).

**2026-07-29 (BUG-020):** a flagged row whose tab-year correction is SETTLED is suppressed —
see §6a. The rows below were hand-backfilled, so asserting they were "never imported" became
false; the ledger, not the wording, is what makes that honest.

**Why:** the `JANUARY 2026` tab's cell **A75 reads `2025-01-31`** (an operator year-typo;
rows 76–79 inherit it by date carry-forward). `2025-01-31` is below every watermark, so those
five real movements — ECOPACK_BEIGE +100, ZAMBOANGA_BAG +127, KOREA_WHITE_SUNDRY +4 — were
dropped on every run since January and were the entire cause of the app showing a physically
impossible **ZAMBOANGA_BAG = −127**. The extractor was RIGHT to refuse them; it was wrong to
refuse them silently.

**The rule stays "extract exactly, never interpret"** (CLAUDE.md § Sync Integrity): an
out-of-year date is reported, never corrected, and never imported. The permanent fix is the
operator correcting A75.

### Marker-row spelling preservation (explicit design decision)

Both `"RS 1 ZAMBOANGA"` and `"RS 1 ZAMBAONGA"` (a genuine operator typo) are kept VERBATIM, never auto-corrected — this matters because `classify_flecon_bags.py`'s day-multiset comparison keys on the normalized `particular` text, so preserving the exact (even mis-spelled) text is what allows the classifier to detect a genuine spelling-fix EDIT as a real day-change rather than silently canonicalizing it away.

### Unmapped/missing column reporting

`scan_unmapped_columns` (lines 373-415): for every column that matched NO registry code but carries ANY non-zero value (opening balance OR any data-row cell, up to 5 samples collected), surfaced as a candidate NEW bag type — NEVER emitted as a movement, NEVER guessed. `missing_columns` = registry codes whose `source_label` matched NO column this run at all (possibly removed/renamed by the operator).

### Confidence

`overall_confidence = max(0.5, 1.0 - 0.05 * len(warnings))` — note the coefficient is `0.05` per warning here (HALF the `0.10` per-warning penalty used by every other extractor in this codebase), and the floor is `0.5` (not `0.0`).

---

## 3. Classification spec (`classify_flecon_bags.py`) — DAY-SET / REPLACE-BY-DATE model

### Why no per-row natural key

A bag movement register legitimately has repeated identical-looking rows within a day (e.g. two separate `"BAGGED POWDER -X"` entries of the same bag type and quantity on the same day are both real, distinct events). There is no reliable field to disambiguate them as a "natural key" the way other pipelines have `(date, batch, weight)` etc. So the unit of comparison is the WHOLE DAY, treated as a MULTISET.

### `movement_sig(m)` — the multiset element identity

`(norm_particular(particular), bag_type_code.strip().upper(), int(round(float(qty_delta))))` — a 3-tuple. `norm_particular` collapses ALL whitespace and uppercases (SHARED.md §4) but does NOT canonicalize spelling.

### `day_multiset(movements)` = `Counter(movement_sig(m) for m in movements)`

### Per-date classification (verbatim decision tree, lines 209-238)

For each `transaction_date` in `set(ex_by_date) | set(db_by_date)`:
- `db_present = d in db_by_date` (a date with ZERO db movements is DIFFERENT from a date NOT in the DB set at all — but since `db_by_date` is a `defaultdict(list)` populated only for dates that appear in the DB query result, an absent date and a present-but-empty date are functionally the same here: `db_by_date.get(d, [])` and a truly-absent key both yield `[]`; `db_present` checked via `d in db_by_date` which is `False` for a truly-absent key REGARDLESS of whether it would have had an empty list — this distinction matters for the `NEW` vs `DUPLICATE_NOOP` decision below).
- **`not db_present`** → `NEW`. Full day payload (`movements`) attached for INSERT.
- **`ex_ms == db_ms`** (multisets exactly equal) → `DUPLICATE_NOOP` (counted only, day details NOT dumped into the output — "NOOP days are counted, never dumped, to keep the agent's context small").
- **else** (`db_present` but multisets differ) → `DATE_CHANGED`. The FULL day payload is attached (`movements: ex_by_date.get(d, [])`) for the REPLACE (DELETE-then-reinsert) — note this is the SHEET's current movements for that date, NOT a computed diff/delta; the `delta` field (added/removed via `multiset_delta`) is ADDITIONAL informational detail for a human reviewer, not what gets written (what gets written is simply "everything the sheet currently says for this date").

### `multiset_delta(extracted_counter, db_counter)` — symmetric difference for human review only

`added = extracted - db` (Counter subtraction — signatures present in sheet but absent/fewer in DB), `removed = db - extracted` (vice versa). Each unpacked into a sorted list of `{particular, bag_type_code, qty_delta, count}` dicts. **This is NEVER used to construct a partial write** — the actual REPLACE always uses the full day, never this delta.

### Column-mapping FLAGS pass-through (never blocks movements that DID map)

`column_flags = {flagged: bool(unmapped) or bool(missing), unmapped_columns, missing_columns, column_map}` — a straight pass-through of what the extractor already computed. These are surfaced for the human to register a NEW bag type or acknowledge a removed/renamed one; they NEVER prevent the movements that DID successfully map from being classified/applied normally.

### INFORMATIONAL balance cross-check (never gates)

If the extractor located a `balance_snapshot` (the sheet's own running-balance row), compares it per-code against `view_flecon_bag_balance` (a SQL view, read via `lib/db.py`). `drift = db_view_balance - sheet_snapshot_balance` per code, reported but NEVER blocking. If no snapshot was found, `available: False` with a note.

### §3a. TS-ONLY — the cross-check is no longer thrown away (BUG-015 defect B, 2026-07-27)

The computation above is unchanged (still per-code, still `db − sheet`, still recorded on the
classify envelope). What changed is that **something finally reads it**: `apply` raises ONE
held row (`balance_crosscheck_drift`, kind `flagged`) naming every bag type whose `drift` is a
non-zero number, with both balances. Before this, `grep balance_crosscheck` outside
`reports/flecon` returned zero hits — it had been correctly reporting the −100 / −4 / −127
drift caused by defect A for three weeks, to nobody.

**It remains INFORMATIONAL and MUST stay that way** — flecon is single-source, and a drift
never blocks a write. It is a finding, not a gate.

**2026-07-29 TIMING FIX (BUG-020) — the app side is re-read AFTER the writes.** The
computation above runs inside `classify`, from a `view_flecon_bag_balance` read taken
BEFORE this run's own writes, and compares it against the sheet's **already-updated**
balance row. Every run that imported new movements therefore reported phantom drift (run
`da9f2714-8836-418f-8594-1ec4883ea98e`, 2026-07-29: FG_ALL_BLACK "app 6 vs sheet 156",
KOREA_WHITE_SUNDRY "app 306 vs sheet 282", ZAMBOANGA_BAG "app 0 vs sheet 160" — the DB now
reads 156 / 282 / 160, matching the sheet exactly; all three had movements dated 2026-07-27,
the day that run imported).

The classify envelope is UNCHANGED (parity-frozen). What moved is where the FINDING is
produced: `apply.ts` now builds it **after** the per-date write loop, from a fresh balance
read injected as `FleconApplyDeps.readBalances` (optional — an offline caller keeps the
classify-time rows), via the pure `recomputeCrosscheckRows(rows, freshBalances)` which swaps
the app side and recomputes `drift = app − sheet` over the same code set. **The tolerance was
NOT widened** — any non-zero drift is still reported. A code missing from the fresh read
yields a null balance and a null drift (un-comparable, never counted as drift), the same
convention classify uses.

### Bag-type ID resolution for the EXECUTE payload

`code_to_id` built from `flecon_bag_types` (`{code.upper(): id}`) — echoed in the classified JSON's top level so `sync_flecon.py`'s apply phase doesn't need to re-fetch it.

---

## 4. Gates & reconciliation

- **No HARD gate** — `sync_flecon.py`'s classify phase always emits `ok: true`. Column-mapping issues are surfaced as `counts.flagged` but do not set `ok: false`.
- **TS-ONLY, two `gate_failures`** (the Python has none): `stale_workbook` (§5a/§5b/§5c — the attachment is an older copy than the DB) and `settlement_ledger_unreadable` (§6a — the list of dates that must not be rewritten could not be read, so the report refuses to run at all). Both settle the panel card to *gate-failed* and the run to `partial`.
- **Balance cross-check is informational only**, as documented above.
- **The `below_since_floor` bounded-apply check is the closest thing to a gate** — but it operates at APPLY time (not classify time) and only ever produces a `held` entry for a defensive edge case (a date somehow present in `per_date` below the `since` floor, which shouldn't happen given the classifier only walks `all_dates = sorted(set(ex_by_date) | set(db_by_date))` where BOTH sides are already filtered to `>= since` at the point of construction — `db_by_date` is built with `if d >= since: db_by_date[d].append(m)` explicitly, classify_flecon_bags.py:204-205).

---

## 5. Apply spec

### Write order

1. Column-flag held-entries added upfront (informational, not blocking).
2. For each `NEW`/`DATE_CHANGED` date (in `per_date` order, which is `sorted(all_dates)` from the classifier): floor check → bag-type-code mapping check (whole-date hold on any unmapped code) → `DELETE` then `INSERT` → one manual audit row (`operation="REPLACE"`).

### Payload field list (INSERT, per movement row)

```
transaction_date, particular, bag_type_id, qty_delta, source_row, remarks
```
(`remarks` here comes from `m.get("remarks")` — note the EXTRACTOR's movement dict does NOT actually populate a `remarks` key at all (see extraction spec §2 output shape: `{transaction_date, particular, bag_type_code, qty_delta, source_row}` — no `remarks`); so this field is ALWAYS `None` in practice for every flecon INSERT unless the classified JSON was hand-edited to add one. Flag as dead code / a vestigial field, not necessarily a bug.)

### Audit mechanism

Manual-INSERT via `write_ingestion_audit` RPC, `operation="REPLACE"` — the WIDENED `audit_logs.operation` CHECK constraint (migration `20260703043000`, L-032) is REQUIRED for this to succeed; without it, every flecon apply would 23514-fail. **This is the only report type using the `REPLACE` operation value.**

### Idempotency mechanism

NOT `insert_if_absent` — flecon's write is DELETE-then-INSERT (whole-day replace), which is idempotent BY CONSTRUCTION (re-running the exact same date with the exact same sheet content produces the exact same rows after DELETE+INSERT, regardless of how many times it's repeated) rather than by a per-row existence check.

### Held-row reasons

`unmapped_or_missing_columns` (standing, not date-specific), `below_since_floor`, `unmapped_bag_type_code` (whole date held).

### Label + watermark

Watermark upsert: only if `not errors`. Label: only if `not errors` AND no held entry with reason `unmapped_bag_type_code` or `unmapped_or_missing_columns` — STRICTER than other pipelines (which only check `not errors`). The BUG-015 held reasons below are deliberately NOT in that list (except via the stale-workbook early return, which skips both) — an out-of-year typo recurs on every run until the operator fixes the sheet, and blocking the label forever would stall the pipeline.

### §5a. TS-ONLY — the three write guards (BUG-015, 2026-07-27)

All five new held reasons reuse EXISTING `HeldKind`s — the kind enum is frontend-locked
(`app/(app)/sync/types.ts` plus three exhaustive `Record<HeldKind, …>` maps in `components/`
and `app/(app)/sync/adjudication.ts`). Reclassify via `reason`/`detail`/`row`, never a new kind.

| Held reason | Kind | When |
|---|---|---|
| `out_of_year_date` | `malformed` | A dropped row whose date-year ≠ the tab's year (defect A). One row per DATE, naming the sheet rows, the bag types, and the net qty. |
| `dropped_before_since_unrecorded` | `below_since_floor` | An in-year row below the floor whose DATE the DB has **never** recorded. Ordinary settled history (a dropped date the DB already holds) is silent — that is the benign every-run case. Requires the `dbDates` opt. |
| `balance_crosscheck_drift` | `flagged` | Any non-zero per-code drift (defect B). Never gates. |
| `delete_to_empty_blocked` | `gate_failure` | A `NEW`/`DATE_CHANGED` date that resolves to ZERO rows (defect C2). The date is NOT deleted. A day is never wiped on the strength of an absent section. |
| `stale_workbook` | `gate_failure` | The workbook's own latest date is older than `MAX(flecon_bag_movements.transaction_date)` (defect C1). The WHOLE apply refuses: no writes, no watermark, and `runReport` also returns a `gate_failures` entry so the panel card settles to *gate-failed* rather than a silent zero-row success. **The Gmail label is the ONE exception — see §5b.** |

**Atomic replace (defect C3).** The DELETE + INSERT pair is now ONE transaction via the
`fn_flecon_replace_date(p_date date, p_rows jsonb)` RPC (migration
`20260727060000_fn_flecon_replace_date.sql`), surfaced as `DbClient.replaceFleconDate`. It
returns `{deleted, deleted_first_id, inserted, first_id}` so the manual `REPLACE` audit row is
written on **every** replace, falling back to a DELETED row's id when the insert returns none —
previously the audit was skipped whenever `ins.length === 0`, which is exactly the wipe case.
The dry-run write-blocking proxy (`reportDeps.makeDryRunDb`) MUST list this method: the proxy
is `Object.create(DbClient.prototype)`, so an unlisted method falls through to the real client.

### §5b. TS-ONLY — a REFUSAL THAT CAN NEVER CHANGE ITS MIND MUST STOP RE-FIRING (2026-08-26)

**What happened.** Ivy's FLECON BAGGED email of 2026-08-24 00:58 (uid 126413, attachment
`FLECON BAG MOVEMENT 2026 .xlsx`, 387,515 bytes) carries a workbook whose last dated row is
**2026-08-21**, while `MAX(flecon_bag_movements.transaction_date)` is **2026-08-25**. The
`stale_workbook` gate refused it — correctly, and the data was already fully in sync. But
because the gate failed, `labelProcessed` was never called, so the same dead email was
re-fetched and re-refused on **every** subsequent run, and every one of those runs settled
`partial`: `4a8602ac` (08-25 01:42), `7f23dd88` (08-26 01:11), `a67e9c4a` (08-26 02:11).

**The rule.** flecon's normal discipline is "label only on a clean apply" (§5), which is right
for every failure a later run could resolve — an unmapped column can be registered, a database
refusal can succeed on retry. This one cannot. **An attachment is a fixed file, and an older
copy of a CUMULATIVE workbook can never become newer**, so re-reading it tomorrow can only
reproduce the identical refusal. So a **STRICTLY older** stale workbook (a real
`workbookMaxDate` that is `< dbWatermark`) is labeled processed on the run that refuses it.

Three boundaries make that safe:

1. **The refusal to WRITE is untouched.** No replace, no DELETE, no INSERT, no watermark move,
   `ok: false`, and the `stale_workbook` held row + `gate_failures` entry exactly as before.
   Only the LABEL decision changed. The held detail and `row.email_labeled_processed` say so.
2. **`ok` stays FALSE on the labeling run**, so that run is still `partial` and the operator
   sees the problem **exactly once** — which is the whole point. A jam that reports itself on
   every run is not "loud", it is background noise; the fix is *seen once, then silent*, never
   *never reported*. (`reportWorkflow.ts` sets `classify.ok = r.ok && !gate_failures.length`
   and `runSync.ts::reportFailed` turns either into `partial` — nothing there changed.)
3. **STRICTLY older only.** A workbook with **no dated rows at all** (`workbookMaxDate === null`)
   is a different, rarer failure — a broken or unreadable attachment, not a provably superseded
   one — so it is NOT labeled and keeps firing until a human looks at it. A dry run (`noLabel`)
   never labels, and a Gmail labeling error is swallowed (`labeled: false`) rather than turned
   into an apply error: a mail failure must not convert a clean refusal into a crash.

### §5c. TS-ONLY — the stale message must name a date that EXISTS (2026-08-26)

The gate detail read *"only carries bag movements up to **(no dated rows)**"* about a workbook
visibly full of dated rows. `extract.summary.date_max` is computed over `extract.rows`, which
the `since` floor has **already filtered** — it answers "the newest day IN THIS RUN'S WINDOW".
In the jam above, `since` = `2026-08-25 − 3d` = `2026-08-22` and the file's last row is
`2026-08-21`, so *every* row was dropped and `date_max` was null.

`index.ts::wholeSheetMaxDate(extract)` is now the input to both the comparison and the
sentence: the max `transaction_date` over `extract.rows` **∪** `extract.flagged_rows`,
**excluding out-of-year rows**. Two notes:

- **The verdict did not change in any real case, and that was verified before the change.**
  `since` is a FLOOR derived from the watermark, so dropping rows below it can never *lower*
  a maximum unless it empties the set — and an emptied set means every row was below
  `watermark − 3`, i.e. the workbook was genuinely stale anyway. The old comparison was
  therefore correct by coincidence; it is now correct by construction, and no longer depends
  on `since` being derived from the watermark.
- **Out-of-year rows are excluded on purpose.** A date whose year is not the tab's own year is
  an operator TYPO (§2a) and is never evidence of how fresh the file is. Including one would
  let a single `2027-…` slip make a genuinely stale workbook look newer than the database and
  **disarm this gate entirely**. The predicate is the same one `extract.ts` uses to set
  `out_of_year`.

`apply.ts` needs no change for this: it renders `opts.staleWorkbook.workbookMaxDate`, which is
built once in `index.ts` and passed in — one value, both sentences.

---

## 6a. § Settlement — the FLECON DATE-SETTLEMENT LEDGER (2026-07-29, BUG-020)

The direct sibling of rc_out's ledger (`rc_out.md` §4b). Table
**`flecon_bag_date_settlements`** (migration `20260729060000_flecon_bag_date_settlements.sql`).
Once a `transaction_date` is SETTLED, every future flecon run skips it **entirely** — no
extract-compare, no classify, no REPLACE-BY-DATE, and critically **no DELETE**.

**Why flecon needs one.** The five A75-typo movements (§2a) were HAND-BACKFILLED into
`2026-01-31` on 2026-07-27 (audit `a6293bf8-26b2-4207-98a4-6134f0f08fb7`). They survived only
because a normal run's `since` (`watermark − 3 days`) never reaches January. A watermark reset
drops `since` to the `2026-01-01` first-run floor; the extractor again (correctly) refuses the
mis-dated rows, so `2026-01-31` resolves to the sheet's contents alone and REPLACE-BY-DATE
deletes the backfill. Renzo decided **NOT** to have cell A75 corrected, so the arbitration is
made durable in the database instead. **Do not design anything here that depends on the sheet
being fixed.**

**Settle criterion — deliberately narrow, because flecon is SINGLE-SOURCE.** There is no
independent second witness per date the way rc_out has the RC MOVEMENT sheet, so we do not
invent corroboration. A `DUPLICATE_NOOP` day is **never** auto-settled: the sheet is editable
history and settling a NOOP would freeze out a legitimate future edit. The worker settles by
itself in exactly ONE machine-verifiable case:

> an out-of-year flagged row group (§2a) whose movements ALREADY EXIST in the DB, movement
> for movement, under the tab's own year — i.e. the arbitration provably already happened.

Formally, for each out-of-year date `D`: `D' = correctedDate(D, sheet_year)` (same month/day,
tab's year; null if the year already matches, the tab year is unknown, or `D'` is not a real
calendar date — Feb 29 into a non-leap year is refused, never rolled over). Settle `D'` iff
`D'` is not already settled, the DB holds ≥1 movement for `D'`, and the DB's multiset of
`movementSig` (the SAME `(particular, bag_type_code, qty_delta)` identity the day-set
classifier uses) EXACTLY equals the mis-dated sheet rows' multiset. An empty DB day, a missing
row, or a changed quantity does NOT settle — silence is never agreement. Pure core:
`src/reports/flecon/settlement.ts::computeFleconSettlements` (mirrors the
`workflows/settlement.ts` pure/IO split). Everything else is settled by a human seeding the
ledger directly.

**THE READ FAILS CLOSED — an unreadable ledger REFUSES the run (2026-08-26).** The read and
the write used to share one `try { … } catch { settledDates = new Set() }`, so a failure to
read `flecon_bag_date_settlements` degraded to *"nothing is settled"* and the run carried on
with the protection silently switched off. That is exactly **L-044's** shape: a read that fails
quietly and renders as "nothing to report" — except here the consequence is not a missing
alarm, it is REPLACE-BY-DATE deleting a day a human deliberately arbitrated (the 2026-01-31
backfill exists nowhere in the sheet). **A protection that cannot be read is a protection that
is not in force.** So `deps.db.readFleconSettledDates()` now runs FIRST — immediately after the
email is found, before the workbook is even opened — and on failure `runReport` returns
`ok: false` with a `settlement_ledger_unreadable` gate failure naming the read error, having
done **no extract-compare, no classify, no write, no watermark move and no Gmail label**. The
next run tries again.

The split is deliberate: **reading** the ledger is fail-closed, **adding** a new settlement to
it stays best-effort. Failing to record a NEW settlement loses nothing that was already
protected, so it degrades to `knownSettled` — never to an empty set — and must not stop the run.

**Where it's written.** Inside `reports/flecon/index.ts::runReport`, right after extract and
before classify (the READ is earlier still — see above), with the compute/insert half guarded
so its failure degrades to the already-known settled set, never to a wrong write. Writer:
`DbClient.insertFleconSettlements` (service role; upsert on the `transaction_date` PK with
`ignoreDuplicates`, and `.select()` returns only the rows actually inserted — the same id-less
table trap `insertSettlements` hit, since this table has NO `id` column). Because it runs
before the skip filter, a date that settles during a run is already skipped on that SAME run.
**`makeDryRunDb` MUST list `insertFleconSettlements`** — the proxy is
`Object.create(DbClient.prototype)`, so an unlisted method falls through to the real client and
a "dry" run would permanently settle a date.

**Skip chokepoint — BOTH sides, not just the sheet.** `runReport` filters settled dates out of
`extract.rows` AND the DB compare-set (`flecon_bag_movements` since the window) AND
`extract.flagged_rows`. Filtering only the sheet side would leave the date present in
`db_by_date` with an empty sheet day, which classifies `DATE_CHANGED`-to-zero and lands in
`delete_to_empty_blocked` — a held row, not a skip. `applyFlecon` additionally carries
`opts.settledDates` and skips any such `per_date` entry outright (counted in
`settled_dates_skipped`, no held row — silence by design), so "a settled date is never
deleted" is true of the apply on its own. `classifyCase` (the parity-frozen entrypoint) is
untouched; the filter lives only in the live orchestrator, which has DB access it does not.

**Interaction with §5a's `out_of_year_date`.** A settled date SUPPRESSES the finding entirely
(the assertion "these rows were NOT imported and never will be" became false the moment they
were backfilled). Suppression maps the flagged row through `correctedDate` because the flagged
row carries the TYPO date (`2025-01-31`), not the settled one (`2026-01-31`). A genuinely NEW,
un-arbitrated out-of-year date still fires at full volume.

**One-way ratchet** — same accepted edge case as `rc_out_date_settlements`: a later correction
to a settled date needs a manual `DELETE FROM flecon_bag_date_settlements`.

**Tests:** `test/reports/flecon-stale-unjam.test.ts` (12) — the fail-closed read, its readable
control, and the "could not RECORD a settlement" degrade (plus §5b/§5c). And
`test/reports/flecon-settlement.test.ts` (19) — the pure criterion and its refusals,
the apply-level "settled ⇒ never replaced" with a control proving the delete path is live
without the ledger, the end-to-end January-floor `runReport` (SETTLED / AUTO-SETTLE / CONTROL),
the cross-check timing fix, and the out-of-year suppress-vs-fire split.

---

## 6. Rule checklist

| Rule | Where | Parity test must assert |
|---|---|---|
| replace-by-date-bounded-since | sync_flecon.py:161-164 | A date below `since` is NEVER touched even if it somehow appears in the classified per_date list. |
| day-set-multiset-noop | classify_flecon_bags.py `day_multiset`/`Counter` equality | Two days with the exact same multiset of (particular,code,qty) — even in different ROW ORDER — classify NOOP, not DATE_CHANGED. |
| column-header-signature-map | extract_flecon_bags.py `map_columns` | A column whose SKU was moved to a different letter (operator reshuffle) still maps correctly via its combined row-3/5/6 signature; an ambiguous match (2+ candidates) is left UNMAPPED, never guessed. |
| unmapped-column-flagged | classify_flecon_bags.py `column_flags` | An unmapped column with real data is surfaced in `unmapped_columns`, never silently dropped, never auto-registered. |
| never-auto-create-bag-type | sync_flecon.py apply (no bag-type INSERT logic exists anywhere in this file) | Confirm the TS port has NO code path that creates a `flecon_bag_types` row from an unmapped column — it must remain a pure hold. |
| REPLACE audit operation | lib/db.py `insert_manual_audit`, migration 20260703043000 | An audit_logs row with `operation='REPLACE'` inserts successfully (requires the widened CHECK constraint in the target schema). |
| never-wipe-a-day (BUG-015 C2) | TS apply.ts `delete_to_empty_blocked` | A `DATE_CHANGED` date whose movement list is EMPTY is HELD — `replaceFleconDate` is never called for it. |
| refuse-a-stale-workbook (BUG-015 C1) | TS index.ts + apply.ts `stale_workbook` | A workbook whose latest date < the DB watermark writes NOTHING, updates no watermark, and reports a classify `gate_failure`. |
| a-dead-email-is-labeled-once (§5b) | TS apply.ts stale early-return | A STRICTLY-older stale workbook IS labeled processed (so it stops re-firing) while still writing nothing and still returning `ok:false`; a `workbookMaxDate === null` workbook and a `noLabel` dry run are NOT labeled; a labeling throw yields `labeled:false` and no apply error. |
| stale-message-names-a-real-date (§5c) | TS index.ts `wholeSheetMaxDate` | With every sheet row below the `since` floor, `summary.date_max` is null but the gate detail still names the workbook's own last date; an out-of-year (typo) date never raises that maximum. |
| settled-read-fails-closed (§6a) | TS index.ts `readFleconSettledDates` | A throwing ledger read produces `ok:false` + a `settlement_ledger_unreadable` gate failure, a null `classified`/`apply`, and ZERO calls to `replaceFleconDate` / `upsertIngestionWatermark` / `labelProcessed`. A throwing `insertFleconSettlements` does NOT fail the run and every already-settled date is still skipped. |
| mis-dated-rows-are-loud (BUG-015 A) | TS extract.ts `flagged_rows` + apply.ts `out_of_year_date` | The real `flecon_real_latest` fixture (A75 = `2025-01-31` inside the `JANUARY 2026` tab) yields exactly 5 out-of-year flagged rows (75–79) and ONE held row — and still emits ZERO movements for that date. |
| settled-date-is-never-deleted (BUG-020, §6a) | TS index.ts skip filter + apply.ts `opts.settledDates` | A re-run scoped back to `2026-01-01` with `2026-01-31` settled never calls `replaceFleconDate` for it and produces no `per_date` entry; the same run without the ledger DOES (control). |
| settled-date-suppresses-out-of-year (BUG-020, §6a) | apply.ts `buildFlaggedRowHolds(…, {dates, sheetYear})` | With `2026-01-31` settled, the `2025-01-31` typo group raises NO held row; a different, un-arbitrated out-of-year date still raises one. |
| crosscheck-reads-post-write (BUG-020, §3a) | apply.ts `recomputeCrosscheckRows` + `readBalances` | A run that imports the movements reports ZERO drift once balances are re-read; a genuine 1-bag gap after the write STILL reports. |

---

## 7. Fixture shopping list

- Real (or realistic synthetic) FLECON BAG MOVEMENT workbook with: the multi-row header (rows 3/5/6) for at least 2 columns whose row-5 text is ambiguous alone (e.g. both say "FG"), a month-section-header row, a `"RS 1 ZAMBOANGA"` marker row AND a `"RS 1 ZAMBAONGA"` (typo) marker row (both must stay distinct), a balance-snapshot row (no date/particular, has quantities), a multi-column single-row movement (blend/recount touching 2 bag types), an opening-balance row (row 7) with a mix of populated and blank cells.
- A registry fixture (`flecon_bag_types` rows) deliberately reshuffled column-order relative to the workbook, to prove signature-matching survives a reshuffle that a fixed-column mapping would not.
- An UNMAPPED-column fixture: a real data column whose combined signature matches NO registry entry.
- An AMBIGUOUS-match fixture: two registry entries whose normalized labels both exact-match (or both contains-match) the same column signature — must leave that column UNMAPPED with the ambiguity warning, never guess.
- A day-set DATE_CHANGED fixture: same date, same total row count, but one movement's `qty_delta` differs by 1 — must classify DATE_CHANGED (whole-day replace), not NOOP.
- A day-set NOOP fixture: identical multiset but with rows in a DIFFERENT order in the sheet vs however the DB returns them — must still classify NOOP (Counter equality is order-independent).

---

## 8. Porting traps (flecon-specific)

1. **The only report type whose apply reaches into the raw HTTP session (`db._session.delete(...)`)** rather than a wrapped `DBClient` method — a TS port's equivalent `db` client should expose (or the flecon apply logic should use) an explicit `deleteByDate`-style method rather than a raw fetch call, but the SEMANTICS (unconditional DELETE WHERE transaction_date=eq.d, `Prefer: return=minimal`) must be preserved exactly.
2. **The movement payload's `remarks` field is always `None` in practice** — the extractor never populates it. Do not "fix" this by trying to derive a remarks value from `particular` or elsewhere; port the actual (currently always-null) behavior, and flag the vestigial field for a human decision on whether to wire it up or remove it.
3. **`--since 2026-01-01` is HARDCODED as flecon's first-run floor**, unlike every other pipeline's `2025-01-01` — this is because flecon's DB data genuinely starts in 2026 (Renzo's bagging inventory feature is newer). Do not "normalize" this to match other pipelines' 2025 floor.
4. **The extractor's confidence formula uses a `0.05` per-warning coefficient and a `0.5` floor**, both DIFFERENT from every other extractor's `0.10`/`0.0`. This is a genuine per-file divergence, not a shared constant — preserve it exactly for this file only.
5. **`db_present` in the classifier is a dict-key-membership check (`d in db_by_date`), not a truthiness check on the list value** — since `db_by_date` is a `defaultdict(list)`, accessing a missing key via `.get(d, [])` elsewhere in the same function would NOT raise, but would also not tell you whether the key was genuinely absent vs present-with-an-empty-list. The code correctly uses the `in` operator for this specific check; a TS port using a plain object/Map must replicate "was this key ever set" semantics, not "is the array non-empty" semantics, for the NEW-vs-other branch.
