# gsheet.md — Google Sheet (RC IN + RC OUT tabs) → `deliveries` + `rc_out`

Scripts: `extract_gsheet.py` (493 lines), `classify_gsheet.py` (586 lines),
`sync_gsheet.py` (644 lines, the most complex orchestrator — DUAL CLI, legacy employee shape
PLUS the SYNC_CLI_CONTRACT "Run Sync" button shape, coexisting byte-identically).

Read SHARED.md first. **This is the ONLY pipeline pulling from a Google Sheet (no Gmail, no
email), and the ONLY one whose "watermark" is a fixed SCOPE FLOOR (2025-01-01) rather than a
live `MAX(date)` value** — re-classifies its ENTIRE 2025+ history every single run, forward-only.

---

## 1. Pipeline narrative — TWO coexisting CLIs

`sync_gsheet.py` predates the SYNC_CLI_CONTRACT and keeps its LEGACY employee CLI working
byte-for-byte, while ALSO speaking the newer contract CLI. Both share the exact same core
functions (`_classify_one_mode`, `_apply_from_compact`) — the CLIs differ only in how they're
invoked and what they print/emit.

### 1.1 Sheet download (`ensure_workbook`, sync_gsheet.py:202-217) — shared by both CLIs

`GSHEET_FILE_ID = "1yBZ0wW0DTr4ktYYtDIgXSVVoGsiETawyppkdyV1EiMM"` (hardcoded). Export URL: `https://docs.google.com/spreadsheets/d/{FILE_ID}/export?format=xlsx`. Downloaded via `curl -sL {url} -o {xlsx_path}` — **NO auth, link-shared "anyone with link" access assumed.** Downloaded ONCE per `work_dir` (checked via `xlsx_path.exists() and .stat().st_size > 0` — an existing non-empty file is reused across BOTH rc_in and rc_out classify calls in the same run, since they're the same workbook's two tabs). **Verification**: the first 2 bytes of the downloaded file must equal `b"PK"` (the ZIP magic number every xlsx starts with) — if not, raises `RuntimeError` with the message "Sheet not reachable as XLSX (got an HTML login page?)... re-share as 'anyone with link'." This is the ONLY validation that the download actually succeeded (curl itself doesn't fail on an HTML error page — it just downloads whatever bytes came back).

### 1.2 LEGACY CLI (`--phase classify --mode rc_in|rc_out --since ...`, `--phase apply --decisions <file>`)

**Classify** (`phase_classify`, sync_gsheet.py:259-285): calls `_classify_one_mode(work_dir, mode, since)` for ONE mode only (rc_in OR rc_out, whichever `--mode` says), prints a COMPACT summary object to stdout (never the row set) with `decisions_file` and `full_classified_file_for_audit_only` paths.

**Apply** (`phase_apply`, sync_gsheet.py:469-473): reads a SINGLE mode's approved `--decisions` file, calls `_apply_from_compact(compact)`, prints its raw result dict. **This is the path L-018 warns about**: the apply function honors ONLY a top-level `"skip": true` boolean on a `changed` item, NOT a `"decision":"skip"` string field — if the reviewer/agent annotated items with `decision` but the apply function doesn't check that key, those items get APPLIED anyway. Verbatim from `_apply_from_compact` (lines 396-411): the `changed` loop only checks `if r.get("skip"):` — it never reads `r.get("decision")` at all for the `changed` bucket (contrast with `flagged`/`unmapped`, which DO check `r.get("decision")`).

### 1.3 CONTRACT CLI (`--json` present AND `--mode` ABSENT — this combination selects the button path)

**Classify** (`phase_classify_contract`, sync_gsheet.py:489-543): runs BOTH `rc_in` and `rc_out` via `_classify_one_mode` in sequence (rc_in first, then rc_out), building:
- `combined_actionable`: every actionable item from both modes, each tagged with `_mode`.
- ONE combined `decisions_gsheet.json` file: `{"report_type": "gsheet", "since": since, "modes": {"rc_in": {...compact...}, "rc_out": {...compact...}}}` — this is the file passed to `--input` on the contract apply call.
- `counts` are SUMMED across both modes (`totals["noop"] += s["noop_count"]`, etc.).
- `rows_preview` mixes BOTH modes, each `natural_key` prefixed `"{mode}:..."` so a human reviewer can tell which tab a row came from.
- `watermark` in the envelope = the `since` value used (the 2025-scope cutoff), NOT a live `MAX(date)` — because gsheet has no single natural "watermark table"; it re-scans the whole 2025+ window every run by design.

**Apply** (`phase_apply_contract`, sync_gsheet.py:546-591): reads the combined file, iterates `modes.items()` (rc_in then rc_out, dict insertion order — Python 3.7+ preserves insertion order, and this dict is built in that exact order at classify time), calls `_apply_from_compact(compact)` for EACH mode, sums `inserted`/`updated` across both. **`labeled` is ALWAYS `False`** (hardcoded, sync_gsheet.py:590 and in the apply_envelope call) — a Google Sheet has no Gmail thread to label; this is BY DESIGN, not a bug, but `watermark_updated` STILL happens (`ingestion_watermarks` row upserted with `report_type='gsheet'`, `last_email_id=None`).

---

## 2. Extraction spec (`extract_gsheet.py`)

### RC IN tab

Header on ROW 7 (fixed, not dynamically located — unlike the email deliveries extractor). Data rows 8..end. Column map (`RC_IN_COLS`, extract_gsheet.py:212-217):

| Col | Field |
|---|---|
| A(1) | state |
| B(2) | whse |
| C(3) | transaction_date |
| D(4) | supplier |
| E(5) | batch_code (**already full Blackwood-style codes, e.g. `"MAY-26-BLK13"` — unlike the email's short `"B09"` operator labels**) |
| F(6) | block_loc |
| G(7) | truck_plate |
| H(8) | weight_kg |
| I(9) | sacks |
| J(10) | lab_mc |
| K(11) | lab_grit |
| L(12) | lab_bd_astm |
| M(13) | lab_bd_jis |
| N(14) | lab_vm |
| O(15) | lab_ash |
| P(16) | lab_fc |
| Q(17) | remarks |

Columns R..X (WTD* weighted-product columns) are **IGNORED entirely** (never read, never surfaced, not even for informational display).

### Row skip / date carry-forward (RC IN)

A row is skipped if `transaction_date is None AND weight_kg is None AND batch_code is None AND supplier is None` (the sheet is padded with ~2,000 trailing blank rows to a fixed max-row count — this skip is what filters those out). `source_rows` is incremented for every NON-skipped row (used only for the summary count, not a data field).

`has_own_date = txn_date is not None` computed BEFORE forward-fill (used by the recovery-row predicate, same pattern as the email extractor). Forward-fill: if the row's own date parse failed, uses `last_seen_date`; if THAT is also `None`, adds a warning but the row is still emitted with `transaction_date=None` (unlike the email extractor, which SKIPS a row with no date and no prior date — this Sheet extractor emits it anyway, deferring the MALFORMED decision entirely to the classifier).

### `batch_code_fallbacks` — VERBATIM alias table (extract_gsheet.py:83-96, `MONTH_PREFIX_ALIASES`)

```
JAN <-> JANUARY
FEB <-> FEBRUARY
MARCH <-> MAR
APRIL <-> APR
MAY: no alias (already the shortest/canonical form)
JUNE <-> JUN
JULY <-> JUL
AUG <-> AUGUST
SEPT <-> SEPTEMBER, SEP <-> SEPTEMBER  (note: SEPT and SEP BOTH map TO SEPTEMBER, but SEPTEMBER maps back to SEPT specifically, not SEP — asymmetric)
OCT <-> OCTOBER
NOV <-> NOVEMBER
DEC <-> DECEMBER
```

`batch_code_fallbacks(batch_code)` (lines 173-202): parses the code via `BATCH_CODE_RE = r"^([A-Z]+)-(\d{2})-(.+)$"` (case-insensitive) into `(prefix, yy, suffix)`. Looks up `MONTH_PREFIX_ALIASES.get(prefix.upper())` — if found, that's the FIRST fallback candidate: `f"{alias}-{yy}-{suffix}"`. THEN, regardless of whether an alias fallback was found, ALSO adds an upper-cased-exact variant `f"{prefix.upper()}-{yy}-{suffix}"` IF it differs from the original (case-normalization safety net). Both candidates are de-duplicated preserving first-seen order (a `seen: set()` + list comprehension, matching the general order-preservation pattern noted in SHARED.md porting trap #4). If the code doesn't match `BATCH_CODE_RE` at all, returns `[]` (no fallbacks).

**Note the SEPT/SEP asymmetry is preserved verbatim**: a code with prefix `SEP` gets fallback `SEPTEMBER`; a code with prefix `SEPTEMBER` gets fallback `SEPT` (never `SEP`); a code with prefix `SEPT` gets fallback `SEPTEMBER`. This is a dict lookup on the LITERAL string key, so `SEP` and `SEPT` are two DIFFERENT keys both happening to point to the same value (`SEPTEMBER`), but `SEPTEMBER`'s own reverse mapping only points back to ONE of them (`SEPT`, since that's the last key registered for that value in the dict LITERAL as written — dict literals with duplicate VALUES for different KEYS don't create a reverse mapping automatically; the reverse direction `"SEPTEMBER": "SEPT"` is a SEPARATE, independently-authored entry in the same dict literal).

### Wet-recovery sub-rows (RC IN, identical shared core to deliveries.md)

Same `lib.deductions` core, same predicate (`is_recovery_row_dict`), same inheritance builder (`build_recovery_row`). The ONE difference: this extractor tracks `last_mother` across the FORWARD-ONLY grid iteration (`ws.iter_rows(...)` on a `read_only=True` workbook — cannot random-access backward), whereas the email extractor can technically re-access any row (openpyxl's non-read-only mode) but uses the same forward-tracking pattern anyway for consistency.

### RC OUT tab

Real header on ROW 4 (rows 1-3 blank/title). Data rows 5..end. Column map (`RC_OUT_COLS`, extract_gsheet.py:365-369):

| Col | Field |
|---|---|
| A(1) | transaction_date |
| B(2) | production_batch (a MONTH LABEL ONLY, e.g. `"MAY"` — taken VERBATIM, no derivation) |
| C(3) | **batch_code** (critical: lives in column C, labeled "BLOCK" — NOT column B, which is easy to confuse since B is ALSO batch-adjacent-sounding) |
| D(4) | weight_kg |
| E(5) | destination ("PLANT/ETC" — MAIN / SUNDRY, plus typos) |
| F(6) | remarks |
| G(7) | block_loc |
| H(8) | (blank, unused) |
| I(9) | lab_mc |
| J(10) | lab_mc_wtd |
| K(11) | day |
| — | (column L = a DUPLICATE of column B/production_batch info, per the module docstring — NOT separately read by `RC_OUT_COLS`, which stops enumerating at column 11) |

### Destination typo normalization (`DEST_TYPO_FIX`, extract_gsheet.py:108)

`{"MAN": "MAIN", "MIAN": "MAIN"}` — exact uppercase match. Default `"MAIN"` if the cell is blank. If the (typo-corrected) uppercased value is NOT in `VALID_DESTINATIONS = {"MAIN", "SUNDRY"}`, a warning is added but the value is KEPT AS-IS (not coerced to MAIN) — an unrecognized destination flows through verbatim into the row.

### Row skip (RC OUT)

Skipped if `transaction_date is None AND batch_code is None AND weight_kg is None` — same padding-row filter pattern as RC IN.

---

## 3. Classification spec (`classify_gsheet.py`) — LOCKED POLICY, forward-only

### Scope floor (`--since`, default `DEFAULT_SINCE = "2025-01-01"`, LOCKED by Renzo 2026-05-30)

Any Sheet row with `transaction_date < since` is dropped ENTIRELY into `out_of_scope` (a COUNT only, never even reaches MALFORMED/UNMAPPED/etc. — it's the very first check, before the required-field check). The DB's own pre-2025 rows are NEVER matched/updated/deleted by this tool — they simply never appear in the classifier's DB-side index either, since the caller (`_classify_one_mode`) queries `db.read_rows(table, since_date=since, ...)`.

### Natural keys

- **RC IN**: `(transaction_date, resolved_batch_code, norm_block_loc(block_loc), weight_kg)` — with a THREE-TIER fallback matching strategy (exact → aggregation-tolerant → conflict-guardrail), NOT a single flat key lookup. See below.
- **RC OUT**: `(transaction_date, batch_id, destination)` — resolved via `resolve_batch_id` (primary→fallbacks against the batches lookup), same style as `classify_rc_out.py`, PLUS its own conflict-guardrail (weight-based, since RC OUT's block_loc is often empty).

### RC IN — three-tier matching (`classify_rc_in`, lines 275-373)

1. **Exact hit**: `(date, db_matched_code, norm_block_loc, norm_num(weight,3))` found in the `exact` index → route through `_route_changed` (applies the materiality gate, see below).
2. **Aggregation-tolerant fallback**: if no exact hit, look in the `loose` index (`(date, db_matched_code, block_loc)` WITHOUT weight) for candidates within `AGG_TOL_KG = 50.0` kg of the Sheet's weight — picks the CLOSEST-weight candidate. This handles the case where the Sheet logs ONE aggregated per-block row while the DB/email logged SEVERAL per-truck rows (or vice versa) — a legitimate real-world reporting-granularity mismatch, not an error. An `aggregation_note` is attached for transparency but does NOT change the NOOP/CHANGED outcome logic itself (still routed through `_route_changed`, just with an extra note field).
3. **Conflict guardrail** (only reached if 1 and 2 both miss, AND `block_loc is not None`): checks `by_date_block_wt[(date, block_loc, weight)]` for ANY db row with a DIFFERENT `batch_code` at the exact same date+block+weight → this is very likely a batch REASSIGNMENT, not a genuinely new delivery. FLAGGED (`kind: "reassignment_suspected"`), NEVER auto-inserted, NEVER deletes anything.
4. **Genuinely new**: only if all three above miss → `new`, with `batch_code_resolved` set (may differ from `batch_code_primary` if a fallback matched).
5. **Batch never resolves at all** (neither primary nor any fallback exists as an ACTUAL batch_code in the current DB window): → `UNMAPPED`, checked BEFORE any of the 4 steps above (this is really step 0 in code order — `resolve_against_set` is called first, and only if `db_matched_code is not None` does the exact/loose/collision logic even run).

`resolve_against_set(row, code_set)` (lines 194-204): `code_set` = every `batch_code` actually present in the CURRENT DB QUERY WINDOW's rows (not a separate `batches` table lookup — RC IN resolves against `deliveries.batch_code` values seen in-window, whereas RC OUT resolves against a `batches` id lookup fetched separately). Tries primary first, then EACH fallback in list order; first hit wins. Returns `(intended_code, matched_code_or_None)` — the FIRST element is ALWAYS the primary (used as the "intended" code for NEW rows even if unresolved), the second signals whether resolution succeeded.

### RC OUT — conflict guardrail + closest-weight consumption (`classify_rc_out`, lines 410-499)

1. Batch resolution failure → `UNMAPPED`.
2. Natural key `(date, batch_id, destination)` miss → conflict guardrail: `by_date_dest_wt[(date, dest, norm_weight)]` for a DIFFERENT `batch_id` at the same date+dest+weight → FLAGGED `reassignment_suspected`. Else → `NEW`.
3. Natural key HIT (possibly MULTIPLE db rows share the key, since `db_index` is a `list`-valued dict): a `consumed: dict[key, int]` tracker ensures repeat Sheet rows mapping to the SAME key each pair with a DISTINCT (as-yet-unconsumed) DB row where possible — `pool = matches[start:] or matches` (falls back to the FULL match list if the consumed-offset has exhausted it, rather than erroring). Among the pool, picks the row with the SMALLEST absolute weight delta (`best_delta`) — even if that delta is large; there's no "no acceptable match" bail-out here, the closest one is ALWAYS chosen once the key itself matched.
4. Diffs computed via `rc_out_diffs`, routed through `_route_changed`.

### Materiality gate (`is_material`, LOCKED decision #2, lines 158-188) — ONLY for gsheet, NOT for the email classifiers

Given a non-empty `diffs` list, iterate each diff:
- **`sacks` field**: if `sheetValue` is `None` AND `dbValue == 0` (or vice versa) → demoted ("null↔0"), continue to next diff. ELSE (any other sacks mismatch) → the WHOLE row is immediately MATERIAL (`return True, None` — short-circuits, doesn't check remaining diffs).
- **`lab_results` field**: if `_lab_diff_is_immaterial(sheetValue, dbValue)` (SHARED.md §4 for the exact algorithm and the docstring-vs-code discrepancy) → demoted, continue. ELSE → immediately MATERIAL, short-circuits.
- **Any OTHER field** (supplier, truck_plate, remarks, weight_kg, production_batch, block_loc): unconditionally MATERIAL — `return True, None` immediately, no demotion path exists for these fields AT ALL.
- If EVERY diff in the list was demoted → `(False, "immaterial: " + joined skip-reasons)` — this row is NOOP, but with the diff list STILL preserved and an `immaterial_note` attached (transparency — a human reviewing the NOOP bucket can still see what technically differed and why it was skipped).

**Verbatim note**: the materiality check STOPS at the first MATERIAL field it finds (`return True, None` inside the loop, not after) — if a row has BOTH an immaterial `sacks` diff AND a material `remarks` diff, the function never even evaluates whether the `sacks` diff would have been demoted (order-dependent short-circuit, though the end result — MATERIAL — would be the same regardless of iteration order since ANY material field make the whole row material).

### `_route_changed` — the shared NOOP/CHANGED router (lines 383-404), used by BOTH RC IN and RC OUT

```
if not diffs: append to noop (no immaterial_note)
else:
    material, note = is_material(diffs)
    if material: append to changed
    else: append to noop WITH immaterial_note = note
```

### UNMAPPED (both modes)

Never auto-creates a batch. RC IN's UNMAPPED reason string names BOTH the primary and the full fallback list that were tried. RC OUT's likewise.

### MALFORMED

RC IN: missing `transaction_date` OR `weight_kg is None` OR missing `batch_code_primary` (checked via `not ex.get("batch_code_primary")` — a falsy check, so an EMPTY STRING primary would also count as missing, not just `None`). RC OUT: missing `transaction_date`, OR `weight_kg is None or float(weight_kg) == 0` (same "exact zero is malformed" rule as `classify_rc_out.py`).

---

## 4. Gates & reconciliation

### The `>50-NEW` and `confidence<0.7` gates (LIVE HERE — gsheet-specific, in `_apply_from_compact`, lines 317-326)

```python
new_rows = [r for r in actionable["new"] if not r.get("skip")]
if len(new_rows) > 50:
    print(json.dumps({"ok": False, "error": f"Too many NEW rows ({len(new_rows)}) for auto-write. Route to manual triage."}))
    return 1
low_conf = [r for r in new_rows if (r.get("confidence") or 1.0) < 0.7]
if low_conf:
    print(json.dumps({"ok": False, "error": f"{len(low_conf)} NEW rows below confidence 0.7 — manual review required.", "indexes": [...]}))
    return 1
```

**These are HARD gates evaluated INSIDE `_apply_from_compact`, per MODE** (since this function is called once per mode, even under the contract CLI which invokes it twice — once for rc_in, once for rc_out). A run with 51+ genuinely new RC IN rows in one classify pass HALTS the ENTIRE rc_in apply (not just the excess rows) — this is a coarse whole-mode gate, not a per-row filter. **Critical bug to flag verbatim**: `_apply_from_compact` returns the INTEGER `1` (not a dict) on either gate trip (lines 320-321, 324-326: `return 1` after printing) — but its caller `phase_apply_contract` (line 563: `res = _apply_from_compact(compact)`) then calls `res.get("inserted", 0)` etc. on whatever was returned. **Calling `.get()` on an integer `1` would raise `AttributeError` in Python.** This means: **if either gate trips under the CONTRACT CLI path, the orchestrator will CRASH with an unhandled exception, not cleanly report `ok:false`.** The LEGACY CLI path (`phase_apply`, line 472: `print(json.dumps(_apply_from_compact(compact), indent=2))`) has the SAME bug — `json.dumps(1)` would actually succeed (it's valid to serialize a bare int), so the legacy path prints `1` as its entire JSON output rather than a proper envelope, which is different-but-still-broken behavior. **Flag this for a human decision**: this is a genuine, currently-live bug in the Python orchestrator that a TS port must NOT silently replicate byte-for-byte without at least surfacing it — decide whether the port should (a) fix it to return a proper dict/typed-error, or (b) faithfully reproduce the crash for byte-parity testing purposes (unlikely to be desired). Either way, a fixture reproducing exactly 51 NEW rows (or any confidence < 0.7 row) is REQUIRED to exercise this path.

### `L-013` — prior-correction audit-history check (locked policy, described in LEARNING_LEDGER, **NOT implemented in the read code**)

`classify_gsheet.py` has NO code that queries `audit_logs` for a prior Renzo-approved correction before treating a VALUE_CHANGED as Sheet-wins. This check, per the ledger, was applied MANUALLY by the agent during specific historical EXECUTE runs — it is NOT a codified Python rule. **Flag for a human decision**: should this be implemented as an actual pre-apply query (e.g., `SELECT audit_logs WHERE record_id = ? AND comment ILIKE '%Renzo-approved%'`) in the TS port, or does it remain a documented-but-manual judgment call the human reviewer applies before approving? Currently `CODIFIED_RULES` in `sync_gsheet.py:483` LISTS `"L-013"` as if it were codified, but no corresponding logic exists in `_apply_from_compact` or `classify_gsheet.py` — this is a **documentation/reality mismatch** worth flagging on its own.

### `L-018` — apply honors only top-level `skip`, not `decision`

Documented above in §1.2 — this is a REAL, currently-live gap (confirmed by reading `_apply_from_compact`'s `changed` loop, which checks `r.get("skip")` only). `CODIFIED_RULES` also lists `"L-018"` — but the ledger's OWN entry for L-018 describes this as an identified BUG that the agent had to work around manually (by doing approved writes directly via Supabase MCP instead of running `--phase apply` at all), not a fix that landed in the code. **Flag**: does the TS port need to actually FIX this (make apply honor `decision:"skip"` for `changed` items too), or faithfully port the current buggy behavior? Given L-018's severity (it corrupted real data once), this strongly suggests the fix should land in the TS port even if the Python original still has the gap — surface this explicitly rather than deciding silently.

### `sub-watermark guard` — does NOT exist for gsheet (no equivalent of rc_out's `--watermark` flag)

Gsheet has no live watermark table to guard against — its entire model is "re-scan the whole 2025+ window every time, forward-only, Sheet-wins on material diffs." There is no sub-watermark write guard because there's no watermark concept at all beyond the fixed `since` scope floor.

---

## 5. Apply spec

### Write order (`_apply_from_compact`, shared by both CLIs)

1. Gate check (>50 NEW, confidence<0.7) — see above, PER MODE.
2. NEW rows (RC IN): defensive batch upsert (catches `is_location_collision` → `skipped`, not `held` — note gsheet's legacy result shape uses the key `skipped`, NOT `held`, for this concept; the CONTRACT wrapper `phase_apply_contract` RE-MAPS these into the contract envelope's `held` list with `reason:"skipped"`), then `db.insert()` (**PLAIN insert in the Python; the TS port uses `insertIfAbsent` as of 2026-07-27** — see "Idempotency mechanism" below), then `update_trigger_audit_provenance` with a note about the `cost_basis=0` placeholder (L-008) if unenriched.
3. NEW rows (RC OUT): `db.insert()` (also plain in the Python; the TS port uses `insertIfAbsent` — though the R4b cutover skips this mode whole by default), then `insert_manual_audit` (no trigger on rc_out).
4. `changed` rows: skip if `r.get("skip")` (L-018 gap — `decision` is never checked here). Else build `patch` from `diff` entries, EXCLUDING `cost_basis` explicitly (`if f == "cost_basis": continue` — gsheet NEVER writes cost_basis on an update, even if it somehow appeared in a diff list, which itself shouldn't happen since `rc_in_diffs` never emits a cost_basis diff in the first place — belt-and-suspenders). `db.update(...)`. For RC IN: attempts `update_trigger_audit_provenance` first; if it returns `False` (no trigger row found — defensive), falls back to `insert_manual_audit`. For RC OUT: always `insert_manual_audit` (no trigger ever exists for rc_out).
5. `flagged` rows: honors an explicit `decision` field (`"skip"` default, `"insert"` — NOT auto-handled, requires re-running with the row promoted to NEW, `"reassign:<db_id>"` — NOT auto-executed, requires a reviewed manual UPDATE). **This bucket DOES correctly check `decision`** — only the `changed` bucket has the L-018 gap.
6. `unmapped` rows (Python behavior, historical): `decision == "skip"` (default) → skipped with "never auto-create a batch" note; any other decision value → skipped with a note that it requires re-classification with the corrected batch_code (never auto-applied either way). **The TS port INTENTIONALLY diverges here as of 2026-07-11** — see PORTING_DECISIONS.md's "Apply-phase deviations" table: a pattern-valid unknown `batch_code` is now auto-created from the template and the row is written through in the same apply call; a pattern-INVALID code (typo) still follows the Python behavior described above. This is an apply-layer-only change — `classify_gsheet.py`'s `unmapped` bucket is unaffected, so parity stays 12/12.

### Payload field lists

- RC IN INSERT: `transaction_date, supplier, batch_code, block_loc, truck_plate, sacks, weight_kg, cost_basis=0 (ALWAYS, L-008 — gsheet NEVER has a real price to enrich with), remarks, lab_results`. **No `true_weight_kg`/`deduction_note` in the INSERT payload** despite the extractor computing them (`extract_gsheet.py::extract_rc_in` DOES set these fields on every row) — verbatim check of `_apply_from_compact`'s `payload` dict (lines 350-361) confirms these two L-021 fields are OMITTED from the write. **This is a genuine gap**: the deliveries email pipeline DOES write `true_weight_kg`/`deduction_note` on insert (deliveries.md §5), but gsheet's insert payload does not, even though gsheet's OWN extractor computes them. Flag for a human decision — likely an oversight when L-021 was added to `extract_gsheet.py` (per the ledger's "gsheet parity DONE 2026-06-27" note) but the corresponding `sync_gsheet.py`/`_apply_from_compact` write path was never updated to match.
- RC OUT INSERT: `transaction_date, batch_id, destination (default MAIN), weight_kg, remarks, block_loc, production_batch`.

### Audit mechanism

Same dual-RPC pattern as every other pipeline (SHARED.md §2.4) — trigger-stamp for `deliveries`, manual-insert for `rc_out`.

### Idempotency mechanism — the Python's asymmetry, RETIRED in the TS port (2026-07-27)

**Python (the classify oracle, unchanged):** `sync_gsheet.py`'s `_apply_from_compact` uses PLAIN `db.insert()`, NOT `db.insert_if_absent()`, for BOTH `deliveries` and `rc_out` NEW rows (verbatim: lines 362, 386). Idempotency there is enforced entirely UPSTREAM, by the classifier re-querying the DB fresh every classify call and only routing genuinely-absent rows into `new`.

**The TS port INTENTIONALLY diverges as of 2026-07-27** (Renzo, approved — this spec previously flagged the change as "a possible improvement opportunity"; it is now a required one). See PORTING_DECISIONS.md's "Apply-phase deviations" table. `src/reports/gsheet/apply.ts` calls `db.insertIfAbsent()` for both tables, with the SAME natural keys the email writers use:

| Table | Natural key | Shared with |
|---|---|---|
| `deliveries` | `(transaction_date, batch_code, truck_plate, weight_kg, sacks)` | `reports/deliveries/apply.ts` |
| `rc_out` | `(transaction_date, batch_id, destination)` | `reports/rc_out/apply.ts` |

**Why the upstream-only guard was insufficient:** it holds only while gsheet is the SOLE writer of the table — it is not. The email pipelines write `deliveries` too, so the classifier's start-of-run DB snapshot is a time-of-check/time-of-use window, not an authority. A snapshot cannot see a writer that arrives after it was taken. Confirmed incident (BUG-016): 2026-07-15, the email path inserted a C-11B delivery at 01:36:01Z; gsheet, still on its pre-01:36 snapshot, inserted a second identical copy at 03:43:56Z (+24,024 kg phantom inventory on C-11B; app 84,753 vs Sheet 60,729).

**A guard hit is surfaced, never silent:** the row becomes a held row with the email path's existing vocabulary — `reason` and `kind` both `already_exists`, detail `"idempotent skip (natural key already in DB)"`. No new `HeldKind` was invented (that enum is frontend-locked). This is why `ModeApplyResult.skipped[]` carries an optional `reason`.

**Inherited trade-off (deliberate):** the natural key cannot distinguish two genuinely-identical truckloads (`lib/db.ts:13`), so a real second truckload matching all five fields is suppressed — but HELD and re-appliable, not dropped. The email path has always accepted this; the two paths now fail identically, which is the point.

**rc_out is guarded but currently inert:** under the default `SYNC_RCOUT_RECONCILE_CUTOVER=on`, `applyGsheet` skips the rc_out mode WHOLE (R4b), so gsheet never writes `rc_out` today. The guard exists because that flag is a documented one-line revert; with it OFF, gsheet and the PROPOSED writer both target `rc_out` — the identical two-writer race.

### Held-row reasons (contract-CLI mapping, `phase_apply_contract`)

`skipped` (from `_apply_from_compact`'s `skipped` list — covers: location_occupied, agent-set-skip on changed, flagged-left-as-skip, flagged decision=insert/reassign not auto-handled, unmapped left-as-skip or requiring re-classify), `flagged_needs_manual_apply` (from `flagged_resolved` — a `reassign:<id>` decision that was ACKNOWLEDGED but not executed).

### Label + watermark

`labeled` is ALWAYS `False` (Sheet has no Gmail thread). `watermark_updated` — `upsert_ingestion_watermark(db, "gsheet", last_email_id=None)` always attempted if `not errors` (both modes combined — a single watermark upsert covers the whole combined run, not one per mode).

---

## 6. Rule checklist

| Rule | Where | Parity test must assert |
|---|---|---|
| rounding-null-zero-noop | classify_gsheet.py `is_material` (sacks null↔0, lab rounding) | See SHARED.md fixture for `_lab_diff_is_immaterial` exact behavior. |
| sheet-wins-material-value-changed | classify_gsheet.py `_route_changed` + `_apply_from_compact` UPDATE loop | A material VALUE_CHANGED row's Sheet value overwrites the DB value on apply (except `cost_basis`, always excluded). |
| L-004 (RC IN block_loc correction) | **Different mechanism than deliveries.md's L-004** — gsheet's version is folded into the aggregation-tolerant/conflict-guardrail 3-tier matcher (a same date+batch+weight-but-different-block scenario would actually hit the conflict guardrail as `reassignment_suspected`, NOT a distinct `L004_block_loc_correction` kind the way `sync_deliveries.py` has) | Verify a same-date/batch/weight/different-block Sheet row surfaces as FLAGGED `reassignment_suspected`, not silently NEW or silently NOOP. |
| L-008 (cost_basis=0 placeholder) | `_apply_from_compact` line 358 (RC IN insert) | Every gsheet RC IN insert sets `cost_basis=0`, never NULL, never a real derived price. |
| L-013 (prior-correction check) | **NOT codified** — documentation/reality mismatch, see §4 | Flag for human decision; do not assume this exists in code. |
| L-018 (apply ignores `decision` on `changed`) | `_apply_from_compact` `changed` loop, only checks `skip` | Confirm current behavior (bug) with a fixture; flag whether the TS port should fix it. |
| batch_code-fallback-prefixes | extract_gsheet.py `batch_code_fallbacks`, `MONTH_PREFIX_ALIASES` | Exact alias table reproduced verbatim, including the SEPT/SEP asymmetry. |
| never-auto-create-batch (Python; **superseded in TS, 2026-07-11**) | `_apply_from_compact` (only ever upserts the ALREADY-resolved code) | Python: no code path derives a batch_code from scratch. **TS apply.ts now auto-creates a batch for a pattern-valid unmapped code** (`src/lib/batchAutoCreate.ts`) — see PORTING_DECISIONS.md. classify is untouched either way. |
| never-delete | entire file | Grep confirms zero DELETE statements anywhere in `sync_gsheet.py`. |
| 2025-scope-floor | classify_gsheet.py `out_of_scope` check | A Sheet row dated before `since` (default 2025-01-01) is dropped before ANY other classification step. |
| >50-NEW gate | `_apply_from_compact` lines 318-321 | Exactly 51 NEW rows in one mode's apply → immediate halt (with the noted `res.get()`-on-int crash risk under the contract CLI). |
| confidence<0.7 gate | `_apply_from_compact` lines 322-326 | Any NEW row with `confidence < 0.7` → immediate halt of the WHOLE mode's apply, not just that row. |

---

## 7. Fixture shopping list

- A synthetic RC IN Sheet tab reproducing: a normal row, a row using a fallback-prefix batch code (e.g. `SEPT-25-BLK4` when the DB only has `SEPTEMBER-25-BLK4`), an aggregation-mismatch scenario (Sheet has ONE row of 40,000kg where the DB has TWO rows of 20,000kg each on the same date/batch/block — within `AGG_TOL_KG=50`), a conflict-guardrail scenario (Sheet's NEW row lands on the same date+block+weight as a DIFFERENT existing batch), a wet-recovery sub-row.
- A synthetic RC OUT Sheet tab reproducing: a normal row, a destination typo (`"MAN"` → must normalize to `"MAIN"`), an unrecognized destination (must pass through verbatim with a warning), a multiple-DB-rows-per-key scenario (to exercise the `consumed` tracker's distinct-pairing behavior).
- An out-of-scope fixture: a Sheet row dated `2024-12-31` — must be dropped silently into `out_of_scope`, never reaching MALFORMED/UNMAPPED.
- A >50-NEW fixture (51 genuinely new RC IN rows in one classify pass) AND a confidence<0.7 fixture — both to exercise (and document) the `_apply_from_compact` return-type bug under the contract CLI.
- An L-018 fixture: a `changed` item with `"decision":"skip"` but NO top-level `"skip":true` — confirms current (buggy) apply behavior actually WRITES it; the TS port's decision on whether to fix this should be tested either way.
- A `true_weight_kg`/`deduction_note` fixture: an RC IN Sheet row with a parseable deduction remark — confirm the EXTRACT step populates both fields, then confirm (as currently coded) the APPLY step does NOT include them in the INSERT payload (documenting the gap, pending a human decision on whether to fix it).

---

## 8. Porting traps (gsheet-specific)

1. **The `_apply_from_compact` return-type bug** (§4): returns a bare integer `1` on either safety-gate trip, but callers expect a dict. This WILL crash a literal Python-to-TS transliteration under the contract CLI path. Must be explicitly designed around, not silently inherited.
2. **`_route_changed`'s materiality short-circuit** (`is_material`, §3) returns MATERIAL on the FIRST non-demotable field, without evaluating whether OTHER fields in the same diff list would have demoted — functionally inert (since ANY material field makes the row material regardless of order), but a TS port implementing this as a `.every()`/`.some()` chain must get the SAME final answer; do not assume the order of demotion-checks matters for the OUTCOME (it doesn't), only be aware the code's control flow short-circuits.
3. **RC IN's batch resolution set (`code_set`) is built from the CURRENT DB QUERY WINDOW's `deliveries.batch_code` values**, not from the separate `batches` table — this differs from RC OUT's resolution (which DOES hit a separate `batches` lookup). A TS port must NOT unify these into one "resolve against batches table" helper; RC IN specifically resolves against what's ALREADY IN `deliveries` within the window, RC OUT resolves against the full `batches` registry.
4. ~~**Idempotency is intentionally NOT enforced at insert time**~~ — **RESOLVED 2026-07-27.** The explicit human decision this trap asked for was made (Renzo) after the asymmetry caused a real duplicate (BUG-016). The Python still uses plain `db.insert()`; the **TS port now uses `insertIfAbsent`** with the email writers' natural keys. See "Idempotency mechanism" in §5 above. Porters: do NOT "restore parity" here by reverting to a plain insert — the divergence is deliberate and registered in PORTING_DECISIONS.md.
5. **`true_weight_kg`/`deduction_note` are computed by the extractor but dropped by the apply payload** — a real, silent functionality gap versus the deliveries (email) pipeline. Flag, don't silently fix.
6. **`SEPT`/`SEP` both alias to `SEPTEMBER`, but `SEPTEMBER` only aliases back to `SEPT`** — an asymmetric, non-bijective mapping. A TS port must replicate the EXACT dict literal, not "fix" it into a clean bijection, since existing DB batch_codes may specifically rely on the current (odd) mapping surviving unchanged.
7. **The Sheet's row-4 RC OUT header and row-7 RC IN header are FIXED positions, never dynamically searched** (unlike the email deliveries extractor's `find_header_row` scan) — if the Sheet's structure ever shifts (a row inserted above the data), this extractor would silently misread everything with no error. A TS port could optionally add a defensive header-position check (à la flecon's `locate_header_block` hard-error), but doing so changes behavior from a silent-misread to a hard failure — flag as a possible enhancement, not a strict parity requirement, since the CURRENT Python code has no such check at all.
