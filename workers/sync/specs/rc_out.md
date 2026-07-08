# rc_out.md — PROPOSED DAILY REPORT (email) → `rc_out`

Scripts: `extract_proposed_daily.py` (426 lines), `extract_rc_movement.py` (242 lines, shared
with rc_movement_audit.md), `reconcile_rc_movement.py` (210 lines), `classify_rc_out.py` (330
lines), `sync_rc_out.py` (348 lines).

Read SHARED.md first.

---

## 1. Pipeline narrative (`sync_rc_out.py`)

1. **Watermark**: `watermark = data_watermark(db, "rc_out")`. `since = watermark - 3 days` (tail-scope) or `"2025-01-01"`.
2. **Fetch PROPOSED**: Gmail query `label:"Work/ICTC Daily" subject:"PROPOSED DAILY REPORT" after:{since} -label:"Blackwood-Processed"` (GMAIL_PROP, sync_rc_out.py:59). No xlsx → early-return `ok:true`, empty `classified_path`.
3. **Fetch RC MOVEMENT** (cross-check, optional): `subject:"RC MOVEMENT" newer_than:7d -in:sent` (GMAIL_RCM, sync_rc_out.py:60) — fixed 7-day window, NOT watermark-scoped.
4. **Extract PROPOSED**: `extract_proposed_daily.py --file {xlsx} --year {int(since[:4])} --all-sheets` — ALWAYS `--all-sheets` (unlike deliveries, which relies on `wb.active`). `year` is derived from the FIRST 4 chars of the computed `since` string, not the current wall-clock year.
5. **GATE 1** (if `rcm_xlsx` present): extract RC MOVEMENT (`--all-sheets`), then run `reconcile_rc_movement.py` comparing PROPOSED-sums-by-date vs RC-MOVEMENT-fed-kls-by-date with `--tolerance-kg 50 --serious-drift-kg 500`, NO `--rc-out-sums-json` (so this pass ONLY checks P vs M, not the DB duplication signal). If the reconcile exits `>=2` (serious) → `gate_failures` gets `{"gate":"proposed_vs_movement_drift_500kg", ...}`.
6. **GATE 2**: computes `_rc_out_sums(db, since)` (sums `rc_out.weight_kg` grouped by date, over the SAME `since` window used for PROPOSED extraction — NOT a wider window), writes to `rc_out_sums.json`, re-runs `reconcile_rc_movement.py` a SECOND time WITH `--rc-out-sums-json` supplied (this activates the DB-vs-RC-MOVEMENT duplication gate inside the reconciler). If `>=2` → `gate_failures` gets `{"gate":"db_vs_movement_duplication", ...}`.
7. If `rcm_xlsx` is ABSENT entirely, BOTH gates are skipped with a `[warn]` log line — "reconciliation gates skipped (cannot verify drift)" — meaning a run with no RC MOVEMENT email present has **zero drift protection** and will classify/apply purely on PROPOSED-vs-DB natural-key matching.
8. **Classify**: builds `batch_lookup.json` (`{batch_code: id}` for ALL batches, no date filter — `since_column=None`), fetches `rc_out` DB rows over the compare-set window, runs `classify_rc_out.py` passing `--watermark {watermark}` IF a watermark exists (omitted only for a fresh/empty table — a genuine first-run backfill). **L-034: the compare-set window is `min(min(extracted transaction_date), since)`, NOT plain `since`** — the extractor yields the workbook's oldest sheet rows (older than `since = watermark − 3d`), so fetching at `since` would leave those settled rows without their saved DB copies and false-flag them as sub-watermark. Widening to the extract's own min guarantees every incoming row is compared against its saved copy. Bounded, so it never reads the whole table.
9. `gate_tripped = bool(gate_failures)`. **Even when a gate trips, the classify envelope is STILL emitted with the full classification** (for review) — only `ok` is set `false`. The apply phase is what actually refuses to write (see Gates section below).

### Apply phase (`phase_apply`, sync_rc_out.py:226-327)

1. **First check**: if `compact["gate_failures"]` is non-empty, apply writes NOTHING — emits `ok:false`, `held` = one entry per gate (`reason: gate name`), `errors` = one string per gate, returns exit code 1. This re-check happens INSIDE apply, independent of whatever `--only-clean`/`--input` was passed — the gate state travels with the classified file.
2. NEW rows → `insert_if_absent("rc_out", ..., natural_key=(transaction_date, batch_id, destination))`, then `insert_manual_audit` (rc_out has NO audit trigger).
3. VALUE_CHANGED rows → `db.update(...)` then `insert_manual_audit` (operation UPDATE, unconditional — no trigger-stamp attempt since rc_out never has a trigger).
4. `flagged`/`unmapped`/`malformed` → always `held`, never written.
5. Label + watermark only if `not errors`.

---

## 2. Extraction spec (`extract_proposed_daily.py`)

### Sheet anatomy

One sheet per DAY, sheet name format `"{3-LETTER-OR-FULL MONTH} {DAY}"` e.g. `"MAY 26"` — matched by `SHEET_NAME_RE = r"^([A-Z]+)\s+(\d{1,2})\s*$"` (case-insensitive). `sheet_name_to_date(name, year)` resolves the month word via `MONTH_NAME_TO_NUM` (a combined dict accepting BOTH abbreviations and full names, e.g. both `"MAR"` and `"MARCH"` map to `3`) and combines with the CLI-supplied `--year`.

### Block-section detection

`find_block_section_starts(ws)` (extract_proposed_daily.py:189-196): scans every row's column A; a row where the cell text contains BOTH `"WHSE"` and `"#"` (case-insensitive substring match, e.g. `"WHSE # 1"` or `"FEEDING AREA #1"` — actually this is looking for the header row of a section, not literally "WHSE #"; verify against real fixtures) marks the start of a new block section.

Each section spans 7 rows relative to its start row `R`:

| Offset | Column B (label) | Column L (stat, col=12) | Column M (col=13) |
|---|---|---|---|
| R+0 | WHSE label | STRT. BAL | status |
| R+1 | BLOCK DATE | DAY TOTAL | (supplier sometimes here too) |
| R+2 | BLOCK NO. | END BAL. | supplier |
| R+3 | Gross weight (pallet columns start at col B=2) | REMARKS | |
| R+4 | Pallet (sacks count) | | |
| R+5 | Net (pallet net weight) | | |
| R+6 | blank separator | | |

Pallet columns are scanned from column 2 onward on row `R+3` until a sentinel cell is hit (`{"REMARKS","DONE","DONE FEEDING","FOR FEEDING","MC AVERAGE:",""}`, case-insensitive after strip) — each numeric cell found becomes one pallet's gross weight, with its sack-count (row `R+4`) and net weight (row `R+5`) read from the SAME column index.

### FEED vs standard block

`is_feed = "FEEDING AREA" in whse.upper()` (substring, not exact match). Feed blocks get `block_loc = None`; standard blocks get `block_loc = whse` (the raw WHSE label string itself, e.g. `"A-1A"` — assumed already in Blackwood block_loc format for standard sections).

### `day_total_kg` derivation

Primary: the DAY TOTAL cell (`R+1`, col 12). If missing, falls back to `sum(pallets_net)` with a warning noting the derivation. If NEITHER is available (`day_total is None` and `pallets_net` is empty), the whole section returns `None` (never emitted) with a warning `"no DAY TOTAL and no pallet nets"`.

### `derive_batch_codes` — primary + fallback prefix generation (VERBATIM)

`PRIMARY_MONTH_PREFIX` (extract_proposed_daily.py:48-52):
```
1:JAN 2:FEB 3:MARCH 4:APRIL 5:MAY 6:JUNE 7:JULY 8:AUG 9:SEPT 10:OCT 11:NOV 12:DEC
```
`FALLBACK_MONTH_PREFIX` (lines 55-59):
```
1:JANUARY 2:FEBRUARY 3:MAR 4:APR 5:MAY 6:JUNE 7:JULY 8:AUGUST 9:SEPTEMBER 10:OCTOBER 11:NOVEMBER 12:DECEMBER
```
`yy = f"{block_date_val.year % 100:02d}"` (2-digit, zero-padded). `kind = "FEED" if is_feed else "BLK"`. `primary_code = f"{PRIMARY_MONTH_PREFIX[month]}-{yy}-{kind}{block_no}"`, `fallback_code = f"{FALLBACK_MONTH_PREFIX[month]}-{yy}-{kind}{block_no}"`. If `primary_code == fallback_code` (true for months 5,6,7 where primary and fallback are identical strings: MAY/MAY, JUNE/JUNE, JULY/JULY), returns `([primary_code], [])` — no fallback list at all. Otherwise `([primary_code], [fallback_code])`. **`block_date_val` here is the BLOCK DATE cell (row R+1), NOT the sheet-name-derived `transaction_date`** — these can differ (a block dated in a prior month, feeding on today's sheet).

### CLOSED/status derivation

`closing_phrases = {"DONE", "DONE FEEDING", "CLOSED"}` (exact match after strip+upper). Checked against BOTH `status` (col M, WHSE row) and `remarks` (col L, row R+3) — either matching sets `is_closing=True` and `rc_remarks = "CLOSED"` (a normalized literal, regardless of which exact closing phrase triggered it). If not closing but `remarks` is present and NOT `"FOR FEEDING"` (exact, case-insens), `rc_remarks = remarks` (preserved verbatim) — i.e. `"FOR FEEDING"` is treated as a pure status marker and dropped, never written to `remarks`.

### `production_batch` derivation

`transaction_date.strftime("%b").upper()` by default (3-letter abbreviation, e.g. `"JAN"`), EXCEPT month 5 (May) is hardcoded to `"MAY"` (same as `%b` anyway) and month 6 (June) is hardcoded to `"JUNE"` (full word, OVERRIDING what `%b` would produce, which is `"JUN"`). **This is the only override in the extractor** — months other than 5 and 6 get the raw 3-letter abbreviation (`"JAN"`, `"FEB"`, `"MAR"`, `"APR"`, `"JUL"`, `"AUG"`, `"SEP"`, `"OCT"`, `"NOV"`, `"DEC"`). This is DIFFERENT from `production_batch` conventions elsewhere (e.g. production.md's full-month-name convention) — flag this as an inconsistency across the codebase, verbatim as coded.

### Units / rounding / MALFORMED

- `day_total_kg` must be within `(0, 200_000)` exclusive or a warning is added (still emitted).
- `confidence = max(0.0, 1.0 - 0.10*len(warnings))`.
- A section with `whse` blank/None is skipped entirely (returns `(None, [])`) — no warning, treated as a non-section row.
- The extractor's own MALFORMED-equivalent: a section with no derivable batch_code candidates still gets EMITTED (with `batch_code_primary=None`) plus a warning — deferred to the classifier's `UNMAPPED` bucket via `resolve_batch_id` returning `(None, None)`.

---

## 3. Classification spec (`classify_rc_out.py`)

### Natural key

`(transaction_date, batch_id, destination)` where `destination` defaults to `"MAIN"` if absent (classify_rc_out.py:83-84, 232).

### Batch resolution (`resolve_batch_id`, lines 87-98)

Try `batch_code_primary` against `batch_lookup` dict first; if absent/unresolved, try EACH `batch_code_fallbacks` entry in list order, first hit wins. No match on either → `(None, None)` → UNMAPPED.

### Equality / NOOP demotion rules (`field_differences`, lines 101-148)

| Field | Rule |
|---|---|
| `weight_kg` | `norm_num(..., 3)` on BOTH `extracted.weight_kg` (falling back to `extracted.day_total_kg` if `weight_kg` absent) and `db_row.weight_kg`; diff if unequal at 3dp |
| `remarks` | `norm_str` equal, null≡empty |
| `production_batch` | `norm_str` equal, null≡empty. **L-034 month-boundary demotion:** if `production_batch` is the ONLY differing field, the row is NOT a VALUE_CHANGED — it is demoted to a NOOP plus a `soft_warnings[]` note ("label differs, but record is already saved — no action needed"). A last-day-of-month feeding whose sheet header names the next month gets the calendar-month label on the row while the DB holds the header-month label; both are defensible for the same saved feeding, so no UPDATE (and no hold) is warranted. |
| `block_loc` | **Only compared if the extracted side is non-null and non-empty** — if the Sheet/report side has NO block_loc info, the DB's value (even if populated via a join) is never diffed. This is because RC OUT's `block_loc` is typically empty in the DB and derived from `batches.location_ref` via a view join rather than stored directly. |

Beyond the L-034 production_batch-only demotion above, no materiality/immateriality gate — every surviving diff is material (unlike gsheet's `is_material`).

**`soft_warnings[]` (L-034):** the classify output carries an informational, non-holding `soft_warnings` array (empty by default; parity-mirrored on both engines). Each entry is `{kind, index, natural_key, db_id, message}`. The orchestrator surfaces the messages on the live feed as a `warn`-level progress beat and threads them onto the classify block (`classifyExtra.soft_warnings`) so they reach the app without being dropped by `normalizeReport.ts`. They never gate a write.

### FLAGGED kinds — exact trigger conditions

1. **Sub-watermark write guard** (L-019): a row with NO natural-key match (`matches` empty) where `watermark is not None` AND `ex_row["transaction_date"] <= watermark` → routed to `flagged`, NEVER to `new`, regardless of how confident the extraction is. This is a HARD string comparison on ISO date strings (`"2026-05-29" <= "2026-06-16"` — lexicographic, which works correctly for zero-padded ISO dates). **L-034 fix — compare-set window:** this guard used to FALSELY fire on settled rows that WERE saved, because the dedup compare-set was fetched at the `since = watermark − 3d` floor while the extractor still yields the workbook's oldest sheet rows (e.g. the "JUNE 30" sheet permanently carried in the JULY workbook). Any incoming row older than `watermark − 3d` was compared against a snapshot that could not contain its saved copy → false hold, recurring every month-end. The orchestrator (`sync_rc_out.py` / `index.ts::runReport`) now widens the compare-set floor to `min(min(extracted transaction_date), watermark − 3d)` (bounded — never earlier than the extract's own min), so the saved copy is in `matches` and the row is a NOOP (or the L-034 label-variance NOOP). Reaching THIS flagged branch now means a genuine miss (no DB copy at all).
2. **UNMAPPED** (lines 218-227): `resolve_batch_id` returns `(None, ...)` — no primary or fallback code resolves to a `batch_id`.
3. **L-037 balance-integrity hold** (`balance_integrity`, runs AFTER batch resolution / enrich, BEFORE the natural-key routing): a resolvable row is FLAGGED (never written) when its scraped DAY TOTAL cannot be trusted. Two checks, `BALANCE_TOL_KG = 1.0`:
   - **(a) within-block**: `abs((strt_bal_kg − end_bal_kg) − day) > 1` where `day = weight_kg or day_total_kg`. This is the June-10 signature — the operator wrote a **cross-block cumulative** (day-opening minus THIS leg's end, e.g. `65,763 − 34,018 = 31,745`) into a continuation leg's DAY TOTAL, so the scraped value over-states the block's own feeding (`54,950 − 34,018 = 20,932`).
   - **(b) continuity**: `abs(strt_bal_kg − prev.end_bal_kg) > 1` when the immediately-prior extracted section describes the **SAME slot on the SAME day** (`transaction_date`, `norm_str(whse_label)`, and `block_no` all equal) — a re-feed of one physical slot whose opening balance does not continue the prior leg's close. This is the "discrepancy between previous and latest entry" monitor.
   - Fires ONLY when the required balances are BOTH present (a blank STRT/END — e.g. a FEED section with no END cell — is never held). Running BEFORE the natural-key match means a corrupt cumulative can neither insert as NEW nor overwrite a corrected DB row as VALUE_CHANGED. The **pallet-Net sum is deliberately NOT a trigger**: real reports list pallets only partially (pathway/SUNDRY zones carry none), so `sum(pallets_net)` diverges widely from DAY TOTAL across the corpus even though `STRT − END == DAY TOTAL` holds to the exact integer — a net-sum gate would false-hold constantly. The extractor is unchanged (it still scrapes DAY TOTAL per block, scoped, and never reaches into a previous block); the guard is a pure validation layer in classify.
4. **MALFORMED** (lines 208-214): missing `transaction_date`, OR `weight_kg`/`day_total_kg` is `None` or exactly `0` (note: `float(w) == 0` — a section whose day total genuinely IS zero, e.g. a block that received nothing that day, is treated as malformed/dropped, not a legitimate zero-weight NOOP).

### The `L-002`/`L-003`/`L-010`/`L-011`/`L-012` judgment rules

**None of these are codified in `classify_rc_out.py` or `extract_proposed_daily.py`.** They are documented in LEARNING_LEDGER as manual agent-adjudication patterns (pathway/overflow SUNDRY zones, bare-integer continuation sections, batch-slot remapping, misattributed feed reassignment, double-count DELETE resolution) that a human/agent applied by hand during specific historical syncs. **Flag for a human decision**: should any of these be codified into the TS classifier (e.g. an `ANEAR PATHWAY`/PC-zone detector, a bare-integer section suppressor), or do they remain permanently judgment-only, surfaced via the generic UNMAPPED/FLAGGED buckets and resolved by a human on a case-by-case basis? Currently NOTHING in the extractor specifically detects "bare-integer section = continuation" (L-003) — such a section, if it has a DAY TOTAL, would currently be extracted as ITS OWN block section and inflate the daily total, exactly as the ledger entry describes the ORIGINAL bug. There is no evidence this was ever fixed in `extract_proposed_daily.py` — re-verify against a real fixture matching the L-003 symptom before assuming it's handled.

---

## 4. Gates & reconciliation

### HARD gates (both must be green for `ok:true`)

1. **`proposed_vs_movement_drift_500kg`**: `reconcile_rc_movement.py` run WITHOUT `--rc-out-sums-json`, comparing PROPOSED sums vs RC MOVEMENT `date_to_fed_kls` per date. `serious_drift_kg=500` (hardcoded in `sync_rc_out.py:66`, passed as CLI arg — NOT the reconciler's own default of 500.0, though they happen to match). `tolerance_kg=50`. Trips (returns exit code `2`) if `abs(P - M) > 500` for ANY date OR `abs(P - O) > 500` (PROPOSED vs EXISTING rc_out, only relevant on a re-run) for any date, where `O` here is NOT populated in this first pass (no `--rc-out-sums-json` given) so `p_vs_o_drift` never fires in GATE 1.
2. **`db_vs_movement_duplication`**: SAME reconciler script, SECOND invocation, this time WITH `--rc-out-sums-json`. This activates `o_vs_m_excess = O - M` per date, walked over `set(proposed_by_date) | set(rc_out_sums)` (ALL dates the DB has data for in the window, not just PROPOSED dates — this is deliberate, per L-019, so DB-side duplication on a date PROPOSED no longer covers is still caught). Trips if `o_vs_m_excess > 500` for ANY date. **An `O` below `M` NEVER trips anything** (continuous-flow tank; expected).

### Reconciler internals (`reconcile_rc_movement.py`)

- `proposed_by_date[d] = sum(weight_kg or day_total_kg)` across all PROPOSED rows for date `d`.
- `movement_date_to_fed = movement["date_to_fed_kls"]` (a dict already summed across month-tabs by the extractor — see rc_movement_audit.md / L-022).
- `rc_out_sums` accepted in EITHER shape: `{date: float}` dict OR `[{transaction_date|date, total_kg|sum|weight_kg}]` list (auto-detected).
- Per-date severity: `abs(drift) > serious_drift_kg` → `max_drift_severity=2` (serious); `> tolerance_kg` (but ≤ serious) → `max_drift_severity=1` (warning, does NOT halt). The reconciler's own exit code IS `max_drift_severity` (0/1/2) — `sync_rc_out.py` checks `rc1 >= 2` / `rc2 >= 2`, so a WARNING-level drift (severity 1) is recorded in the report but does NOT gate.
- **`ok` in the reconciler's own stdout summary is `max_drift_severity < 2`** — but `sync_rc_out.py` never reads this stdout `ok` field; it re-derives gate status from the subprocess RETURN CODE (`rc1`, `rc2`), reading the JSON report file directly for detail.

### `>50-NEW` and `confidence<0.7` gates

**These do NOT exist in `classify_rc_out.py` or `sync_rc_out.py`.** The `>50 NEW` safety check and the `confidence < 0.7` block ARE present, but ONLY in `sync_gsheet.py`'s legacy apply path (`_apply_from_compact`, lines 317-326) — they gate the **gsheet** RC OUT/RC IN write, not the email-driven rc-out-manager pipeline. Do not conflate the two — see gsheet.md for the actual >50/confidence gate spec. `rc_out` (email) has NO count-based or confidence-based apply gate; its only gates are the two drift/duplication HARD gates above, which run entirely at CLASSIFY time.

### Sub-watermark guard

Covered above (§3, FLAGGED kind 1) — implemented INSIDE `classify_rc_out.py`, not the orchestrator.

---

## 5. Apply spec

### Write order

1. Gate re-check (halts everything if `gate_failures` non-empty — see §1).
2. NEW rows → `insert_if_absent("rc_out", ..., natural_key=(transaction_date, batch_id, destination))` → `insert_manual_audit` (operation INSERT).
3. VALUE_CHANGED → `db.update(...)` → `insert_manual_audit` (operation UPDATE).
4. flagged/unmapped/malformed → `held`, reasons `"flagged"` / `"unmapped_batch_code"` / `"malformed"` respectively.

### Payload field list (INSERT)

```
transaction_date, batch_id, destination (default "MAIN"), weight_kg, remarks,
block_loc, production_batch
```
No `cost_basis` — `rc_out` has no such column.

### Audit mechanism

Manual-INSERT via `write_ingestion_audit` RPC — `rc_out` has NO audit trigger (unlike `deliveries`). EVERY write (both INSERT and UPDATE) goes through `insert_manual_audit`, never `update_trigger_audit_provenance`.

### Idempotency

`insert_if_absent` on `(transaction_date, batch_id, destination)`.

### Held-row reasons

`unresolved_batch_id` (a NEW item somehow reached apply without a resolved `batch_id` — defensive, shouldn't happen since classify already routes unresolved rows to `unmapped`), `already_exists`, `flagged`, `unmapped_batch_code`, `malformed`, plus the two gate-name reasons if a HARD gate tripped.

### Label + watermark

Only if `not errors` (note: this does NOT check for `held` rows the way deliveries's comment implies checking "non-held unapplied" — `sync_rc_out.py` labels purely on `not errors`, full stop, even if many rows are held).

---

## 6. Rule checklist

| Rule | Where | Parity test must assert |
|---|---|---|
| L-002 (SUNDRY/pathway zones) | NOT codified — judgment only | A pathway-labeled feed is NOT auto-derived to a regular BLK code; it should reach UNMAPPED or a low-confidence signal for human triage (verify current behavior — likely just resolves to whatever `derive_batch_codes` computes, which may be WRONG; flag as a real gap). |
| L-003 (bare-integer continuation) | NOT codified — appears to be a live gap | A bare-integer WHSE section with no BLOCK DATE currently has no explicit suppression in `find_block_section_starts`/`extract_block_section` — verify against a real fixture whether it's actually extracted as its own row (inflating totals) or filtered by some other check not obviously visible in the read code. |
| L-004 (rc_out flavor doesn't apply — deliveries only) | n/a | n/a |
| L-010 (batch-slot remap to ACTIVE occupant) | NOT codified | judgment only, human-resolved |
| L-011/L-012 (misattributed feed reassignment/dedup) | NOT codified | judgment only, human-resolved |
| L-019 (full-span dedup + sub-watermark guard) | classify_rc_out.py:236-252 | A settled-date row with no natural-key match is FLAGGED, never INSERTed, when `--watermark` is passed. |
| L-037 (balance-integrity guard) | `classify_rc_out.py::balance_integrity` + `classify.ts::balanceIntegrity` | A two-leg same-batch same-day sheet whose legs are internally consistent yields BOTH legs' own DAY TOTALs ([10,813, 20,932], never [10,813, 31,745]); a leg whose DAY TOTAL disagrees with STRT−END is FLAGGED ("cross-block cumulative"); a same-slot section whose STRT ≠ the prior leg's END is FLAGGED ("slot continuity"); a blank-balance section is never held; a corrupt DAY TOTAL matching a corrected DB row is FLAGGED, not VALUE_CHANGED. |
| L-020 (idempotent insert) | sync_rc_out.py:265 | Re-running apply twice on the same classified file inserts nothing the second time. |
| rc_out-drift-gate-500kg | sync_rc_out.py Gate 1 | `abs(P-M) > 500` on any date → `ok:false`, apply writes nothing. |
| rc_out-db-duplication-gate | sync_rc_out.py Gate 2 | `O-M > 500` on any date the DB has rows for → `ok:false`, apply writes nothing. |
| L-022 (cross-month tab summing) | extract_rc_movement.py (shared) | see rc_movement_audit.md |

---

## 7. Fixture shopping list

- Real PROPOSED DAILY REPORT sample with: a standard block section, a FEEDING AREA (FEED) section, a "DONE"/"DONE FEEDING" closing section, a section whose remarks say "FOR FEEDING" (must be dropped, not preserved), a section with a BLOCK DATE in a different month than the sheet-name date (to test fallback-prefix derivation independent of `transaction_date`).
- A synthetic cross-month-boundary date (May 31 / June 1) appearing in BOTH a "MAY 2026" and "JUNE 2026" RC MOVEMENT tab, to verify the reconciler's gate correctly treats the DB's summed total as legitimate (per L-022) rather than phantom duplication.
- A sub-watermark FLAGGED fixture: a PROPOSED row dated BEFORE the DB watermark with no matching natural key.
- A GATE-1-tripping fixture: PROPOSED daily total off from RC MOVEMENT by >500kg.
- A GATE-2-tripping fixture: DB `rc_out` SUM for some date exceeding RC MOVEMENT by >500kg (simulate a historical duplication).
- An UNMAPPED fixture: a section whose derived batch_code (primary + all fallbacks) doesn't exist in `batch_lookup`.
- A bare-integer "continuation" section fixture (L-003 symptom) to determine CURRENT actual behavior before porting — this needs empirical verification against the real extractor, not just the ledger's description.

---

## 8. Porting traps (rc_out-specific)

- `production_batch` derivation in `extract_proposed_daily.py` hardcodes ONLY May→`"MAY"` and June→`"JUNE"` as full-word overrides; every other month stays a 3-letter `%b`-style abbreviation. This is inconsistent with the production pipeline's full-month-name convention (`MONTH_NAME_UPPER` in extract_daily_production.py) — do NOT unify these without an explicit decision; they are genuinely different fields feeding different tables historically.
- `is_feed` detection is a case-insensitive SUBSTRING match (`"FEEDING AREA" in whse.upper()`), not an exact match or regex — a WHSE label containing that substring anywhere (even embedded in a longer label) is treated as a feed block.
- The block-section-start detector's condition (`"WHSE" in v.upper() and "#" in v`) is a loose substring check on column A text — verify against real fixtures exactly what strings appear there; a mis-detected section start would silently misalign the entire 7-row offset scrape for that section AND every section after it if row counts drift.
- `classify_rc_out.py`'s sub-watermark comparison (`ex_row["transaction_date"] <= watermark`) is a STRING comparison, not a parsed-date comparison — relies on both sides being zero-padded ISO `YYYY-MM-DD` strings for correct lexicographic ordering. A TS port using a different date serialization must preserve zero-padding or switch to true date comparison.
- The two reconcile passes in `sync_rc_out.py` run the EXACT SAME external script (`reconcile_rc_movement.py`) TWICE with different arguments — a naive TS port might try to merge these into one call; preserve the two-pass structure since the gates are logically and temporally distinct (P-vs-M is checked before the DB sums are even computed).
