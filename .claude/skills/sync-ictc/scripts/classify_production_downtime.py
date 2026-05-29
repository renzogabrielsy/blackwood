#!/usr/bin/env python3
"""
Classify extracted PRODUCTION DOWNTIME rows against existing production_downtime rows.

Parent-child shift model (PRODUCTION_DESIGN.md §3, §6):
  production_shifts   is the PARENT  — natural key (transaction_date, production_batch, shift)
  production_downtime is a CHILD     — natural key (shift_id); UNIQUE(shift_id) => exactly 1 per shift

Because production_downtime no longer stores date/batch/shift, this classifier first resolves
each extracted row's (transaction_date, production_batch, shift) triplet to an existing shift_id
via --shifts-json. The row's natural key is then (shift_id,) alone.

Outcomes per extracted downtime row (mirrors classify_rc_out.py vocabulary):
  - NEW              : no downtime row for that shift_id -> queue for INSERT.
                       May carry needs_shift_upsert=true when the parent shift does not yet exist.
  - VALUE_CHANGED    : a downtime row exists for that shift_id, >=1 comparable field differs
                       -> include diff + existing_id.
  - DUPLICATE_NOOP   : a downtime row exists for that shift_id, all comparable fields equal
                       (numeric tolerance 0.01) -> skip.
  - MALFORMED        : missing/invalid required field -> NEVER written. For downtime:
                         * shift null/empty (cannot key to production_shifts)
                         * shift_hrs <= 0

Natural key = shift_id only. The compared fields are: shift_hrs, dt_hrs, dt_mins, dt_reason, remarks.

Shift resolution:
  Build a map (transaction_date, production_batch.strip().upper(), shift.strip().upper()) -> shift_id
  from --shifts-json. For each extracted row:
    * shift null/empty                 -> MALFORMED ("missing shift; cannot key to production_shifts")
    * triplet found in map             -> resolved_shift_id set, needs_shift_upsert=false
    * triplet NOT found                -> resolved_shift_id=null, needs_shift_upsert=true
                                          (agent upserts the parent shift first, then inserts this child)

Usage:
    python3 classify_production_downtime.py \\
        --extract-json /tmp/.../out_mc.json \\
        --db-rows-json /tmp/.../production_downtime_rows.json \\
        --shifts-json  /tmp/.../production_shifts.json \\
        --output       /tmp/.../classified_production_downtime.json \\
        [--verbose]

--extract-json : the MC extractor output; its "downtime" array is read.
--db-rows-json : array of existing production_downtime child rows in the date window, DENORMALIZED —
                 the agent JOINs each child to its parent shift, so every DB row carries
                 transaction_date, production_batch, shift (the parent triplet) PLUS the child's
                 own fields and id and shift_id. Expected shape per row:
                   {id, shift_id, transaction_date, production_batch, shift,
                    shift_hrs, dt_hrs, dt_mins, dt_reason, remarks}
--shifts-json  : array of ALL existing production_shifts in the window:
                   [{id, transaction_date, production_batch, shift}]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

NUM_TOLERANCE = 0.01


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
    """Trim + uppercase for natural-key components (production_batch, shift)."""
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
# Field comparison (non-key fields)
# ---------------------------------------------------------------------------
def field_diff(email_row: dict, db_row: dict) -> dict[str, dict]:
    """Return {field: {db, email}} for each differing comparable field."""
    diff: dict[str, dict] = {}

    for f in ("shift_hrs", "dt_hrs", "dt_mins"):
        if not nums_equal(email_row.get(f), db_row.get(f)):
            diff[f] = {"db": norm_num(db_row.get(f)), "email": norm_num(email_row.get(f))}

    for f in ("dt_reason", "remarks"):
        if norm_str(email_row.get(f)) != norm_str(db_row.get(f)):
            diff[f] = {"db": db_row.get(f), "email": email_row.get(f)}

    return diff


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="Classify extracted downtime against production_downtime.")
    parser.add_argument("--extract-json", required=True, help="MC extractor output (reads 'downtime').")
    parser.add_argument("--db-rows-json", required=True,
                        help="Denormalized production_downtime rows (child JOINed to parent shift).")
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

    extracted_rows = extracted_data.get("downtime", []) if isinstance(extracted_data, dict) else extracted_data

    shift_map = build_shift_map(shifts)

    # Index DB child rows by natural key (shift_id,).
    db_index: dict[Any, dict] = {}
    for db_row in db_rows:
        db_index[db_row.get("shift_id")] = db_row

    classifications: list[dict] = []
    counts = {"new": 0, "value_changed": 0, "duplicate_noop": 0, "malformed": 0, "needs_shift_upsert": 0}

    for idx, ex in enumerate(extracted_rows):
        reasons: list[str] = []

        # --- MALFORMED gates ---
        raw_shift = ex.get("shift")
        if raw_shift is None or str(raw_shift).strip() == "":
            classifications.append({
                "idx": idx, "class": "MALFORMED", "natural_key": {"shift_id": None},
                "resolved_shift_id": None, "needs_shift_upsert": False, "existing_id": None, "diff": None,
                "record": ex, "reasons": ["missing shift; cannot key to production_shifts"], "confidence": 1.0,
            })
            counts["malformed"] += 1
            continue

        sh = norm_num(ex.get("shift_hrs"))
        if sh is None or sh <= 0:
            reasons.append("shift_hrs <= 0")
        if reasons:
            classifications.append({
                "idx": idx, "class": "MALFORMED", "natural_key": {"shift_id": None},
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
        natural_key = {"shift_id": resolved_shift_id}

        if needs_shift_upsert:
            counts["needs_shift_upsert"] += 1
            classifications.append({
                "idx": idx, "class": "NEW", "natural_key": natural_key,
                "resolved_shift_id": None, "needs_shift_upsert": True, "existing_id": None, "diff": None,
                "record": ex, "reasons": ["parent shift absent; upsert shift then insert downtime"],
                "confidence": 0.95,
            })
            counts["new"] += 1
            continue

        db_row = db_index.get(resolved_shift_id)
        if db_row is None:
            classifications.append({
                "idx": idx, "class": "NEW", "natural_key": natural_key,
                "resolved_shift_id": resolved_shift_id, "needs_shift_upsert": False, "existing_id": None, "diff": None,
                "record": ex, "reasons": ["shift exists; no downtime row yet"], "confidence": 0.97,
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
        "table": "production_downtime",
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
        print("=== production_downtime Classification Summary ===", file=sys.stderr)
        for k, v in result["summary"].items():
            print(f"  {k}: {v}", file=sys.stderr)

    print(json.dumps({"ok": True, "summary": result["summary"], "output_path": str(output_path)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
