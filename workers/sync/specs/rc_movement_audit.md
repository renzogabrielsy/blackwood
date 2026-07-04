# rc_movement_audit.md — RC MOVEMENT read-only auditor

Scripts: `extract_rc_movement.py` (242 lines, ALSO used by rc_out.md's GATE 1/2 — this is the
single shared extractor), `reconcile_rc_movement.py` (210 lines, shared with rc_out.md),
`audit_rc_movement.py` (179 lines, the orchestrator — CLASSIFY-ONLY, no apply phase, never
writes, never labels Gmail).

Read SHARED.md first. This report type NEVER writes to the DB and NEVER touches Gmail labels —
it is a pure watchdog. Do not port a write/apply phase for it.

---

## 1. Pipeline narrative (`audit_rc_movement.py`)

1. **Watermark**: `watermark = data_watermark(db, "rc_out")` — note this auditor reads the `rc_out` table's watermark (not its own table; it has no table).
2. **Audit window** (audit_rc_movement.py:68-73): if `--since` explicitly given, use it. Else if a watermark exists, `since = watermark - 30 days` (a WIDER lookback than the writer pipelines' `-3 day` tail — "the auditor looks back further than a writer", per the module docstring). Else `"2025-01-01"`.
3. **Fetch RC MOVEMENT**: `subject:"RC MOVEMENT" newer_than:7d -in:sent` (GMAIL_QUERY, audit_rc_movement.py:47) — identical query string to rc_out's cross-check fetch, fixed 7-day window regardless of the audit `since`. If no xlsx found → early-return `ok:true`, `note`.
4. **Extract**: `extract_rc_movement.py --file {xlsx} --all-sheets`.
5. **Compute `rc_out` daily sums**: `_rc_out_sums(db, since)` — reads ALL `rc_out` rows with `transaction_date >= since`, groups+sums `weight_kg` by date (audit_rc_movement.py:50-59). IDENTICAL logic to `sync_rc_out.py::_rc_out_sums` (duplicated code, not shared — a TS port MAY unify this into one function since both are byte-identical).
6. **Build a synthetic "proposed" file FROM rc_out sums**: `{"rows": [{"transaction_date": d, "weight_kg": v} for d, v in sums.items()]}` (audit_rc_movement.py:104-106) — this is the auditor's trick to reuse `reconcile_rc_movement.py` unmodified: by feeding rc_out's own sums AS IF they were "PROPOSED" data, the reconciler's "P vs M" comparison becomes "rc_out vs RC MOVEMENT", which is exactly the cross-check this auditor wants (comparing the DB's actual recorded consumption against the independent movement-sheet total).
7. **Reconcile**: runs `reconcile_rc_movement.py --proposed-json {synthetic} --movement-json {extract} --rc-out-sums-json {sums} --output {report}` — passing rc_out sums as BOTH the "proposed" input AND the `--rc-out-sums-json` flag (feeding the same data twice, once reframed as "proposed" and once as the literal DB-duplication-gate input) — this double-feed means BOTH the P-vs-M comparison and the O-vs-M duplication-gate comparison inside the reconciler are actually comparing the SAME rc_out-derived numbers against RC MOVEMENT, just via two different code paths in the shared reconciler. In practice this means `p_vs_m_drift` and `o_vs_m_excess` will be IDENTICAL for every date in this auditor's report (since `P == O` by construction — both are `rc_out_sums[d]`).
8. **Severity mapping**: `severity = reconcile_process.returncode` (0/1/2, read directly from the subprocess exit code, not re-parsed from JSON). `ok = severity < 2`.

### No apply phase

`main()` (audit_rc_movement.py:161-176) only accepts `--phase classify` (via `choices=["classify"]` in argparse — passing any other value is an argparse error before the script's own logic even runs). If somehow reached with `phase != "classify"`, emits `{"ok": false, "gate_failures": [{"gate":"read_only", "detail":"audit_rc_movement has no apply phase — it never writes."}]}` and returns exit code 2. **A TS port must not add a write path to this report type — replicate the classify-only shape exactly, including the hard-coded argparse restriction.**

---

## 2. Extraction spec (`extract_rc_movement.py`)

This is the SAME extractor rc_out.md's GATE 1/2 use — documented once here, cross-referenced from rc_out.md.

### Sheet anatomy

One sheet per MONTH (e.g. `"MAY 2026"`). Header rows R1-R5 (title + multi-row header). Data starts at `header_row + 3`.

### Header detection

`header_row` = the first row (scanned 1..9) whose column A value, stripped and uppercased, equals exactly `"DATE"` (extract_rc_movement.py:115-123). If none found, the sheet is skipped entirely with a warning `"no DATE header row found"` — returns `([], [warning])`.

### Column headers

`build_column_headers(ws, [header_row, header_row+1, header_row+2])` (lines 95-106): for each of those 3 rows, for every column, collect the non-empty stripped string value; join all collected values PER COLUMN with a space, across the 3 header rows in order — producing one combined label string per column index (used only for the `product_breakdown` dict keys, not for any structural decision).

### Row extraction / section-break detection

Data rows start at `header_row + 3`. For each row, column A is checked: if it's a string AND its stripped-uppercased value is one of `{"SUPPLIERS", "REMARKS:", "REMARKS", "NOTES", "TOTAL", "TOTALS"}` → **STOP entirely** (`break`, not `continue` — no further rows on this sheet are read past this point). Otherwise, if column A doesn't parse as a date, the row is silently skipped (`continue`, not a section break) — this allows blank/spacer rows between dates without terminating the scan.

For each row with a valid date: `fed_kls = coerce_float(col(2))`. If `None` → warning `"date {d} present but RAW CHARCOAL FED is empty"`, row skipped (not emitted). If `fed_kls < 0 or fed_kls > 200_000` → warning only, still emitted.

### `product_breakdown` (informational, not used by any gate)

For columns 3..max_column: any non-null, non-zero float value is captured keyed by its combined header label (or `f"col_{c}"` if no header text was found for that column). Zero and null values are dropped entirely (not even represented as `0`).

### `date_to_fed_kls` — the cross-tab summing fix (L-022)

```python
date_index: dict[str, float] = {}
for r in all_rows:
    _d = r["transaction_date"]
    date_index[_d] = round(date_index.get(_d, 0.0) + r["raw_charcoal_fed_kls"], 2)
```
(extract_rc_movement.py:219-222) — **SUMS across every row with that date, across ALL processed sheets/tabs, rather than overwriting.** This is the L-022 fix: a boundary date (e.g. May 29) legitimately appears on BOTH the "MAY 2026" tab (as the month's last day) and the "JUNE 2026" tab (as a carryover/opening reference) with DIFFERENT `raw_charcoal_fed_kls` values for each tab's portion — summing produces the true combined fed total for that date. **Verbatim rule: `date_to_fed_kls[d] = round(sum of raw_charcoal_fed_kls across every row sharing date d, across all sheets processed this run), 2 dp)`.** A TS port MUST use a running-sum accumulator keyed by date string, NOT a dict/object literal assignment that would silently overwrite on a duplicate key.

### Units / rounding

`raw_charcoal_fed_kls` per row is whatever `coerce_float` returns (no rounding at the row level). The AGGREGATE `date_to_fed_kls` value IS rounded to 2dp on every accumulation step (rounds the running total each time a new row is added, not just once at the end — for a 2-row date this means round(round(a+b,2)) effectively, though rounding twice at 2dp is idempotent so no practical difference from rounding once at the end).

---

## 3. Reconciliation spec (`reconcile_rc_movement.py`) — full spec, shared with rc_out.md

### Inputs

- `--proposed-json`: any object with a `"rows"` array of `{transaction_date, weight_kg | day_total_kg}`.
- `--movement-json`: the `extract_rc_movement.py` output (reads `.date_to_fed_kls`).
- `--rc-out-sums-json` (optional): `{date: float}` OR `[{transaction_date|date, total_kg|sum|weight_kg}]`, auto-unwrapped from a `json_agg`-style `[{"data":[...]}]` wrapper if present.

### Per-date computation

`P = round(sum(proposed weight for that date), 2)` if the date appears in `proposed_by_date`, else `None`. `M = movement_date_to_fed.get(d)` (`None` if absent). `O = rc_out_sums.get(d)` (`None` if absent).

- **`p_vs_m_drift`**: only computed if `P is not None`. If `M is None` → note `"No RC MOVEMENT entry for this date"`, `p_vs_m_drift` stays `None`. Else `p_vs_m_drift = round(P - M, 2)`; `abs > serious_drift_kg` → SERIOUS note + `max_severity=max(...,2)`; `abs > tolerance_kg` (but not serious) → tolerable-drift note + `max_severity=max(...,1)`.
- **`p_vs_o_drift`**: only computed if BOTH `P is not None` and `O is not None`. Same severity thresholds as above, independently.
- **`o_vs_m_excess`** (THE DUPLICATION GATE): only computed if BOTH `O is not None` and `M is not None`. `o_vs_m_excess = round(O - M, 2)`. `> serious_drift_kg` → SERIOUS DB-side duplication note + `max_severity=max(...,2)`. `> tolerance_kg` (not serious) → "possible partial duplication" note + `max_severity=max(...,1)`. **Only a POSITIVE excess triggers anything — `o_vs_m_excess` below zero (O < M) is completely silent, no note, no severity bump, by design** (the "daily kg drift is expected" rule — the feed tank empties over time, so O lagging M is normal).

### Date universe walked

`all_dates = sorted(set(proposed_by_date.keys()) | set(rc_out_sums.keys()))` — union of PROPOSED dates and rc_out-sum dates, EXCLUDING dates that only exist in the RC MOVEMENT file with no PROPOSED/rc_out counterpart at all (a movement-only date is invisible to this walk entirely — never flagged as "missing PROPOSED data" from the movement side).

### Output shape

`{summary: {total_dates, proposed_dates, db_dates_checked, ok_dates, drift_dates, max_severity: "none"|"warning"|"serious", tolerance_kg, serious_drift_kg}, drift_dates: [...], ok_dates: [...]}`. Exit code = the numeric severity (0/1/2).

---

## 4. Gates & reconciliation (for THIS auditor specifically)

- The auditor's OWN `ok` = `severity < 2` — a "serious" reconcile result sets `ok:false` in the classify envelope, with `gate_failures = [{"gate":"rc_movement_serious_drift", "detail": "{N} drift date(s); max_severity=serious"}]`.
- **This is informational-only in the sense that there is no apply phase to halt** — `ok:false` here simply tells the calling UI/human "something's off", it does not block any write (since this auditor never writes anything, by construction).
- Severity 1 ("warning") still surfaces `drift` entries in `rows_preview` but keeps `ok:true`.

---

## 5. Apply spec

**N/A — no apply phase exists.** Do not implement one. The CLI's `--phase` argument only accepts `"classify"`.

---

## 6. Rule checklist

| Rule | Where | Parity test must assert |
|---|---|---|
| reconcile-drift-math | reconcile_rc_movement.py (shared) | Exact severity thresholds (`tolerance_kg=50` default, `serious_drift_kg=500` default — note `audit_rc_movement.py` does NOT override these via CLI args the way `sync_rc_out.py` explicitly passes `50`/`500`; it relies on the reconciler's own argparse defaults, which happen to be the same values) reproduce the documented severity classification. |
| L-019 (duplication signature) | reconcile_rc_movement.py `o_vs_m_excess` logic | `O > M` by more than tolerance → flagged; `O < M` → silent, never flagged. |
| L-024 (cross-month-boundary false-positive on a settled date) | **NOT codified in this auditor** — the "surface, don't auto-halt" nuance from L-024 was a manual rc-out-manager judgment call, not implemented in `audit_rc_movement.py`'s severity logic. This auditor will report ANY serious drift the same way regardless of how old/settled the date is. Flag for a human decision: should the TS port add an "is this date well outside the current window" softening the way L-024 describes for rc-out-manager, or leave this auditor's severity purely mechanical? |
| never writes / never labels | audit_rc_movement.py main() | Confirm the TS port's CLI literally rejects any phase other than classify, and the module has zero calls to any DB-write helper or Gmail-label helper. |

---

## 7. Fixture shopping list

- A movement file with a genuine cross-month-boundary date split across two tabs (reuse the same fixture rc_out.md needs for L-022, since it's the identical extractor).
- A `rc_out` sums fixture reproducing a REAL historical duplication (O > M by >500kg) to confirm severity=serious end-to-end through THIS auditor's synthetic-proposed-from-rc_out-sums trick.
- A fixture where RC MOVEMENT has a date with NO matching `rc_out` sum and NO PROPOSED — confirm it's invisible to `all_dates` (never appears in either `drift_dates` or `ok_dates`).
- A no-RC-MOVEMENT-email-found fixture — confirm the clean early-return shape (`ok:true`, `note`, empty `classified_path`).

---

## 8. Porting traps (rc_movement_audit-specific)

- The "synthetic proposed built from rc_out sums" trick (audit_rc_movement.py:104-106) means a TS port's reconciler call for THIS report type is feeding the SAME numeric series into what the shared reconciler treats as two conceptually different inputs (`proposed` and `rc_out_sums`). A literal TS port must replicate this exact double-feed, not "simplify" it by skipping the P-vs-M computation, because a downstream consumer (or a future extension of this auditor) may still read the `drift_p_vs_m_kg` field from the report and expect it to equal `drift_p_vs_o_kg` (both computed from `O` here).
- `audit_rc_movement.py`'s `--since` computation reads `data_watermark(db, "rc_out")` — a table this specific script never writes to. A TS port that tries to give this auditor "its own" watermark table would diverge from the intended behavior (it deliberately piggybacks on rc_out's watermark, since that's what it's auditing).
- `severity = rc.returncode` is read from the subprocess exit code directly (not from the JSON report's `summary.max_severity` string) — a TS port spawning the reconciler logic as an in-process function call (rather than a subprocess) must return/propagate the equivalent integer severity code, not just the string, if any downstream code depends on the exact 0/1/2 integer.
