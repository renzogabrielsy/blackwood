# deliveries.md — RC IN (email) → `deliveries`

Scripts: `extract_rc_deliveries.py` (601 lines), `enrich_prices.py` (286 lines),
`classify_deliveries.py` (273 lines), `sync_deliveries.py` (437 lines), plus shared
`lib/deductions.py` (see SHARED.md §general — deduction grammar is documented in full here
since deliveries is its primary consumer).

Read SHARED.md first — this spec does not repeat the Gmail/db.py/orchestrator_common contracts.

---

## 1. Pipeline narrative (`sync_deliveries.py`)

1. **Watermark** (sync_deliveries.py:81-83): `watermark = data_watermark(db, "deliveries")` (MAX `transaction_date`). `since = watermark - 3 days` if watermark exists, else `"2025-01-01"`. The `-3d` offset is a **tail-scope safety margin** — it re-classifies the last 3 days even though they're presumably already ingested, catching same-window edits. `since_gmail = since.replace("-", "/")` for the Gmail query.
2. **Fetch operator file** (sync_deliveries.py:86-99): Gmail query `label:"Work/ICTC Daily" subject:"RC DELIVERIES" after:{since_gmail} -label:"Blackwood-Processed"` (GMAIL_OP, sync_deliveries.py:67). If no xlsx found → early-return `ok:true` with `note` and empty `classified_path` (a legitimate no-op run).
3. **Fetch Czarina prices** (sync_deliveries.py:102-104): `from:czarinaloumaximoictc@gmail.com newer_than:5d` (GMAIL_CZ, sync_deliveries.py:68) — always a fixed 5-day window, NOT watermark-scoped. Optional — proceeds without it if absent.
4. **Extract + tail-filter** (sync_deliveries.py:107-113): runs `extract_rc_deliveries.py --file {op_xlsx}` (no `--sheet`/`--all-sheets` flag — defaults to the WORKBOOK's `active` sheet, i.e. whatever sheet was open when last saved, NOT necessarily the latest month). Then Python-side filters `rows = [r for r in extract["rows"] if str(r["transaction_date"])[:10] >= since]` — a SECOND, redundant-looking filter after the extractor already ran on one sheet; this is the "tail-scope" the module docstring refers to (the extractor is cumulative year-to-date on whichever sheet it picked, so filtering by `since` bounds it to the sync window regardless of what the extractor emitted).
5. **Enrich prices** (sync_deliveries.py:118-140): if `cz_xlsx` present and `rows` non-empty, picks the Czarina sheet name via `_month_sheet(max(transaction_date for rows))` (sync_deliveries.py:73-75: `date(year, month, 1).strftime("%B")` + space + year, e.g. `"June 2026"`). Runs `enrich_prices.py` as a subprocess and reads its `--output` file directly (does NOT parse `enrich_prices.py`'s stdout — that script prints HUMAN-readable lines, not JSON, by design). If the output file is missing/empty/`rc!=0`, logs a warning and proceeds with `enriched_path = extract_path` (i.e., un-enriched — every row's `cost_basis` stays `None` → L-008 placeholder at apply time).
6. **Classify vs DB window** (sync_deliveries.py:142-150): fetches `db.read_rows("deliveries", since_date=since, columns=DELIVERIES_COLS)` and writes to `db_rows.json`, then shells out to `classify_deliveries.py`.
7. **L-004 / L-033 guard layer** (sync_deliveries.py:152-246) — see §3 Classification spec below; this is orchestrator-level post-processing ON TOP of the raw classifier output, re-routing some `new` items into `dup_noops` or `flagged`.
8. **Emit classify envelope** (sync_deliveries.py:248-287).

### Apply phase (`phase_apply`, sync_deliveries.py:296-415)

1. For each `new` item: defensive batch upsert (INSERT INTO batches with `current_weight=0` `ON CONFLICT DO NOTHING`-equivalent via existence check first) — catches `is_location_collision` and routes to `held` (`reason: "location_occupied"`) rather than crashing.
2. Builds the delivery payload (see §5 Apply spec) and calls `db.insert_if_absent(...)` with natural key `(transaction_date, batch_code, truck_plate, weight_kg, sacks)`. Zero inserted → `held` (`reason: "already_exists"`).
3. On successful insert: `db.update_trigger_audit_provenance("deliveries", new_id, comment, snapshot=payload)` — L-001 (never a second INSERT; the trigger already wrote one).
4. For each `changed` item: builds a `patch` dict from `diff` entries (reads `emailValue` or `sheetValue` — this key name is Sheet-vs-email agnostic, a leftover from code sharing with gsheet), `db.update(...)`, then either stamps the trigger-audit row or falls back to `insert_manual_audit` if stamping returns `False` (no trigger row found).
5. FLAGGED and MALFORMED rows are NEVER auto-written under `--only-clean` — always routed to `held`.
6. Gmail label applied only if zero errors AND zero unapplied-non-held rows (`non_held_unapplied = bool(errors)` — sync_deliveries.py:389; note this specific implementation only checks `errors`, not a broader "any non-held unapplied count", so a run with only `held` rows and zero `errors` STILL labels the thread).

---

## 2. Extraction spec (`extract_rc_deliveries.py`)

### Sheet anatomy

- One sheet per MONTH (e.g. `"JANUARY 2026"`). `extract_rc_deliveries.py` defaults (no `--sheet`/`--all-sheets`) to `wb.active.title` — the workbook's last-saved active sheet (extract_rc_deliveries.py:554-555). `sync_deliveries.py` never passes `--sheet` or `--all-sheets`, so it always reads whatever sheet was active when the operator last saved — this is an IMPLICIT reliance on operator behavior (they always leave the current month active), not something the code enforces.
- Row 1 = title only. Row 2 = main headers. Row 3 = sub-headers. Rows 4-5 = spec thresholds. Row 6+ = data. Header row is located dynamically (`find_header_row`, extract_rc_deliveries.py:187-205): scans rows 1..15, looking for a row where the concatenated text of columns 1-6 contains (`"DATE OF"` OR `"DELIVERY"`) AND (`"SUPPLIER"` OR `"SAMPLE"`), case-insensitive.
- First data row: scans up to 8 rows past the header for the first row whose column 2 parses as a date (`first_data_row_below`, extract_rc_deliveries.py:208-220); fallback = `header_row + 4` if none found.
- Trailing rows: an "Average"/"Total"/"Sum" row (case-insensitive, column 1) is skipped (`is_average_or_summary_row`, extract_rc_deliveries.py:309-321); a row with no supplier AND no weight AND no date is also treated as noise and skipped.

### Column mapping (FIXED, not header-signature-driven)

`OPERATOR_COLUMNS` (extract_rc_deliveries.py:77-94), 1-based column index:

| Col | Field |
|---|---|
| 1 | date_analyzed (informational only) |
| 2 | transaction_date |
| 3 | supplier |
| 4 | operator_batch_label (raw "Block" value, e.g. `"B09"`, `"FEEDING AREA 1"`) |
| 5 | block_loc |
| 6 | truck_plate |
| 7 | weight_kg |
| 8 | sacks |
| 9 | lab_mc |
| 10 | lab_grit |
| 11 | lab_bd_astm |
| 12 | lab_bd_jis |
| 13 | lab_vm |
| 14 | lab_ash |
| 15 | lab_fc |
| 16 | remarks |

### Date carry-forward

Column 2's raw value is coerced via `coerce_date` (tries `datetime`/`date` objects directly, else string formats `%Y-%m-%d`, `%m/%d/%Y`, `%d/%m/%Y`, `%Y/%m/%d`, `%m-%d-%Y`). If `None`: forward-fill from `last_seen_date`; if THAT is also `None` (first row has no date), the row is SKIPPED with a warning (extract_rc_deliveries.py:344-349) — never emitted, not even as MALFORMED.

### Row validity

- `supplier is None and weight_kg is None` → silently skipped (continuation-row noise, extract_rc_deliveries.py:357-359).
- `weight_kg is None` (but supplier present) → warning + row SKIPPED entirely (extract_rc_deliveries.py:361-363) — note this is stricter than the classifier's later MALFORMED bucket; a missing-weight row never even reaches classification.
- `weight_kg` outside `(0, 100_000)` exclusive → warning only, row still emitted (extract_rc_deliveries.py:364-368).
- `block_loc` present but not matching `^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$` → warning only, still emitted.

### Batch code translation (`translate_batch_code`, extract_rc_deliveries.py:226-303)

Priority order, first match wins:

1. **Remarks match** `PILED\s+IN\s+(MONTH)\s*#\s*(\d+)` (case-insensitive) → `"{MMM}-{YY}-BLK{N}"`. `MMM` = the FULL month name (all 12 months map to their full name in `MONTH_ABBR`, extract_rc_deliveries.py:115-120 — despite the variable name "ABBR", every value is the full English month name). `YY` = 2-digit year from `delivery_date` if available, else hardcoded `"26"`.
2. **`FEEDING AREA` label** (`^FEEDING\s+AREA\s*(\d*)$`) with a captured number AND a known delivery date → `"{MMM}-{YY}-FEED{N}"` where `MMM` is derived from the delivery month via `list(MONTH_ABBR.values())[dt.month-1]` (same full-name list). If the label has no number or there's no delivery date, returns the RAW label with a warning ("needs manual mapping").
3. **`B<N>` label** (`^B0?(\d{1,3})$`) with a known delivery date → `"{MMM}-{YY}-BLK{N}"`, month derived from `delivery_date`, WITH a warning noting the heuristic translation (this warning fires even on a SUCCESSFUL translation, unlike other rules).
4. **Fallthrough**: raw `operator_label` returned verbatim, with a warning "Could not map ... emitting raw value."

**Verbatim priority note**: rule 1 (remarks PILED IN) is checked BEFORE rule 3 (`B<N>` label) even though `translate_batch_code`'s code physically checks rule 3 (FEEDING AREA) first in source order (line 249), then rule 1 (PILED IN, line 267), then rule 2 (`B<N>`, line 284) — the ACTUAL source order is: FEEDING AREA → PILED IN remarks → B-number → fallthrough. (The docstring's stated "priority order" at lines 236-241 lists PILED-IN first, but the code checks FEEDING AREA first structurally; since `FEEDING AREA` labels and `B<N>` labels are mutually exclusive string shapes this ordering difference is usually inert, but a TS port must replicate the CODE's actual check order, not the docstring's.)

### Weight deduction detection (L-021, delegated to `lib/deductions.py` — see SHARED.md)

Called at extract_rc_deliveries.py:407 via `detect_deduction(remarks, weight_kg)`. Sets `true_weight_kg` (NULL unless a deduction is confidently parsed) and `deduction_note` (short display string) on EVERY row (both keys always present, values nullable). **Never diffed by the classifier** (additive/write-only).

### Wet-recovery sub-rows (L-021, shared core in `lib/deductions.py`)

A row is a recovery candidate (`is_recovery_candidate` wrapper, extract_rc_deliveries.py:453-458, delegating to `lib.deductions.is_recovery_row_dict`) iff: it has a non-null `weight_kg`, AND `truck_plate is None`, AND `batch_code is None`, AND `block_loc is None`, AND it did NOT have its own raw date cell (`has_own_date = coerce_date(sheet.cell(row_num, 2).value) is not None` — computed from the RAW cell, not the forward-filled `row_dict["transaction_date"]`).

If a candidate is found (`extract_sheet`, extract_rc_deliveries.py:461-506):
- If `last_mother` is set and is itself "inheritable" (`_is_inheritable_mother` = has a non-null `batch_code`), build a recovery row via `build_recovery_row(row_dict, last_mother)` — inherits `transaction_date`, `supplier`, `block_loc`, `truck_plate`, `batch_code`, `cost_basis` from the mother; KEEPS its own `weight_kg`, `sacks`, `lab_results`, `remarks`; re-derives its OWN `true_weight_kg`/`deduction_note` from ITS OWN remark (not the mother's).
- If no inheritable mother exists, the row is kept AS-IS (no batch_code) with an added warning — it will surface as MALFORMED at classify time (missing `batch_code`).
- **A recovery row never itself becomes the new `last_mother`** — inheritance always traces back to the original, real delivery row, even across multiple consecutive recovery sub-rows.

### Derived fields / units / rounding

- `confidence = max(0.0, 1.0 - 0.10 * len(warnings))`, rounded to 3 decimals — computed identically in `extract_row` (per-row) and again inside `build_recovery_row` (per-recovery-row, its own independent warning list).
- `overall_confidence` (file-level summary) = mean of all row confidences, rounded to 3dp, or `0.0` if there are zero rows.
- `unmapped_batches` (file-level summary) = sorted set of `operator_batch_label` values where `batch_code == operator_batch_label` (i.e., translation fell through to the raw label) — extract_rc_deliveries.py:577-582.

### MALFORMED conditions (deferred to classifier, NOT the extractor)

The extractor itself only SKIPS unrecoverable rows (no date, no weight) — it never emits a `"MALFORMED"` bucket. `classify_deliveries.py` is where MALFORMED is decided: `transaction_date`, `batch_code`, or `weight_kg` falsy → MALFORMED (classify_deliveries.py:206-210). Note this means a recovery row with NO batch_code (orphan recovery, no mother) reaches classification and is caught here.

---

## 3. Classification spec

### Natural key (`classify_deliveries.py::make_natural_key`, lines 77-83)

`(transaction_date, batch_code, norm_block_loc(block_loc), norm_num(weight_kg, places=3))`

### NOOP demotion / equality rules (`field_differences`, lines 99-156)

| Field | Comparison | Notes |
|---|---|---|
| `supplier` | `norm_str` equal | case-insens, trim, `''`≡`null` |
| `truck_plate` | `norm_str` equal | same |
| `sacks` | `norm_int` equal | truncates fractional (Porting Trap #3 in SHARED.md) |
| `cost_basis` | **SKIPPED entirely if `extracted.cost_basis is None`** (operator file has no price column) | only compared when the extract side has a real value (i.e., after enrichment) |
| `remarks` | `norm_str` equal | |
| `lab_results` | `deep_lab_equal` (2dp per key) | |

`true_weight_kg`/`deduction_note` are **explicitly excluded** from `field_differences` (comment at lines 102-108) — never diffed, additive/write-only per L-021.

### VALUE_CHANGED vs NOOP

Any non-empty `diffs` list → VALUE_CHANGED (no materiality gate here — unlike gsheet, EVERY diff in `classify_deliveries.py` is treated as material; there is no rounding/null↔0 demotion beyond what `norm_*` already collapses into equality).

### FLAGGED kinds (orchestrator-level, sync_deliveries.py — NOT in classify_deliveries.py itself)

Applied as a post-pass over the classifier's `new` bucket (sync_deliveries.py:201-246):

1. **L-033a — cross-batch duplicate → demoted to NOOP** (not flagged, a THIRD bucket `dup_noops`): a `new` row whose `(date, normalized truck_plate, weight_kg)` matches an existing DB row via `db_by_dtw` index AND that DB row's `block_loc` (normalized) matches the candidate's `block_loc`, but the DB row's `batch_code` DIFFERS from the candidate's. → demoted with note `"L-033: same truckload already recorded as {db_bc} — extractor-derived name {candidate_bc} is a month-boundary phantom."` Trigger requires `_norm_truck(r.truck_plate)` to be non-empty (an empty/blank truck plate never matches via this index — `dups = db_by_dtw.get(kd, []) if _norm_truck(...) else []`).
2. **`L033_cross_batch_loc_mismatch`** (FLAGGED, `decision: "skip"`): same `(date, truck, weight)` match exists in the DB but at a DIFFERENT `block_loc` (not just different batch_code) — i.e. `same_loc` is empty but `dups` (the broader date/truck/weight match) is non-empty. Requires a human call.
3. **L-033b — remark hint re-map** (sync_deliveries.py:179-199, 227-231): if the row's `remarks` matches `PILED\s+IN\s+([A-Z]+)\.?\s+BLOCK\s*(\d+)` (case-insensitive), resolve the month word to a month number via prefix-matching against `_MONTHS` (`{"JAN":1,...,"DEC":12}` — matches if the word STARTS WITH the 3-letter prefix, e.g. `"JUNE"` matches `"JUN"` prefix), compute `year = txn_year - 1 if month_num > txn_month else txn_year` (a December pile receiving a January truck crosses the year boundary), then tries EACH of `_CODE_VARIANTS[month_num]` (e.g. month 3 → `["MARCH", "MAR"]`) as `f"{variant}-{yy}-BLK{blk}"` and checks if that batch_code EXISTS in `batches` via `db.select_one`. First existing match wins; **never invents a batch** — if none of the variants exist in the DB, the hint is silently ignored (returns `None`) and the original extractor-derived batch_code is kept. If a hint resolves to a DIFFERENT code than the extractor's, the row's `batch_code` is REWRITTEN in place and a note is appended — this happens BEFORE the L-004 collision check below, so a successful L-033b remap can also change whether L-004 fires.
4. **`L004_block_loc_correction`** (FLAGGED, `decision: "skip"`): after any L-033b remap, re-derive the `(date, batch_code, weight)` key and check `db_by_dbw` for a row with the SAME key but a DIFFERENT `block_loc` — that's a block_loc correction, not a new delivery.
5. **`low_confidence`** (FLAGGED, `decision: "skip"`): `(row.confidence or 1.0) < CONF_FLOOR` where `CONF_FLOOR = 0.7` (sync_deliveries.py:70). Checked LAST, only if neither L-033a/L033_cross_batch_loc_mismatch nor L-004 fired.

Order of checks per `new` item (sync_deliveries.py:202-246): L-033a/L033_cross_batch_loc_mismatch first (can `continue` past the rest) → L-033b remap (mutates `batch_code`) → L-004 collision check → low-confidence check → else: genuinely a clean INSERT.

### UNMAPPED handling

`classify_deliveries.py` has NO separate UNMAPPED bucket — an unresolved batch code simply flows through as whatever `translate_batch_code` produced (possibly the raw operator label), and if it happens to collide with nothing in the DB it becomes a genuine NEW row with a non-standard `batch_code` (still subject to the defensive batch-upsert at apply time, which will create a batch row with that literal string as its code — this is a real risk: a garbage-shaped batch_code CAN get auto-created as a new batch unless caught by low-confidence or another gate first).

---

## 4. Gates & reconciliation

- **No HARD gate** in the deliveries pipeline (unlike rc_out's two HARD gates). `gate_failures` is always `[]` in the classify envelope.
- The L-004/L-033 checks above are the closest thing to gates, but they route to `flagged`/`dup_noops`, never halt the whole run (`ok` stays `true`).
- `CONF_FLOOR = 0.7` is a per-row soft gate, not a HALT.

---

## 5. Apply spec

### Write order

1. Defensive batch upsert (only if the resolved `batch_code` doesn't already exist as a `batches` row) — `INSERT INTO batches (batch_code, location_ref, status='STORED', current_weight=0, avg_cost=0)`. Catches `is_location_collision` → `held`.
2. `deliveries` INSERT via `insert_if_absent`, natural key `(transaction_date, batch_code, truck_plate, weight_kg, sacks)`.
3. Trigger-audit UPDATE (`update_trigger_audit_provenance`) — L-001, always an UPDATE never a second INSERT, since `deliveries` has an AFTER-INSERT audit trigger.
4. For `changed` rows: `db.update("deliveries", {"id": eq}, patch)` then trigger-audit stamp; if stamping returns `False` (no row found — defensive, shouldn't happen for an already-existing row), falls back to `insert_manual_audit`.

### Payload field list (INSERT)

```
transaction_date, supplier, batch_code, block_loc, truck_plate, sacks, weight_kg,
cost_basis (real value OR 0 placeholder — L-008), remarks, lab_results,
true_weight_kg, deduction_note   (L-021, additive)
```

### Audit mechanism

Trigger-UPDATE via `stamp_ingestion_audit` RPC (table has an audit trigger) — see SHARED.md §2.4.

### Idempotency mechanism

`insert_if_absent` re-checks the natural key immediately before each insert (SHARED.md §2.3). ALSO: gsheet-sourced rows tagged `provenance=gsheet` with `cost_basis=0` are meant to be picked up LATER by this same deliveries pipeline for price enrichment (L-008 cross-reference) — but this orchestrator does not special-case `provenance=gsheet` rows differently; any row with `cost_basis IS NULL` (extract-side) simply gets `cost_basis=0` on insert if truly unenriched.

### Held-row reasons

`location_occupied`, `already_exists` (idempotent skip), plus whatever `f.get("kind")` was set to for flagged rows (`L033_cross_batch_loc_mismatch`, `L004_block_loc_correction`, `low_confidence`), and `malformed`.

### Label + watermark conditions

- `upsert_ingestion_watermark(db, "deliveries", last_email_id=compact["source"]["email_thread_id"])` — only called if `not errors`.
- Gmail label only if `not errors` (checked via `non_held_unapplied = bool(errors)`) AND `not args.no_label` AND a `uid` is present in `compact["source"]`.

---

## 6. Rule checklist

| Rule | Where in code | Parity test must assert |
|---|---|---|
| L-001 | sync_deliveries.py:351 (`update_trigger_audit_provenance`, never a 2nd INSERT) | After a delivery INSERT, exactly ONE `audit_logs` row exists for that record_id, and it was UPDATEd not INSERTed twice. |
| L-004 | sync_deliveries.py:233-241 | A NEW row matching `(date,batch_code,weight)` but a different `block_loc` → FLAGGED `L004_block_loc_correction`, `decision:"skip"`, never inserted. |
| L-006 | (absence of code) | Apply NEVER issues `UPDATE batches SET current_weight = current_weight + ...` — grep the TS port for any such statement; it must not exist. |
| L-008 | sync_deliveries.py:338 (`cost_basis if not None else 0`) | An un-enriched NEW row inserts with `cost_basis=0`, and the audit comment contains the literal note about the placeholder. |
| L-020 | `insert_if_absent` (lib/db.py) | Re-running the exact same classify→apply cycle twice produces ZERO duplicate inserts on the second run. |
| L-021 | extract_rc_deliveries.py:407, lib/deductions.py | `true_weight_kg`/`deduction_note` populate on a deduction-bearing row; a DB row missing both fields does NOT trigger a false VALUE_CHANGED. |
| L-033a | sync_deliveries.py:205-217 | Same `(date, truck, weight)` at the same location under a DIFFERENT batch name → demoted to `dup_noops`, never inserted, never flagged. |
| L-033b | sync_deliveries.py:179-199, 227-231 | `"PILED IN JUNE BLOCK 9"` on a July-dated row re-maps `batch_code` to the EXISTING `JUNE-26-BLK9` if it exists in `batches`; if it does NOT exist, the remark is ignored and original code kept. |
| never-auto-create-batch (beyond resolved code) | sync_deliveries.py:316-333 | A batch upsert only ever writes the ALREADY-RESOLVED `batch_code` string — never derives a new one at apply time. |
| wet-recovery inheritance | extract_rc_deliveries.py:484-499 | A recovery sub-row with a preceding mother inherits truck/batch/block/supplier/date; an orphan recovery (no mother) is left unmapped and reaches classify as MALFORMED. |

---

## 7. Fixture shopping list

- Real (redacted) `RC DELIVERIES 2026.xlsx` sample sheet with: a normal row, a `B<N>` operator label row, a `FEEDING AREA N` row, a `PILED IN <MONTH> # <N>` remarks row, a deduction remark (`net kilos of ... = ...`), a wet-recovery sub-row directly under a mother, an orphan recovery sub-row (no mother above it), an "Average" trailing row, a row missing weight, a row with an off-format `block_loc`.
- Synthetic Czarina price file with: an exact truck-plate match, a plate-typo scenario (see L-010 in LEARNING_LEDGER — NOTE this specific recovery-by-supplier+sacks+weight fallback is documented in the ledger but is NOT implemented in `enrich_prices.py`'s code — `match_price` only ever keys on `(supplier, truck, weight)`; the ledger's L-010 recovery was a MANUAL agent action, not automated Python. Flag this gap for the TS port — do not assume the fallback exists in code).
- A month-boundary truckload fixture reproducing the exact L-033 scenario: July-dated delivery, remark `"PILED IN JUNE BLOCK 9"`, DB already holding `JUNE-26-BLK9` with a matching `(date,truck,weight)` row at the same `block_loc`.
- A `location_occupied` fixture: a NEW row whose `batch_code` doesn't exist yet AND whose `block_loc` already holds a different active batch.
- Confidence-boundary fixture: a row with exactly `confidence == 0.7` (must NOT be flagged, since the check is `< 0.7` not `<=`) and one at `0.699...` (must be flagged).

---

## 8. Porting traps (deliveries-specific)

- `sync_deliveries.py` never passes `--sheet`/`--all-sheets` to the extractor — it silently trusts `wb.active.title`. A TS port must replicate "whatever sheet openpyxl reports as active", which depends on which sheet tab was selected when the xlsx was LAST SAVED in Excel/Sheets — this is workbook metadata, not derivable from sheet names or dates. Verify the chosen xlsx library exposes `activeTab`/equivalent.
- `translate_batch_code`'s actual check order (FEEDING AREA → PILED IN → B-number → fallthrough) diverges from its own docstring's stated priority (PILED IN listed first). Port the code path, not the docstring.
- The L-010 (deliveries/enrich) plate-typo price recovery documented in LEARNING_LEDGER is a **manual, one-off agent action** — it is NOT implemented in `enrich_prices.py`. Do not port a fallback-by-supplier+sacks+weight matcher unless explicitly asked to add the capability; the current code only does exact `(supplier, truck, weight)` matching with a closest-date tiebreak among multiple hits.
- `enrich_prices.py` outputs its enriched JSON to `--output` but prints HUMAN-readable summary lines to stdout, not JSON — `sync_deliveries.py` deliberately does NOT parse enrich's stdout (subprocess.run + check the output FILE, not stdout). A TS port's equivalent enrich step should keep this same file-based handoff if replicating the orchestration shape, or explicitly redesign it — flag which approach is intended.
