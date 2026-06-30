#!/usr/bin/env python3
"""
Classify extracted PRODUCTION RUN rows against existing production_runs rows.

Parent-child shift model (PRODUCTION_DESIGN.md §3, §6):
  production_shifts is the PARENT  — natural key (transaction_date, production_batch, shift)
  production_runs   is a CHILD     — natural key (shift_id, customer, grade); N:1 with shifts

Because production_runs no longer stores date/batch/shift, this classifier must first
resolve each extracted row's (transaction_date, production_batch, shift) triplet to an
existing shift_id via --shifts-json. The row's natural key is then (shift_id, customer, grade).

Outcomes per extracted run (mirrors classify_rc_out.py vocabulary):
  - NEW              : natural key not present among DB rows -> queue for INSERT.
                       May carry needs_shift_upsert=true when the parent shift does not yet exist.
  - VALUE_CHANGED    : same natural key in DB, >=1 comparable field differs -> include diff + existing_id.
  - DUPLICATE_NOOP   : same natural key in DB, all comparable fields equal (tolerance 0.01) -> skip.
  - MALFORMED        : missing/invalid required field -> NEVER written. For runs:
                         * ttl_kg not a non-negative number (WEIGHT guard — still holds)
                         * grade not in {3X50, 6X50, 8X50, 2X6, 4X8}
                         * shift null/empty (DEFENSIVE only — see below)

  Shift note (L-025): a blank/absent/unrecognized column-H shift is NO LONGER a
  MALFORMED reason. extract_daily_production.py now DEFAULTS such a run to Morning
  ('M') and flags it `_shift_defaulted=true` with a strippable remarks note, so
  extractor output never carries a null shift. The null/empty-shift MALFORMED gate
  below is kept purely as a defensive guard against malformed external input; the
  WEIGHT guard (ttl_kg) is unaffected — a weightless row still HOLDs even with a
  defaulted shift.

Natural key = shift_id + customer + grade. customer/grade ARE the key (within a shift), so
the compared (non-key) fields are: ttl_kg, sacks_bags, remarks. The SHIFT_DEFAULT_NOTE
marker is stripped from email-side remarks before diffing (additive/write-only; L-025).
The `_shift_defaulted` flag is informational only — never a key or compared field.

Shift resolution:
  Build a map (transaction_date, production_batch.strip().upper(), shift.strip().upper()) -> shift_id
  from --shifts-json. For each extracted row:
    * shift null/empty                 -> MALFORMED (defensive; extractor defaults to 'M' so this is unreachable for its output)
    * triplet found in map             -> resolved_shift_id set, needs_shift_upsert=false
    * triplet NOT found                -> resolved_shift_id=null, needs_shift_upsert=true
                                          (agent upserts the parent shift first, then inserts this child)

Usage:
    python3 classify_production_runs.py \\
        --extract-json /tmp/.../out_mc.json \\
        --db-rows-json /tmp/.../production_runs_rows.json \\
        --shifts-json  /tmp/.../production_shifts.json \\
        --output       /tmp/.../classified_production_runs.json \\
        [--verbose]

--extract-json : the MC extractor output; its "runs" array is read.
--db-rows-json : array of existing production_runs child rows in the date window, DENORMALIZED —
                 the agent JOINs each child to its parent shift, so every DB row carries
                 transaction_date, production_batch, shift (the parent triplet) PLUS the child's
                 own fields and id and shift_id. Expected shape per row:
                   {id, shift_id, transaction_date, production_batch, shift,
                    customer, grade, ttl_kg, sacks_bags, remarks}
--shifts-json  : array of ALL existing production_shifts in the window:
                   [{id, transaction_date, production_batch, shift}]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

VALID_GRADES = {"3X50", "6X50", "8X50", "2X6", "4X8"}  # 4X8 added 2026-06-30 (L-027) — keep in lockstep with extractor + DB CHECK
NUM_TOLERANCE = 0.01

# Marker the extractor appends to a run's `remarks` when its shift was DEFAULTED
# to Morning (column H blank/absent/unrecognized — L-025). It is an additive,
# write-only annotation: a row already written to the DB as Morning BEFORE this
# feature has no note, so we strip this exact marker off the EMAIL-side remarks
# before diffing. Without this, every previously-written defaulted row would
# resurface as a perpetual VALUE_CHANGED (db remarks=None vs email remarks=note).
# This mirrors the L-021 additive-field exclusion (true_weight_kg/deduction_note).
#
# MUST stay byte-identical to SHIFT_DEFAULT_NOTE in extract_daily_production.py —
# keep the two constants in sync.
SHIFT_DEFAULT_NOTE = "shift defaulted to Morning (operator left blank)"


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
def norm_str(s: Any) -> str | None:
    """Trim + lowercase; null and empty string collapse to None."""
    if s is None:
        return None
    s = str(s).strip()
    return s.lower() if s else None


def norm_key_part(s: Any) -> str | None:
    """Trim + uppercase for natural-key components (production_batch, shift, customer, grade)."""
    if s is None:
        return None
    s = str(s).strip()
    return s.upper() if s else None


def norm_num(v: Any, places: int = 2) -> float | None:
    if v is None:
        return None
    try:
        return round(float(v), places)
    except (TypeError, ValueError):
        return None


def nums_equal(a: Any, b: Any) -> bool:
    na, nb = norm_num(a), norm_num(b)
    if na is None and nb is None:
        return True
    if na is None or nb is None:
        return False
    return abs(na - nb) <= NUM_TOLERANCE


def strip_shift_default_note(s: Any) -> Any:
    """
    Remove the additive SHIFT_DEFAULT_NOTE marker from a remarks string so the
    note never causes a false VALUE_CHANGED against a DB row that lacks it (L-025;
    mirrors the L-021 additive-field exclusion). Handles both shapes the extractor
    can produce: a standalone note (-> '' -> None after norm) and an appended note
    (' | <note>' trimmed off, leaving the original remarks). Non-strings and rows
    without the marker pass through untouched.
    """
    if s is None or not isinstance(s, str):
        return s
    if SHIFT_DEFAULT_NOTE not in s:
        return s
    # Drop the marker plus an optional ' | ' separator on either side.
    out = s.replace(f" | {SHIFT_DEFAULT_NOTE}", "")
    out = out.replace(f"{SHIFT_DEFAULT_NOTE} | ", "")
    out = out.replace(SHIFT_DEFAULT_NOTE, "")
    return out


# ---------------------------------------------------------------------------
# Shift resolution
# ---------------------------------------------------------------------------
def build_shift_map(shifts: list[dict]) -> dict[tuple, str]:
    """(transaction_date, production_batch^, shift^) -> shift_id."""
    m: dict[tuple, str] = {}
    for s in shifts:
        key = (
            s.get("transaction_date"),
            norm_key_part(s.get("production_batch")),
            norm_key_part(s.get("shift")),
        )
        if s.get("id") is not None:
            m[key] = s["id"]
    return m


# ---------------------------------------------------------------------------
# Field comparison (non-key fields only)
# ---------------------------------------------------------------------------
def field_diff(email_row: dict, db_row: dict) -> dict[str, dict]:
    """Return {field: {db, email}} for each differing comparable field.

    NOTE: the additive SHIFT_DEFAULT_NOTE marker is stripped off the email-side
    `remarks` before comparison (L-025) — it is a write-only annotation, so a row
    already written as Morning (DB remarks=None) must not perpetually re-diff just
    because the email now carries the note. The `_shift_defaulted` flag is never
    compared or part of any key.
    """
    diff: dict[str, dict] = {}

    if not nums_equal(email_row.get("ttl_kg"), db_row.get("ttl_kg")):
        diff["ttl_kg"] = {"db": norm_num(db_row.get("ttl_kg")), "email": norm_num(email_row.get("ttl_kg"))}

    if not nums_equal(email_row.get("sacks_bags"), db_row.get("sacks_bags")):
        diff["sacks_bags"] = {
            "db": norm_num(db_row.get("sacks_bags")),
            "email": norm_num(email_row.get("sacks_bags")),
        }

    email_remarks = strip_shift_default_note(email_row.get("remarks"))
    if norm_str(email_remarks) != norm_str(db_row.get("remarks")):
        diff["remarks"] = {"db": db_row.get("remarks"), "email": email_row.get("remarks")}

    return diff


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="Classify extracted runs against production_runs.")
    parser.add_argument("--extract-json", required=True, help="MC extractor output (reads 'runs').")
    parser.add_argument("--db-rows-json", required=True,
                        help="Denormalized production_runs rows (child JOINed to parent shift).")
    parser.add_argument("--shifts-json", required=True,
                        help="All production_shifts in window: [{id, transaction_date, production_batch, shift}].")
    parser.add_argument("--output", required=True)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    extract_path = Path(args.extract_json).expanduser()
    db_path = Path(args.db_rows_json).expanduser()
    shifts_path = Path(args.shifts_json).expanduser()
    output_path = Path(args.output).expanduser()

    for label, p in [("extract", extract_path), ("db_rows", db_path), ("shifts", shifts_path)]:
        if not p.exists():
            print(json.dumps({"error": f"{label} file not found: {p}"}), file=sys.stderr)
            return 1

    extracted_data = json.loads(extract_path.read_text())
    db_rows = json.loads(db_path.read_text())
    shifts = json.loads(shifts_path.read_text())

    # Unwrap {"data": [...]} from json_agg if present.
    if isinstance(db_rows, list) and len(db_rows) == 1 and isinstance(db_rows[0], dict) and "data" in db_rows[0]:
        db_rows = db_rows[0]["data"] or []
    if isinstance(shifts, list) and len(shifts) == 1 and isinstance(shifts[0], dict) and "data" in shifts[0]:
        shifts = shifts[0]["data"] or []

    extracted_rows = extracted_data.get("runs", []) if isinstance(extracted_data, dict) else extracted_data

    shift_map = build_shift_map(shifts)

    # Index DB child rows by natural key (shift_id, customer^, grade^).
    db_index: dict[tuple, dict] = {}
    for db_row in db_rows:
        key = (db_row.get("shift_id"), norm_key_part(db_row.get("customer")), norm_key_part(db_row.get("grade")))
        db_index[key] = db_row

    classifications: list[dict] = []
    counts = {"new": 0, "value_changed": 0, "duplicate_noop": 0, "malformed": 0, "needs_shift_upsert": 0}

    for idx, ex in enumerate(extracted_rows):
        reasons: list[str] = []

        # --- MALFORMED gates ---
        # DEFENSIVE only (L-025): the extractor now defaults a blank/absent/
        # unrecognized column-H shift to Morning, so its output never reaches this
        # branch. Kept to hold genuinely malformed external input (a null shift it
        # didn't produce). The WEIGHT/grade guards below are the live gates.
        raw_shift = ex.get("shift")
        if raw_shift is None or str(raw_shift).strip() == "":
            classifications.append({
                "idx": idx, "class": "MALFORMED",
                "natural_key": {"shift_id": None, "customer": ex.get("customer"), "grade": ex.get("grade")},
                "resolved_shift_id": None, "needs_shift_upsert": False, "existing_id": None, "diff": None,
                "record": ex, "reasons": ["missing shift; cannot key to production_shifts"], "confidence": 1.0,
            })
            counts["malformed"] += 1
            continue

        grade = norm_key_part(ex.get("grade"))
        if grade not in VALID_GRADES:
            reasons.append(f"grade '{ex.get('grade')}' not in {sorted(VALID_GRADES)}")
        if norm_num(ex.get("ttl_kg")) is None or norm_num(ex.get("ttl_kg")) < 0:
            reasons.append("ttl_kg not a non-negative number")
        if reasons:
            classifications.append({
                "idx": idx, "class": "MALFORMED",
                "natural_key": {"shift_id": None, "customer": ex.get("customer"), "grade": ex.get("grade")},
                "resolved_shift_id": None, "needs_shift_upsert": False, "existing_id": None, "diff": None,
                "record": ex, "reasons": reasons, "confidence": 1.0,
            })
            counts["malformed"] += 1
            continue

        # --- shift resolution ---
        shift = norm_key_part(raw_shift)
        triplet = (ex.get("transaction_date"), norm_key_part(ex.get("production_batch")), shift)
        resolved_shift_id = shift_map.get(triplet)
        needs_shift_upsert = resolved_shift_id is None
        customer = norm_key_part(ex.get("customer")) or "CEBU"
        natural_key = {"shift_id": resolved_shift_id, "customer": customer, "grade": grade}

        if needs_shift_upsert:
            counts["needs_shift_upsert"] += 1

        # If the parent shift doesn't exist, no child can exist either -> NEW.
        if needs_shift_upsert:
            classifications.append({
                "idx": idx, "class": "NEW", "natural_key": natural_key,
                "resolved_shift_id": None, "needs_shift_upsert": True, "existing_id": None, "diff": None,
                "record": ex, "reasons": ["parent shift absent; upsert shift then insert run"], "confidence": 0.95,
            })
            counts["new"] += 1
            continue

        # Parent shift exists -> look up the child by natural key.
        db_row = db_index.get((resolved_shift_id, customer, grade))
        if db_row is None:
            classifications.append({
                "idx": idx, "class": "NEW", "natural_key": natural_key,
                "resolved_shift_id": resolved_shift_id, "needs_shift_upsert": False, "existing_id": None, "diff": None,
                "record": ex, "reasons": ["shift exists; no run for this customer+grade"], "confidence": 0.97,
            })
            counts["new"] += 1
            continue

        diff = field_diff(ex, db_row)
        if diff:
            classifications.append({
                "idx": idx, "class": "VALUE_CHANGED", "natural_key": natural_key,
                "resolved_shift_id": resolved_shift_id, "needs_shift_upsert": False,
                "existing_id": db_row.get("id"), "diff": diff,
                "record": ex, "reasons": [f"{len(diff)} field(s) differ: {', '.join(sorted(diff))}"],
                "confidence": 0.9,
            })
            counts["value_changed"] += 1
        else:
            classifications.append({
                "idx": idx, "class": "DUPLICATE_NOOP", "natural_key": natural_key,
                "resolved_shift_id": resolved_shift_id, "needs_shift_upsert": False,
                "existing_id": db_row.get("id"), "diff": None,
                "record": ex, "reasons": ["natural key present; all comparable fields equal"], "confidence": 0.99,
            })
            counts["duplicate_noop"] += 1

    result = {
        "table": "production_runs",
        "classifications": classifications,
        "summary": {
            "new": counts["new"],
            "value_changed": counts["value_changed"],
            "duplicate_noop": counts["duplicate_noop"],
            "malformed": counts["malformed"],
            "needs_shift_upsert": counts["needs_shift_upsert"],
        },
    }
    output_path.write_text(json.dumps(result, indent=2, default=str))

    if args.verbose:
        print("=== production_runs Classification Summary ===", file=sys.stderr)
        for k, v in result["summary"].items():
            print(f"  {k}: {v}", file=sys.stderr)

    print(json.dumps({"ok": True, "summary": result["summary"], "output_path": str(output_path)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
