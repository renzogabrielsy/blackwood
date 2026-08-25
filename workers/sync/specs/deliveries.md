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
2. Builds the delivery payload (see §5 Apply spec) and calls `db.insert_if_absent(...)` with the
   **shared two-tier guard columns** — `lib/deliveryIdentity.ts::deliveriesInsertGuardColumns(row)`
   (L-040b): `(transaction_date, truck_plate, sacks)` for a plated row with a sack count, else the
   legacy `(transaction_date, batch_code, block_loc, weight_kg)`. `reports/gsheet/apply.ts` calls the
   SAME function, so the race guard cannot disagree with the classifier. Zero inserted → `held`
   (`reason: "already_exists"`). NOTE the guard compares the plate with PostgREST `eq.`, i.e. its RAW
   spelling — slightly weaker than the classifier's normalized match, which is fine: this is only the
   within-run TOCTOU backstop (BUG-016), and the column set is strictly narrower than the old
   five-column key, so it can only suppress more duplicates.
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
2. **A `FEEDING` label** (`^FEEDING(?:\s*(?:AREA|NO))?\s*[#.:-]?\s*(\d*)\s*\.?$`, **WIDENED 2026-08-13, L-042** — it used to be `^FEEDING\s+AREA\s*(\d*)$`) with a captured number AND a known delivery date → `"{MMM}-{YY}-FEED{N}"` where `MMM` is derived from the delivery month via `list(MONTH_ABBR.values())[dt.month-1]` (same full-name list). If the label has no number or there's no delivery date, returns the RAW label with a warning ("needs manual mapping").
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

The extractor itself only SKIPS unrecoverable rows (no date, no weight) — it never emits a `"MALFORMED"` bucket. `classify_deliveries.py` is where MALFORMED is decided: `transaction_date`, `batch_code`, or `weight_kg` falsy → MALFORMED. Note this means a recovery row with NO batch_code (orphan recovery, no mother) reaches classification and is caught here.

**Since 2026-08-13 (L-042) that bucket is SPLIT** — one narrowly-defined shape leaves it for the
gentler `awaiting_assignment` bucket, and the ORPHAN RECOVERY ROW DELIBERATELY DOES NOT. See §11.

---

## 3. Classification spec

### Identity — TWO-TIER (L-040b, 2026-08-08)

**One definition, shared by both writers of `deliveries`:** `workers/sync/src/lib/deliveryIdentity.ts`,
mirrored in `classify_deliveries.py` (`tier1_key` / `legacy_key` / `build_identity_index` /
`match_delivery`) and imported — never re-derived — by `classify_gsheet.py`. If the email path and
the Sheet path disagree about what "the same row" is, they duplicate each other's rows.

| Tier | Key | Applies to |
|---|---|---|
| **1** (preferred) | `("T1", transaction_date[:10], norm_plate(truck_plate), norm_int(sacks))` | any row with a non-blank normalized plate **and** a sack count |
| **2** (fallback = the LEGACY key, unchanged) | `("T2", transaction_date[:10], batch_code, norm_block_loc(block_loc), norm_num(weight_kg, 3))` | everything else |

`norm_plate` keeps alphanumerics only and upper-cases (`MAV 9202` ≡ `MAV9202` — both spellings are
live, 57 and 35 rows). The tier tag is the FIRST key segment, so a tier-1 key can never equal a
tier-2 key.

**Lookup order is tier 1, then tier 2.** Every DB row is indexed under its legacy key AND, when
eligible, under its tier-1 key. Because tier 2 IS the old key and is still tried, the set of rows
that MATCH is a strict **superset** of what the old single key matched: the change can only turn an
insert into a match, never the reverse. `peer_count` reports how many DB rows shared the matched key
— `> 1` on a tier-1 match means the database already holds more than one row for one truckload (a
duplicate predating the run), and the refusal text says so.

**Why the old key manufactured duplicates.** It was tier 2 alone: no truck plate, and three
human-correctable facts (`batch_code` is a *label* two sources spell differently; `block_loc` is a
yard decision that gets corrected; `weight_kg` is revised after ASH/wet deductions). Correct any one
and the row stopped being recognised → NEW → a second copy. Sacks are counted at the gate and are
not revised, which is why they are in the identity and weight is not. See LEARNING_LEDGER L-040b.

**Measured (live table, 2026-08-08):** 1,688 deliveries · 1,545 tier-1 eligible with **zero** tier-1
collisions · 143 with no plate, **zero** collisions on the legacy key among them · and exactly ONE
legacy-key collision in the whole table — the `2025-04-03 / KCA 378 / MARCH-25-BLK9 / D-8D` wet-sack
split (471 and 36 sacks, both 18,827 kg), which the old key conflated into one row and tier 1
separates correctly.

### NOOP demotion / equality rules (`field_differences`, lines 99-156)

| Field | Comparison | Notes |
|---|---|---|
| `batch_code` | **`batch_code_alias_equal`** (L-042) | **L-040b — left the key, so it is COMPARED.** Equal by construction on a tier-2 match. **A MONTH-PREFIX ALIAS IS NOT A DIFFERENCE** (`AUGUST-26-FEED1` ≡ `AUG-26-FEED1`); a different MONTH still is (`JULY-26-BLK9` ≠ `JUNE-26-BLK9`) — see §11 |
| `block_loc` | `norm_block_loc` equal | same |
| `weight_kg` | `norm_num(…,3)` equal | same |
| `supplier` | `norm_str` equal | case-insens, trim, `''`≡`null` |
| `truck_plate` | `norm_str` equal | same |
| `sacks` | `norm_int` equal | truncates fractional (Porting Trap #3 in SHARED.md) |
| `cost_basis` | **SKIPPED entirely if `extracted.cost_basis is None`** (operator file has no price column) | only compared when the extract side has a real value (i.e., after enrichment) |
| `remarks` | `norm_str` equal | |
| `lab_results` | `deep_lab_equal` (2dp per key) | |

`true_weight_kg`/`deduction_note` are **explicitly excluded** from `field_differences` (comment at lines 102-108) — never diffed, additive/write-only per L-021.

### IDENTITY_DIFF — a formerly-key field disagrees (L-040b)

A match whose `diffs` touch **any of `batch_code` / `block_loc` / `weight_kg`** does NOT become
`changed` (which auto-applies). It goes to the classifier's `identity_diff` bucket, and
`apply_deliveries_guard` folds every entry into `flagged` (`kind: "L040_identity_diff"`,
`decision: "skip"`, `db_id` set) so `apply.ts` HOLDS it — `HeldKind` `cross_batch_reassignment`, no
new kind invented. The refusal names BOTH sides of every disagreeing field and carries no ₱ value.

Those three are exactly the fields a human corrects, so a mismatch means one source is stale; per
CLAUDE.md → Sync Integrity, a human arbitrates it in Sync Review. **A field removed from an identity
must be added to the diff in the same change** — otherwise a corrected batch code matches and then
reads as a silent NOOP, which is worse than a duplicate because nobody can see it.

Consequence for **L-033a**: it is now a narrower BACKSTOP. A plated row whose sacks match an existing
row is resolved as an identity diff by the classifier and never reaches the guard's `new` loop, which
is strictly better — L-033a's `dup_noop` outcome was a SILENT skip.

### VALUE_CHANGED vs NOOP

Any non-empty `diffs` list that contains **no** identity field → VALUE_CHANGED (no materiality gate here — unlike gsheet, EVERY diff in `classify_deliveries.py` is treated as material; there is no rounding/null↔0 demotion beyond what `norm_*` already collapses into equality).

### FLAGGED kinds (orchestrator-level, sync_deliveries.py — NOT in classify_deliveries.py itself)

Applied as a post-pass over the classifier's `new` bucket (sync_deliveries.py:201-246):

1. **L-033a — cross-batch duplicate → demoted to NOOP** (not flagged, a THIRD bucket `dup_noops`): a `new` row whose `(date, normalized truck_plate, weight_kg)` matches an existing DB row via `db_by_dtw` index AND that DB row's `block_loc` (normalized) matches the candidate's `block_loc`, but the DB row's `batch_code` DIFFERS from the candidate's. → demoted with note `"L-033: same truckload already recorded as {db_bc} — extractor-derived name {candidate_bc} is a month-boundary phantom."` Trigger requires `_norm_truck(r.truck_plate)` to be non-empty (an empty/blank truck plate never matches via this index — `dups = db_by_dtw.get(kd, []) if _norm_truck(...) else []`).
2. **`L033_cross_batch_loc_mismatch`** (FLAGGED, `decision: "skip"`): same `(date, truck, weight)` match exists in the DB but at a DIFFERENT `block_loc` (not just different batch_code) — i.e. `same_loc` is empty but `dups` (the broader date/truck/weight match) is non-empty. Requires a human call.
3. **L-033b — remark hint re-map** (sync_deliveries.py:179-199, 227-231): if the row's `remarks` matches `PILED\s+IN\s+([A-Z]+)\.?\s+BLOCK\s*(\d+)` (case-insensitive), resolve the month word to a month number via prefix-matching against `_MONTHS` (`{"JAN":1,...,"DEC":12}` — matches if the word STARTS WITH the 3-letter prefix, e.g. `"JUNE"` matches `"JUN"` prefix), compute `year = txn_year - 1 if month_num > txn_month else txn_year` (a December pile receiving a January truck crosses the year boundary), then tries EACH of `_CODE_VARIANTS[month_num]` (e.g. month 3 → `["MARCH", "MAR"]`) as `f"{variant}-{yy}-BLK{blk}"` and checks if that batch_code EXISTS in `batches` via `db.select_one`. First existing match wins; **never invents a batch** — if none of the variants exist in the DB, the hint is silently ignored (returns `None`) and the original extractor-derived batch_code is kept. If a hint resolves to a DIFFERENT code than the extractor's, the row's `batch_code` is REWRITTEN in place and a note is appended — this happens BEFORE the L-004 collision check below, so a successful L-033b remap can also change whether L-004 fires.
3b. **L-042 — month-prefix alias re-spell** (2026-08-13): after the L-033b hint and BEFORE the L-004 check, if the row's `batch_code` does NOT exist in `batches` but its month-prefix ALIAS does, the code is rewritten to the DB's own spelling and a note is appended. Same safety property as L-033b — **it can only ever point at a batch that ALREADY EXISTS, and never overrides a code that already resolves.** See §11.
4. **`L004_block_loc_correction`** (FLAGGED, `decision: "skip"`): after any L-033b remap, re-derive the `(date, batch_code, weight)` key and check `db_by_dbw` for a row with the SAME key but a DIFFERENT `block_loc` — that's a block_loc correction, not a new delivery.
5. **`low_confidence`** (FLAGGED, `decision: "skip"`): `(row.confidence or 1.0) < CONF_FLOOR` where `CONF_FLOOR = 0.7` (sync_deliveries.py:70). Checked LAST, only if neither L-033a/L033_cross_batch_loc_mismatch nor L-004 fired.

Order of checks per `new` item (sync_deliveries.py:202-246): L-033a/L033_cross_batch_loc_mismatch first (can `continue` past the rest) → L-033b remap (mutates `batch_code`) → L-004 collision check → low-confidence check → else: genuinely a clean INSERT.

### UNMAPPED handling

`classify_deliveries.py` has NO separate UNMAPPED bucket — an unresolved batch code simply flows through as whatever `translate_batch_code` produced (possibly the raw operator label), and if it happens to collide with nothing in the DB it becomes a genuine NEW row with a non-standard `batch_code` (still subject to the defensive batch-upsert at apply time, which will create a batch row with that literal string as its code — this is a real risk: a garbage-shaped batch_code CAN get auto-created as a new batch unless caught by low-confidence or another gate first).

**This risk is REAL and MEASURED, not hypothetical.** `batches` contains `FEEDING # 1` (created
2026-07-09), `FEEDING # 2` (2026-07-21, holding **18,650 kg** of phantom weight) and
`FEEDING AREA # 1`…`# 4` — every one of them a raw operator label that became a batch this way.
L-042 narrows it on both ends: the FEEDING family now translates instead of falling through, and the
guard's alias re-spell keeps a translated code from landing beside an existing batch. It does NOT
close the general case — a genuinely unrecognised label still creates a batch named after itself.

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

`insert_if_absent` re-checks the **two-tier guard key** (L-040b, see §5 write order) immediately before each insert (SHARED.md §2.3). ALSO: gsheet-sourced rows tagged `provenance=gsheet` with `cost_basis=0` are meant to be picked up LATER by this same deliveries pipeline for price enrichment (L-008 cross-reference) — but this orchestrator does not special-case `provenance=gsheet` rows differently; any row with `cost_basis IS NULL` (extract-side) simply gets `cost_basis=0` on insert if truly unenriched.

### Held-row reasons

`location_occupied`, `already_exists` (idempotent skip), plus whatever `f.get("kind")` was set to for flagged rows (`L033_cross_batch_loc_mismatch`, `L004_block_loc_correction`, **`L040_identity_diff`**, `low_confidence`), and `malformed`. `L040_identity_diff` maps to `HeldKind` `cross_batch_reassignment`.

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
- Czarina price-file fixtures: **no longer synthetic.** `workers/sync/test/reports/deliveries-price-enrichment.test.ts` runs against the REAL workbook (`~/blackwood/.sync-flags/2026-08-07/124885_RAW CHARCOAL PURCHASES -Daily.xlsx`, 24 tabs / 1,347 rows) with the ten real deliveries Renzo confirmed on 2026-08-07. A synthetic price file cannot prove the tab resolver copes with 24 tabs a human named by hand over two years — which is precisely the fault that un-priced a whole month (L-039). The suite SKIPS the workbook-dependent blocks if the file is absent, so a fresh clone still passes.
- A month-boundary truckload fixture reproducing the exact L-033 scenario: July-dated delivery, remark `"PILED IN JUNE BLOCK 9"`, DB already holding `JUNE-26-BLK9` with a matching `(date,truck,weight)` row at the same `block_loc`.
- A `location_occupied` fixture: a NEW row whose `batch_code` doesn't exist yet AND whose `block_loc` already holds a different active batch.
- Confidence-boundary fixture: a row with exactly `confidence == 0.7` (must NOT be flagged, since the check is `< 0.7` not `<=`) and one at `0.699...` (must be flagged).

---

## 8. Porting traps (deliveries-specific)

- `sync_deliveries.py` never passes `--sheet`/`--all-sheets` to the extractor — it silently trusts `wb.active.title`. A TS port must replicate "whatever sheet openpyxl reports as active", which depends on which sheet tab was selected when the xlsx was LAST SAVED in Excel/Sheets — this is workbook metadata, not derivable from sheet names or dates. Verify the chosen xlsx library exposes `activeTab`/equivalent.
- `translate_batch_code`'s actual check order (FEEDING AREA → PILED IN → B-number → fallthrough) diverges from its own docstring's stated priority (PILED IN listed first). Port the code path, not the docstring.
- ~~The L-010 (deliveries/enrich) plate-typo price recovery documented in LEARNING_LEDGER is a **manual, one-off agent action** — it is NOT implemented in `enrich_prices.py`. Do not port a fallback-by-supplier+sacks+weight matcher unless explicitly asked to add the capability~~ — **SUPERSEDED 2026-08-07 (L-039): the capability WAS explicitly asked for and is now implemented in the TS port.** The Python remains exact-key-only; the TS enricher is deliberately AHEAD of it. See §9 below. The Python is still the oracle for extract/classify — but **not** for enrich, which `build_oracle.py` never runs.
- **`max_date_drift_days=7` was dropped in the first TS port, and that was a real (unnoticed) regression.** `enrich_prices.py::match_price(..., max_date_drift_days=7)` bounds how far a Czarina row may sit from the delivery date; the TS port kept the closest-date tiebreak but discarded the bound. Because the exact key carries **no date**, unbounded it prices a December delivery from an August row. Restored 2026-08-07 at the spec's own 7 days. **When porting, diff the parameter list — a dropped safety bound is invisible until it is expensive.**
- `enrich_prices.py` outputs its enriched JSON to `--output` but prints HUMAN-readable summary lines to stdout, not JSON — `sync_deliveries.py` deliberately does NOT parse enrich's stdout (subprocess.run + check the output FILE, not stdout). A TS port's equivalent enrich step should keep this same file-based handoff if replicating the orchestration shape, or explicitly redesign it — flag which approach is intended.

---

## 9. Price enrichment — the TS behaviour (2026-08-07, L-039)

> **The TS enricher is deliberately AHEAD of the Python.** `enrich` is NOT part of the classify
> oracle — `build_oracle.py` never runs it, and `cost_basis` is skipped in `field_differences`
> whenever the extracted side is null, so **no parity fixture exercises any of this.** That is
> what makes hardening it safe. Everything below is TS-only unless it says otherwise.
>
> Code: `src/reports/deliveries/enrich.ts` (matcher), `czarinaSheet.ts` (tab resolution),
> `supplierCanon.ts` (the `canonical_supplier` mirror). Tests:
> `test/reports/deliveries-price-enrichment.test.ts`. DB: migration `20260807040107`.

### 9.1 Why it was rewritten

The sync had priced **zero August 2026 deliveries** for a week; `AUGUST-26-BLK1`'s `avg_cost` read
**₱11.01 against a real ₱39.99**. Full post-mortem in LEARNING_LEDGER **L-039**. Four faults: a
generated tab name matched exactly against hand-typed tabs; a bare `catch` that reported the wrong
cause; a whole-file load done once outside the row loop; and supplier variants that never keyed equal.

### 9.2 Tab resolution — semantic, never exact

`czarinaSheet.ts::resolveCzarinaTab(sheetNames, year, month)`. Both sides normalize to
`(month, year)`: trim → uppercase → drop every non-alphanumeric → split the leading letter run from
the trailing digit run; 2-digit years read as `20YY`. Month tokens come from
`lib/months.ts::monthNumberFromToken` — the SEPT/SEP asymmetry lives **there**, and this module must
never grow a private month table.

Proven against all 24 real tabs: `Aug. 2026`, `Feb. 2026`, `Jan. 2026.` (trailing period),
`Nov 25. ` (trailing **space**), `March25` (no separator), `July.2024`, `Sept. 25`.

**Ambiguity is REFUSED, never guessed** (`reason: "ambiguous"` + both candidate names). Two tabs
meaning the same month is a working copy; picking one would price a month from a scratch sheet.

### 9.3 Every month the window spans

`monthsSpanned(dates)` returns **every** distinct `(year, month)`, not just the newest. The window
is `watermark − 3 days`, so it straddles a month boundary on the **1st, 2nd and 3rd of every
month** — the old one-month load left the earlier month unpriced with no complaint.

### 9.4 The match ladder — each rung stricter about evidence

| # | Rung | Key | Accepted when |
|---|---|---|---|
| 1 | **EXACT** | `(canonical_supplier, plate[alnum-upper], weight[whole kg])` | key hits **and** date drift ≤ `MAX_DATE_DRIFT_DAYS` (7) |
| 2 | **ALIAS** | same key, our plate swapped for the spelling Czarina is KNOWN to use (`public.delivery_source_aliases`) | same |
| 3 | **FALLBACK** | `(date ± ≤2d, net weight, sacks)` | unique on **BOTH** sides **and** one independent field corroborates |

**Rung 1/2 — the date bound.** The key carries **no date** (the files don't share one: she records
"Date of Del.paid"). `max_date_drift_days=7` is the **Python spec's own value**. Measured on the real
workbook: 34 exact keys have >1 row, **all 34 are >7 days apart, none within 7**, prices differing by
up to ₱6.75/kg — and all ten confirmed deliveries matched at drift **0**. Over the bound → refused
with `price_date_drift`. Unlike the Python (which warned on stdout and applied anyway), the worker
**refuses**: nothing watches stdout, and applying would contradict the `price_tab_unresolved` note
the same run just raised.

**Rung 3 — the uniqueness gate.** Renzo's measurement: across 1,327 deliveries since Jan 2025 the
triple is unique for **1,309**, and **all 9 colliding triples ARE known duplicate pairs**. So
uniqueness is simultaneously the safety property and a duplicate detector. A collision on either
side → refused (`price_fuzzy_ambiguous`) with the twin named. Corroboration (iii) is a TS addition:
a lone unique hit whose plate **and** supplier both disagree is a coincidence, not the same truckload.

**Plate shape is a TIE-BREAKER, NEVER A MATCHER.** `platesCorroborate` returns only `exact`,
`affix` (prefix/suffix, shorter side ≥ 4 chars — `T138003`/`138003`) or `substitution` (same length,
exactly one char — `ALA3958`/`ALA9958`). No edit distance, no transposition, no insertion: every
extra rule is another way to accept a truck that does not exist. It never builds a lookup key.

**Suppliers go through `canonical_supplier()` on BOTH sides** — that alone fixes the
`Paquibot/Compra` vs `PAQUIBOT` class, with no new machinery. Mirrored in TS for speed/purity;
`scripts/verify-supplier-canon.ts` asserts the copies agree **against the live DB function** (a
mirror without a drift check is worse than no mirror). Note the ILIKE trap it must reproduce:
`%mercado%ornales%` is ORDERED and NON-OVERLAPPING, so `MERCADORNALES` matches **neither** order.

### 9.5 Nothing fails quietly — the note channel

`CzarinaMatch.notes: PriceNote[]` → `apply.price_notes` → `lib/sync/findings.ts` → the Sync panel.
Durable, so it outlives the progress feed. **No note ever carries a ₱ value** (the findings channel
is not price-gated): a note identifies the ROW and describes the problem in words.

| kind | priced? | severity | meaning |
|---|---|---|---|
| `price_tab_unresolved` | no | **high** | no tab for that month — names the month AND all tabs found |
| `price_tab_ambiguous` | no | **high** | two tabs mean the same month — refused |
| `price_file_unreadable` | no | **high** | the buffer isn't a workbook |
| `price_fuzzy_match` | **yes** | attention | matched, but the sheets spell plate/supplier differently — both values shown |
| `price_fuzzy_ambiguous` | no | attention | fallback key not unique, or the sole hit agrees on nothing else |
| `price_date_drift` | no | attention | her file HAS the key, but months away |
| `price_out_of_band` | **yes** | attention | the rate is unlike this supplier's recent range |

`ok: false` means **no month resolved at all**. A PARTIAL failure stays `ok: true` — the months that
resolved were priced correctly, and the miss is still reported. `ProgressLevel` gained `error`
(`sync_run_events.level` is free text, no migration needed).

### 9.6 Learned aliases — earned, never guessed

`public.delivery_source_aliases` (+ service-role-only `fn_record_delivery_source_alias`, idempotent:
a repeat bumps `times_seen`, never rewrites `evidence`). A pair is written **only** after a match was
corroborated independently — a uniqueness-gated fallback, or a human. `evidence` is `NOT NULL`
precisely so a row cannot exist without saying how it was earned. An EXACT match teaches nothing and
records nothing. Seeded with exactly the three pairs Renzo confirmed. `ours`/`theirs` are stored
**already normalized** the way the matcher normalizes, so lookup is plain equality; supplier pairs
are keyed on `UPPER(TRIM())`, **not** canonical output (that would store a degenerate
`PAQUIBOT → PAQUIBOT` row saying nothing).

### 9.7 Sanity-check the RESULT, not just the key

Per-supplier ₱/kg band from priced history (trailing 90 days, grouped by `canonical_supplier`,
`cost_basis > 0` only — including the L-008 zero would drag every floor to 0 and make the check
vacuous). Bands with `n < 3` are dropped as non-evidence. Outside ±10% → `price_out_of_band`, which
**still enriches**: an out-of-band match is a question, not a veto. This is the only check that can
catch a match that passed every key test and is still wrong.

### 9.8 The unpriced warning, and the avg_cost narrowing

`view_digest_unpriced_deliveries` owns the ONE definition of "unpriced" (`cost_basis = 0`) and
"overdue" (`> 1` day past `transaction_date`, measured against
`view_digest_operational_days.operational_date` so it never fires on a day the plant hasn't
reported). `view_digest_unpriced_recent` was **rewritten as a thin count projection of it** —
same column, same type, same value (measured 7 → 7). The worker reads it on the view's own
`is_overdue`, never re-deriving the rule, so the sync and the Home digest cannot disagree.

`fn_recompute_batch_state` now averages `avg_cost` over **priced rows only**. **This is not a second
definition** — the BUG-018 formula is byte-identical, delivery-weighted; only the input set narrows,
because `cost_basis = 0` is the L-008 placeholder, not a ₱0 delivery. `current_weight` is untouched:
an unpriced delivery is still physically there.


### 9.9 The price file is identified by NAME, not by SENDER (2026-08-18, L-044)

**The sync read a bank cheque ledger as the price list for two weeks.** `GMAIL_CZ` is
`from:czarinaloumaximoictc@gmail.com newer_than:5d` — sender only — and `pickLatestXlsx` returned
the **first `.xlsx` it saw**. Measured over two weeks, all four of these had been used as "the price
file": `RAW CHARCOAL PURCHASES -Daily(1).xlsx` (correct),
`BDO REQUISTION DETAILS & WEEKLY CHECK ISSUANCE (REVISED)-2026.xlsx`, `VAN LOADING FILE.xlsx`,
`POWDER ( l. RIVERA).xlsx`.

The BDO workbook's tabs include **`AUGUST 2026`**, so §9.2's semantic resolver found the month, was
satisfied, and raised nothing; §9.5's whole-file alarm never fired because the file opened fine.
Four truckloads (2026-08-14, 69,900 kg) went in at ₱0 and the run reported success.
**Verifying that a NAME has the right SHAPE is not verifying it is the right THING** — and §9.2 made
the resolver *more* willing to accept a plausible name, so the two changes compose badly by design.

`MailQuery` (`workflows/mailClerk.ts`) gained two fields. **Three layers, each looser than the next,
only the innermost authoritative:**

| layer | field | what it is |
|---|---|---|
| 1 | the Gmail query (`has:attachment filename:xlsx`) | a **search hint** — Gmail decides what `filename:` means; an operator is not a contract |
| 2 | `attachmentPatterns` (`*raw*charcoal*purchase*.xls*`) | which part's **BYTES are downloaded** |
| 3 | `attachmentMatches` | **the guard** |

Layer 2 is not an optimisation: `gmail.searchLatestAttachment` materializes exactly ONE part — the
newest email carrying a **matching** part — so narrowing it lets the clerk walk back past a newer,
unrelated workbook and **RECOVER** the right file, rather than merely rejecting the wrong one. When
all three come up empty the manifest stores **nothing**, and §9.10's `price_file_missing` reports it.

`normalizeAttachmentName` folds the ways a filename drifts (case, spacing, punctuation, a `(1)` copy
suffix) and is **tenant-free**; the phrase `RAW CHARCOAL PURCHASES` lives on the query definition,
beside the already tenant-specific query string. `pickLatestXlsx` stays generic and knows no filenames.

**Audit of the other six queries (do not churn them).** A query is exposed when its scope does not
pin the DOCUMENT — only the sender or the window. `deliveries_czarina` was the **only** sender-only
one. `rc_out_movement` is subject-scoped (`subject:"RC MOVEMENT"`), and the other five are pinned by
subject AND (label or sender). Adding a predicate to a subject-pinned query buys nothing and costs a
second place for a rename to break the sync silently.

### 9.10 A 100% unmatched rate is a FILE problem (`price_no_row_matched`, **high**)

The wrong workbook's **only** symptom is the RESULT: every row returns `no_candidate`, which the
matcher documents as *"an ordinary unmatched row, not a finding."* So the aggregate is now watched.
The note names the **FILENAME used** (passed in via `EnrichDeps.filename` — `enrich` never matches on
it) and the **TABS resolved**, plus `rows_loaded` / `rows_considered`.

**Why 100% and not a percentage.** A partial miss is NORMAL: Czarina records the payment date, so
yesterday's trucks legitimately are not in her file yet. The honest alarm for that already exists and
is time-based and per-row — `unpriced_overdue` (§9.8). Any threshold in between is a number invented
to feel safe, and one that fires on a normal day is how an operator learns to stop reading the list.
100% is the only structural line: the window is `watermark − 3 days`, so it always contains several
days of deliveries that *are* in her file.

Two more kinds joined the §9.5 table:

| kind | priced? | severity | meaning |
|---|---|---|---|
| `price_file_missing` | no | **high** | no recognisable price workbook in the 5-day window at all |
| `price_no_row_matched` | no | **high** | the file opened, a tab resolved, and NOT ONE row matched |
| `price_overdue_check_failed` | n/a | attention | the unpriced check could not run — see §9.11 |

`price_file_missing` is new because the §9.9 guard makes "no price file" a state the sync can now
reach **on its own**, and a guard that can silence the price step must not do so quietly. It was
previously a progress beat only, i.e. it died with the run. The 5-day window means a single missed
send does not reach it.

### 9.11 A DB-backed check must not sit behind a MAILBOX-shaped guard

`readUnpricedOverdue(db)` reads the DATABASE — it exists to catch a price outage *independent of
why* — but it sat AFTER `runReport`'s "no RC DELIVERIES attachment" early return, so it was gated on
the very thing that had failed. The four ₱0 rows crossed the overdue threshold on **exactly the day**
the workbook stopped arriving, and the alarm was skipped on the first day it would have fired. It now
runs on **every** deliveries run, in both branches.

It also ended in `catch { return [] }` — so a broken read and a genuinely clean database returned the
same answer, and the run would state "nothing overdue" on the strength of a question it never asked.
It now returns `{rows, error}`, and an error becomes `price_overdue_check_failed`: *"this run CANNOT
say whether any are overdue; read the absence of that warning as 'not checked', not as 'none'."*
`attention`, not `high` — nothing is known to be wrong with a delivery; what broke is the ability to
look.

### 9.12 A missing daily report is a FINDING, not a reassurance (`report_not_received`)

The early return emitted *"Nothing new today — no RC DELIVERIES report waiting."* at **100%
progress**, on the days RC IN was going stale. It reads as *checked, all fine*.

**No second staleness rule was invented.** Severity comes from
`view_digest_stream_status.missed_working_days`, which already excludes rest days and reports that
are not due yet, on the L-042 ladder — `info` 0-1, `attention` 2-3, `high` 4+ — measured in
**Asia/Manila**. A missing number gives `missed_working_days = null` (never 0, which means
"measured, on time") reported at `attention`, because "we don't know" must not be quieter than "we
measured it and it is fine". Constructor: `reports/reportNotReceived.ts`; reader:
`lib/streamStaleness.ts::findStreamStatus` (the same columns `findStaleStreams` selects — one view,
one rule).

**A missing number says WHICH kind of missing** (`lateness_unknown_reason`, tightened same day). One
bare `null` meant three different things, and the operator's next action differs for each:

| reason | what happened | who fixes it |
|---|---|---|
| `unreadable` | the view could not be read — **the 42501 grant failure that blinded the freshness watch for two weeks** | engineering: grants / the view |
| `unregistered` | the view read fine and has no row for this stream | config: `view_digest_stream_registry` |
| `not_computable` | the row exists but the stream has **never reported**, so there is no baseline to count from | nobody — there is nothing to measure yet |

`not_computable` exists because the view returns SQL NULL in that case and `asNum` would read it as
`0` — *"measured, and on time"*. That is `Number(null) === 0` a second time in the same feature, in
a different helper. All three still report at `attention`; only the words change.

**It is NOT a duplicate of `stale_stream`.** That is a DATA fact (the table has no rows for recent
working days); this is a FETCH fact (no email was in the mailbox window). Each is true without the
other in a case that matters, and the one that justifies firing even at `missed_working_days = 0`:
the Google Sheet pass keeps `deliveries` current while the email pipeline is quietly dead —
`stale_stream` is then silent and CORRECT, and this is the only thing in the system that notices.
When both fire, the data-side finding carries the alarm and this one carries the explanation, which
is why its ladder starts quieter.

### 9.13 Do the four ₱0 rows self-heal?

**Yes, but only inside a closing window.** The path exists: `field_differences` DOES diff
`cost_basis` once the extracted side is non-null (`classify.ts` — it is skipped only when the
operator file carries no price), so an enriched row classifies VALUE_CHANGED and writes through
`fn_apply_delivery_upstream`, whose allowlist includes `cost_basis`. All four rows are
**`human_edited_at IS NULL`**, so the latch will not refuse them.

The constraint is the WINDOW. `since = dataWatermark("deliveries") − 3 days`, and the watermark is
`MAX(transaction_date)`. With the watermark at **2026-08-14** the four 08-14 rows are inside the
window. The watermark is read at the START of a run, so a run that ingests 08-15…08-18 for the first
time still re-prices them in that same run. But once a delivery dated **2026-08-18 or later** is on
record, `since` becomes 2026-08-15+ and those rows leave the window **permanently** — after that they
need a manual re-price.

---

## 10. The human-edit latch (2026-08-08) — a warning written as a comment is not a control

Migration: `supabase/migrations/20260808015712_deliveries_human_edit_latch.sql`.
This is the port of production's §7 latch (`specs/production.md`) onto `public.deliveries`.
Read that section first; only the differences are spelled out here.

### 10.1 The evidence, stated plainly

On **2026-02-04** the Google Sheet had a truck's `FEB-26-BLK4` / `FEB-26-BLK5` assignment
swapped. Renzo corrected it in Blackwood and never corrected the Sheet. On **2026-06-25**
someone recorded that fact as an `audit_logs` **comment**, verbatim:

> DO NOT auto-revert to the Sheet value: any Sheet-vs-DB conflict on this row must be
> FLAGGED for human review, never applied Sheet-wins.

The sync overrode the row anyway, on **07-03** and again on **08-07**. The comment was
prose in a table nothing reads at write time. **An operational rule is only enforced when
it is a predicate in the statement that does the writing.** Never write a rule into a
remark, a note or a docstring and treat it as a control.

The exposure the latch actually closes is measured, not hypothetical. `deliveries` had TWO
unguarded sync UPDATE paths, and unlike production's — which was DORMANT, its patch shape
never matching — **both are live and one has fired**: 40 `audit_logs` UPDATE rows on
`deliveries` carry `provenance=gsheet`, and four of them landed on a row Renzo had already
edited by hand (three of those four also carry a same-day adjudication comment, so no
*silent* loss is provable in the trail — the exposure is structural).

**The latch is not the fix for the Feb-4 incident.** Nothing was overwritten there; the
sync INSERTED a second row. `lib/deliveryIdentity.ts` (the two-tier identity, shipped the
same day) is what prevents that. Identity stops a correction being **duplicated**; the
latch stops a correction being **overwritten**. Complementary, and neither substitutes for
the other.

### 10.2 The five rules, as they land here

| # | Rule | Where |
|---|---|---|
| 1 | A delivery a human edited in the app is never updated by the sync | `fn_stamp_human_edit` BEFORE INSERT/UPDATE on `deliveries` — the production function **reused verbatim, never cloned**, so "how a row gets claimed" keeps exactly one definition |
| 2 | The guard is `human_edited_at IS NULL` inside the UPDATE's own WHERE | `fn_apply_delivery_upstream(p_ops)`, reached from `DbClient.applyDeliveryUpstream`. **No read-then-write and no worker-side pre-check** — see §10.4 |
| 3 | The disagreement is surfaced, naming the row and BOTH values | `reports/deliveryHumanEdit.ts::deliveryHumanEditNote` → `apply.delivery_human_edits` → `lib/sync/findings.ts` kind `delivery_human_edited` (`attention`) |
| 4 | Release is the explicit way back | `fn_release_delivery_rows(p_ids)`. **No server action yet** — see §10.6 |
| 5 | Inserts are unconstrained | The RPC has no INSERT branch at all; NEW rows keep going through `insert_if_absent` |

### 10.3 Both writers, one note

`deliveries` is written by **two** pipelines, so the latch had to be applied twice and the
refusal described once:

| Writer | Was | Now |
|---|---|---|
| `reports/deliveries/apply.ts` (emailed RC DELIVERIES report) | `db.update("deliveries", {id}, patch)` | ops collected per row → ONE `applyDeliveryUpstream` call |
| `reports/gsheet/apply.ts` (Sheet-wins pass, rc_in only) | `db.update("deliveries", {id}, patch)` | same, and **rc_out is untouched** — it has no latch |

Both build the note through the single constructor in `reports/deliveryHumanEdit.ts`. If
they described the same refusal differently, a Sheet refusal and an email refusal would
read as two unrelated problems — the same reason `lib/deliveryIdentity.ts` is shared.

### 10.4 Why the op is SENT rather than pre-filtered

Production's apply carries `human_edited_ids` in its compact and drops the op before the
writer. Deliveries does **not**, on purpose: the compact is built from a classify read that
may be seconds or minutes old, and a pre-check would be exactly the read-then-write this
section forbids. The op goes to the RPC, the RPC's own WHERE refuses it, and the refusal
comes back as the string `human_edited`. A save that lands between classify and apply
therefore wins, and it is always visible.

### 10.5 Outcomes, and which ones are errors

`fn_apply_delivery_upstream` returns `[{id, outcome}]`:

| Outcome | Worker behaviour |
|---|---|
| `applied` | counted as an update; the trigger-audit stamp runs as before |
| `human_edited` | **not** an error — a `delivery_human_edits` note + a `warn` progress beat |
| `missing`, `empty_patch`, `unsupported_field`, `not_applied` | pushed to `errors[]`, which blocks the watermark bump AND the Gmail label |

The allowlist is exactly the **nine** fields the two classifiers can diff: `supplier`,
`batch_code`, `block_loc`, `truck_plate`, `sacks`, `weight_kg`, `cost_basis`, `remarks`,
`lab_results`. Absent deliberately: `transaction_date` (it is in BOTH identity tiers, so a
VALUE_CHANGED diff can never legitimately contain it), `true_weight_kg` / `deduction_note`
(additive, never diffed — L-021), `id` / `created_at`. A patch key outside the list refuses
the **whole op** rather than smuggling a column in.

### 10.6 What is NOT built

- **No in-app release door.** `fn_release_delivery_rows` exists and is granted to
  `authenticated`, but nothing calls it — there is no `releaseDeliveryRows` server action
  and no UI, so today a release is a service-role call. Production's equivalent
  (`releaseProductionRows` in `app/(app)/production/actions.ts`) is the pattern to copy.
- **No `pending_upstream` and no `row_version`.** Same reasoning as production: the latch
  is monotone, so there is no ABA race for a version token to catch, and both sources are
  cumulative so a parked proposal would only duplicate what the next run rebuilds.
- **Nothing in the Python oracle.** The parity harness compares `classifyCase` only
  (extract → classify); no `phase_apply` exists in the repo any more, so the latch has no
  oracle counterpart to keep in lockstep.

### 10.7 The two interactions that needed care

1. **`log_delivery_changes` had to be patched in the same migration.** It builds its diff
   by iterating every key of `to_jsonb(NEW)`, and the stamp changes on every authenticated
   write — so without an exclusion, an app UPDATE that moved nothing else would start
   writing a fabricated `human_edited_at: {old, new}` "delivery edited" event into the
   activity feed and `view_digest_audit_enriched`. The two latch columns are excluded from
   the **diff**, never from the **snapshot**. Restores the previous behaviour exactly.
2. **BUG-017 is not reintroduced.** All four existing `deliveries` triggers are AFTER;
   the stamp is the only BEFORE trigger, and Postgres orders BEFORE ahead of AFTER
   unconditionally. `fn_update_blackwood_state` recomputes from the BASE TABLES via
   `fn_recompute_batch_state`, not from `NEW`, so a stamp cannot move `current_weight` or
   `avg_cost` — verified as **zero drift across all 697 batches** after the migration.

### 10.8 ₱ safety — the one thing production did not need

`cost_basis` is one of the nine refusable fields, and the run-findings channel is **not**
price-gated (Sync panel, Excel workbook, digest — no `canViewPrices()` anywhere in it). So
a refused price is reported **by NAME ONLY**: `{field: 'cost_basis', yours: null, sheet:
null, redacted: true}`.

`formatFindingData`'s cost-key strip cannot cover this — it skips a top-level key whose
*name* looks cost-ish, and these values sit nested inside a `changed_fields` value. The
redaction therefore happens where the note is built (`REDACTED_FIELDS` in
`reports/deliveryHumanEdit.ts`, the only constructor) and is **re-applied** in
`workflows/normalizeReport.ts`, which is the door every replayed or hand-built envelope
comes through. Two independent defences: a ₱ can only reach the channel if both are removed
in one edit. The Excel workbook branch in `reports/excel/workbook.ts` prints
`cost_basis (not shown)` on both sides — the workbook is a FILE, and
`sync_run_reports.contains_prices` gates its download on a measured fact, so one ₱ printed
there would lock the report away from the people who need it.

`view_deliveries_human_edited` likewise carries **no ₱ column**: the refusal names the ROW,
and the number stays in RC IN behind `canViewPrices()`.

### 10.9 Tests and proof

- `test/reports/deliveries-human-edit.test.ts` — 19 tests: an unlatched row still updates
  (and only through the guarded path, for BOTH writers); a latched row is refused with both
  values reported; a mixed batch refuses only the latched row; a non-human outcome is an
  error that blocks the watermark; inserts stay unconstrained; a refused ₱ is name-only at
  the constructor, in the apply result, through `normalizeApply`, in the finding and in the
  workbook; the finding names the row, both values, `attention`, and the right section.
- `test/reports/gsheet.test.ts` — the L-018 decision-honoring tests now assert the rc_in
  write is the conditional RPC and that `db.update` is never reached.
- **The DB half was proven against production in a transaction forced to roll back** (a
  terminal `RAISE`, verified afterwards to have left zero residue): insert unconstrained →
  latched refused with the value unchanged → unlatched applied → release returns
  `released=1 skipped=1` and clears the stamp → the released row applies → an
  off-allowlist patch returns `unsupported_field` and writes nothing → an unknown id
  returns `missing` → an empty patch returns `empty_patch`.

---

## 11. An operator's shorthand is a NAMING CONVENTION, not malformed input (2026-08-13, L-042)

Two changes, one lesson. Both are about the same failure: the pipeline treated *the way a human
writes things down* as *bad data*, and then asked a human to arbitrate a question the system already
knew the answer to.

### 11.1 `FEEDING # N` is accepted (the valuable half)

`FEEDING_AREA_RE` was `^FEEDING\s+AREA\s*(\d*)$` — the spelling the **Sheet** uses. MC types
`FEEDING # 1` in column D. That label therefore fell through to the raw-value branch, where it was:
**truthy** (so it passed the malformed guard), **not pattern-valid** (so `batchAutoCreate` would
never touch it), and consequently **held on every single run, forever**. Two real truckloads were
stuck: `2026-08-05 / AAV 6111 / 19,185 kg` for a week, and `2026-08-12 / KCA 378 / 18,650 kg`.

The regex is now `^FEEDING(?:\s*(?:AREA|NO))?\s*[#.:-]?\s*(\d*)\s*\.?$` and **there is no new output
format** — every accepted spelling goes down the identical `"{MMM}-{YY}-FEED{N}"` branch.

| Accepted | Rejected, on purpose |
|---|---|
| `FEEDING AREA 2` · `FEEDING # 2` · `FEEDING #2` · `FEEDING NO. 2` · `FEEDING NO 2` · `FEEDING 2` · `FEEDING AREA #2` · `FEEDING AREA 2.` (any case, trimmed) | `FEEDING AREA A` — a letter is not an area number |
| bare `FEEDING` / `FEEDING AREA` — numberless, so the pre-existing raw-label + "needs manual mapping" warning is UNCHANGED | `FEEDING AREA 1 AND 2` — two areas is not one batch |
| | `RE-FEEDING 1` — `REFEED` is its own batch family (`MARCH-26-REFEED1`) |
| | `FEEDINGS 2`, `SUNDRY FEEDING 1`, and bare `FEED` (a batch is literally NAMED `FEED`) |

The anchor is a leading `FEEDING`, and after the optional `AREA`/`NO`/`#` designator only **digits**
may follow — that is what keeps the widening from becoming a catch-all.

### 11.2 The trap this would have walked into: a month-prefix alias is not a disagreement

Translating the label is not enough. The extractor derives the FEED code from the delivery month
using the **FULL** month name (`MONTH_ABBR`, all twelve values are full names), so `FEEDING # 1` on
2026-08-05 becomes `AUGUST-26-FEED1`. **The database spells that batch `AUG-26-FEED1.`** Measured on
`batches`, 2026-08-13: August *feed* batches read `AUG-26-FEED1/2`, while August *blocks* read
`AUGUST-26-BLK1/2/5`. Both conventions are live, and always have been.

Under the two-tier identity (L-040b) the email row MATCHES the DB row on tier 1 — same date, same
plate, same sack count — and then "disagrees" on `batch_code`. So a pure naming-convention
difference would have become a `cross_batch_reassignment` held case asking a human to pick between
two spellings of one batch: the shorthand bug, moved one layer down rather than fixed.

`workers/sync/src/lib/batchCodeAlias.ts` is now THE one definition of "same code, spelled
differently", built on the alias table that already existed (`batchCodeFallbacks`, a port of
`extract_gsheet.py::batch_code_fallbacks`). It is used in **two** places, and the distinction
matters:

- **`batchCodeAliasEqual` in `field_differences`** — decides whether the two sources actually
  disagree. This is what makes the 2026-08-05 row a clean **NOOP**.
- **`resolveKnownBatchCodeAlias` in the guard** (rule 3b above) — decides what a genuinely NEW row
  gets WRITTEN as. Without it, widening the label would have replaced an obviously-junk
  `FEEDING # 3` batch with a plausible-looking duplicate `AUGUST-26-FEED3` sitting beside the real
  `AUG-26-FEED3` — trading a loud wrong for a quiet one.

**It is not a fuzzy matcher and it invents nothing.** Only the prefix pairs in the existing table
collapse, and only when the year and the whole suffix are byte-identical. `JULY-26-BLK9` vs
`JUNE-26-BLK9` — the L-033 month-boundary phantom, and the pair BOTH deliveries parity fixtures turn
on — is untouched, as is `SEP` vs `SEPT` (the table says each maps to `SEPTEMBER`, not to each
other, so nothing is asserted that the table does not already say).

### 11.3 "Not filled in yet" is not MALFORMED

The malformed guard sent every row missing `transaction_date` / `batch_code` / `weight_kg` to
MALFORMED, whose operator-facing label is **"Row could not be read"**. MC books overnight weights in
early with only the truck plate, the weight and the moisture, and assigns the pile later in the day.
Two such rows were reported malformed on 2026-08-12 and had filled themselves in by morning.

There is now a separate `awaiting_assignment` bucket + `summary.awaiting_assignment_count`.
`isAwaitingBatchAssignment` (mirrored as `is_awaiting_batch_assignment`) requires **all four**:

1. a `transaction_date` (forward-filled counts);
2. a real `weight_kg` — a 0 weight is a data problem, not a pending assignment;
3. `batch_code` missing **because the Block cell was empty** (`operator_batch_label is None`) — a
   label that EXISTS but did not translate comes back as the raw label and never reaches this guard;
4. **a truck plate.**

**Clause 4 is the whole point of the predicate.** An ORPHAN wet-recovery sub-row — a continuation row
with no mother delivery to inherit from — has the same missing batch code, and it is genuinely bad
data. It is DEFINED by having no plate, no batch and no block (`is_recovery_row_dict`), so it fails
clause 4 and **stays MALFORMED and stays loud**. When the two cannot be told apart (no plate AND no
label), the loud answer wins. `malformed` was NOT widened; one shape was carved out of it.

### 11.4 How the new class behaves — quiet, but not silent

- **Never held.** It is not pushed into `apply.held`, so no durable `sync_held_cases` row is created
  and nothing has to be closed by hand. It does not touch `errors`, so the watermark and the Gmail
  label are unaffected. It self-clears when MC types the pile in.
- **Reported through the existing finding vocabulary**, not a parallel taxonomy:
  `apply.awaiting_batch_assignment` → `collectAwaitingBatchAssignments` →
  `lib/sync/findings.ts::fromAwaitingBatchAssignment`, `kind: 'awaiting_batch_assignment'`,
  `section: 'deliveries'`. It therefore lands on the Deliveries sheet of the Excel report with no
  generator change.
- **Severity escalates with age**, the `unpriced_overdue` pattern — because a row that NEVER gets
  filled in is a real problem, and nothing else in the system can see it (the row is not in the
  database, so no unpriced or stale-stream check will ever notice):
  **`info` at 0–1 days** (the ordinary same-day case) → **`attention` at 2–3** (it did not
  self-clear overnight) → **`high` at 4+** (not late any more, forgotten). `days_pending` is measured
  against the run's **Asia/Manila** date, not UTC, so the threshold does not depend on what hour the
  sync happens to run.

### 11.5 Parity

Both halves changed the extractor AND the classifier, so `extract_rc_deliveries.py`,
`classify_deliveries.py` and `parity_guards.py` moved in the SAME changeset and the oracle was
rebuilt. `npm run parity` is green with **no new `expected-deviations.json` entry** — a deviation is
for an oracle *bug*, never for a change we chose (the L-034 / L-037 / L-040b precedent). The only
oracle delta is the two new empty keys (`awaiting_assignment`, `awaiting_assignment_count`); both
fixtures' existing `JULY-26-BLK9` vs `JUNE-26-BLK9` identity diffs survive unchanged, which is the
proof that the alias equality does not over-collapse.

Tests: `workers/sync/test/reports/deliveries-feeding-label.test.ts` (17 cases, every row read out of
the live DB) and `scripts/verify-awaiting-batch-assignment-fold.ts` (8 checks, the pure app-side
fold).

---

## 12. A block two batches both claim is a HELD ROW, not a crash (2026-08-25, BUG-027)

This section is filed here because `deliveries` is one of the writers, but it governs **every
writer that creates a `batches` row**: `reports/deliveries/apply.ts`, `reports/gsheet/apply.ts`
(both its NEW rc_in lane and its UNMAPPED auto-create lane) and `reports/rc_out/apply.ts`.

### 12.1 The incident, measured

Run `afac05bd` (2026-08-25). The Google Sheet's one NEW RC IN row — 2026-08-21, Ornales,
16,840 kg, truck `TEMP138003`, block **D-20D**, brand-new pattern-valid batch **`AUG-26-BLK11`** —
went through the 2026-07-11 auto-create policy. `deriveBatchFields` produced
`location_ref = 'D-20D'`, and the DB refused the INSERT with **23505** on the partial unique index
`idx_unique_active_batch_per_location`, because **`JUNE-26-BLK6` is still IN-USE at D-20D with
4,680 kg** (last fed the same day — the yard finished the pile and reused the block; the Sheet's own
Blocking tab shows `ERROR` at D-20D).

Two defects, one incident:

1. **The throw escaped `ensureBatch`, escaped `applyFromCompact`, and was caught only at the mode
   boundary in `applyGsheet`.** So the whole RC IN write was discarded: `applied: {inserts: 0,
   updates: 0}`, the watermark did not move, the other **13** updates were lost from the run result,
   and every subsequent run re-failed identically. A block two batches both claim is a *human
   arbitration* — the founding rule of this whole pipeline — and this codebase has exactly one
   shape for that: a **held row**. It is never a fatal error.
2. **The raw Postgres string was the sentence the operator read.** `apply.errors[]` is joined
   verbatim into the employee card's inline error block (`lib/sync/reducer.ts::gateErrorFrom`), so
   the panel said `rc_in apply: upsert_batch_if_absent batches failed 23505: duplicate key value
   violates unique constraint "idx_unique_active_batch_per_location"` — naming neither batch,
   neither block, nor any action. Renzo, verbatim: *"bruh, these errors in the sync panel have to be
   way more understandable to a normal user."*

### 12.2 The seam — one module, four call sites

`workers/sync/src/lib/batchLocationConflict.ts` owns **all four** of: the predicate
(`isLocationCollision` — previously duplicated byte-for-byte in two apply files), the occupant
lookup, the sentence, and the structured held-row payload.

`ensureBatch` (which BOTH the gsheet UNMAPPED lane and the rc_out UNMAPPED lane call) now catches
the 23505 and returns a new outcome **`location_conflict`** carrying both sides; the two defensive
`db.insert("batches", …)` sites keep their own `catch` but build the identical held row from the
identical module. That is why the two writers cannot describe one clash two different ways — a
worker test asserts the email path's sentence is **byte-identical** to the Sheet path's.

`ensureBatch` deliberately **does not seed `lookup`** on a conflict: the batch does not exist, so a
later row in the same pass must never resolve to an id that was never created.

### 12.3 What the held row says

- **kind** `batch_location_conflict` (a NEW `HeldKind` — see 12.5).
- **detail** — THE message, built once by `batchLocationConflictDetail`:
  > New batch AUG-26-BLK11 wants block D-20D, but JUNE-26-BLK6 is still marked active there with
  > 4,680 kg left (last fed 2026-08-21). If that block is finished, close JUNE-26-BLK6 and the next
  > run will file this delivery.

  Both batch codes, the block, the balance, the last-fed date, the action. **No SQLSTATE, no
  constraint name, no ₱** — asserted. It degrades honestly: no occupant found → *"another batch is
  still marked active there"*; never fed → the `(last fed …)` clause is simply absent; `feeding`
  replaces `delivery` on the rc_out lane.
- **row** — the report's own key fields PLUS `attempted_batch_code`, `location_ref`,
  `occupying_batch_code`, `occupying_status`, `occupying_balance_kg`, `occupying_last_fed`, and
  **`db_error`** (the verbatim refusal). The raw error lives HERE, for the Copy button and the Excel
  report's `Details` cell — never in a headline. No cost-ish key appears, by assertion.

The occupant lookup is two indexed read-only selects (the ACTIVE batch at that `location_ref` —
`STORED | IN-USE | SUNDRYING | SUNDRIED`, i.e. exactly what the index covers — then its newest
`rc_out.transaction_date`). It **never throws**: a hold must not become the crash this section
exists to prevent, so a failed lookup yields `null` and the message falls back to naming the block.

### 12.4 Watermark semantics — unchanged, and that is the point

`held` has never blocked a watermark bump; `errors` has. The clash moves from `errors` to `held`, so
**the watermark now advances** and the rest of the report writes normally — exactly the semantics
`cross_batch_reassignment` and `already_exists` already have. The hold is rebuilt from the source
every run (nothing is parked), so it re-raises until a human closes the occupying batch or corrects
the block, and then stops on its own.

### 12.5 A NEW kind, not a re-wording

`HeldKind` gained `batch_location_conflict` rather than re-wording `location_occupied` in place. The
case fingerprint is `(reportType, kind, natural_key)`, so re-wording would have let an old
acknowledgement of the vague hold silently answer the specific one. `location_occupied` stays in the
enum because old runs and old `sync_held_cases` rows still carry it; nothing raises it any more.
Because the enum is frontend-locked (exhaustive `Record<HeldKind, …>` maps live in `components/`),
the kind was added to every one of them in the same changeset: `app/(app)/sync/types.ts`,
`adjudication.ts::KIND_MEANING` (+ its evidence lookup, which now re-reads the block so the
adjudicator sees what is true *now*), `components/sync/cases/labels.ts::KIND_LABEL`,
`components/sync/HeldRows.tsx::SHORT_KIND`, and `lib/sync/findings.ts`
(`HELD_KIND_LABEL` / `heldSeverity` → `attention` / `SHORT_KIND`).

### 12.6 No raw DB error is ever a panel headline (the general rule)

`workers/sync/src/lib/operatorError.ts` is the ONE shape for every `apply.errors[]` push:

```
<plain-language headline: what failed, what was and was not saved, what happens next>
Technical detail: <the raw error, verbatim>
```

All 16 push sites across the five apply files were rewritten. The raw string is never lost — it
moves one line down, under a label — so the Copy button still gives a developer everything.

### 12.7 Parity

**Apply-phase only.** The parity gate is CLASSIFY-only and nothing in extract/classify moved, so
`npm run parity` is green with **no new `expected-deviations.json` entry**. `SHARED.md` §3.4 records
the TS divergence from the Python oracle's `location_occupied`.

### 12.8 Tests

`workers/sync/test/reports/batch-location-conflict.test.ts` — 18 cases: the predicate (including
what it must NOT swallow), the sentence and its degradations, the lookup's never-throws contract,
`ensureBatch` returning the outcome (and still rethrowing a non-clash), the apply holding one row
while the other rows still apply and the watermark still advances, the raw string being absent from
`errors[]`, and the two writers producing the identical sentence. App-side:
`scripts/verify-findings.ts` (3 new checks — headline carries no SQLSTATE, the raw error rides in
`data`, the fingerprint equals the durable case fingerprint and survives the numbers moving) and
`scripts/verify-decision-cards.ts` (1 new check — the card renders with `[Acknowledge]` and hides
when acknowledged).
