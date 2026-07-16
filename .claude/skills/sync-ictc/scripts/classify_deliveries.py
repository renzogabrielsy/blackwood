#!/usr/bin/env python3
"""
Classify RC DELIVERIES extracted rows against existing DB rows.

Natural key: (transaction_date, batch_code, block_loc, weight_kg)

Outcomes per row:
  - NEW              : natural key not in DB -> queue for INSERT
  - DUPLICATE_NOOP   : natural key in DB, all non-key fields match -> silently skip
  - VALUE_CHANGED    : natural key in DB, >=1 field differs -> queue with diff for human decision
  - MALFORMED        : missing required field (date / batch_code / weight) -> skip with reason

Equality rules:
  - strings (supplier, truck_plate, remarks): case-insensitive, trim whitespace, null == empty
  - numbers (sacks, cost_basis): tolerance 0.001
  - cost_basis: SKIPPED from comparison if extracted side is null (operator file has no price column)
  - lab_results JSONB: deep equality at 2-decimal precision (lab data is variable precision in source)

Usage:
    python3 classify_deliveries.py \\
        --extract-json /tmp/.../extract_enriched.json \\
        --db-rows-json /tmp/.../db_rows.json \\
        --output /tmp/.../classified.json \\
        [--verbose]

Exit codes:
    0 = success
    1 = file not found or unreadable
    2 = JSON parse error
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------
def norm_str(s: Any) -> str | None:
    if s is None:
        return None
    s = str(s).strip()
    return s.lower() if s else None


def norm_block_loc(s: Any) -> str | None:
    """Block loc is a code; case-insensitive but preserve format."""
    if s is None:
        return None
    s = str(s).strip()
    return s.upper() if s else None


def norm_num(v: Any, places: int = 3) -> float | None:
    if v is None:
        return None
    try:
        return round(float(v), places)
    except (TypeError, ValueError):
        return None


def norm_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(float(v))  # tolerate "123.0" strings
    except (TypeError, ValueError):
        return None


def make_natural_key(row: dict) -> tuple:
    return (
        row.get("transaction_date"),
        row.get("batch_code"),
        norm_block_loc(row.get("block_loc")),
        norm_num(row.get("weight_kg"), places=3),
    )


def deep_lab_equal(a: dict | None, b: dict | None) -> bool:
    """Lab data comparison at 2-decimal precision (variable source precision)."""
    a = a or {}
    b = b or {}
    keys = set(a.keys()) | set(b.keys())
    for k in keys:
        va = norm_num(a.get(k), places=2)
        vb = norm_num(b.get(k), places=2)
        if va != vb:
            return False
    return True


def field_differences(extracted: dict, db_row: dict) -> list[dict]:
    """Return list of {field, emailValue, dbValue} where the two rows differ.

    NOTE: `true_weight_kg` and `deduction_note` are intentionally NOT compared
    here. They are additive, write-only display fields (see DEDUCTIONS_DESIGN.md):
    they are derived from the remark at ingestion and written on insert/update, but
    a Sheet-vs-DB diff must never FIRE on them (a deducted row must not become a
    perpetual VALUE_CHANGED just because the DB hasn't backfilled them yet). The
    natural key (date, batch_code, block_loc, weight_kg) is likewise unchanged —
    weight_kg stays the Sheet's deducted NET.
    """
    diffs = []

    if norm_str(extracted.get("supplier")) != norm_str(db_row.get("supplier")):
        diffs.append({
            "field": "supplier",
            "emailValue": extracted.get("supplier"),
            "dbValue": db_row.get("supplier"),
        })

    if norm_str(extracted.get("truck_plate")) != norm_str(db_row.get("truck_plate")):
        diffs.append({
            "field": "truck_plate",
            "emailValue": extracted.get("truck_plate"),
            "dbValue": db_row.get("truck_plate"),
        })

    if norm_int(extracted.get("sacks")) != norm_int(db_row.get("sacks")):
        diffs.append({
            "field": "sacks",
            "emailValue": extracted.get("sacks"),
            "dbValue": db_row.get("sacks"),
        })

    # cost_basis: skip if extracted is null (operator file has no price column)
    if extracted.get("cost_basis") is not None:
        if norm_num(extracted.get("cost_basis"), 3) != norm_num(db_row.get("cost_basis"), 3):
            diffs.append({
                "field": "cost_basis",
                "emailValue": extracted.get("cost_basis"),
                "dbValue": db_row.get("cost_basis"),
            })

    if norm_str(extracted.get("remarks")) != norm_str(db_row.get("remarks")):
        diffs.append({
            "field": "remarks",
            "emailValue": extracted.get("remarks"),
            "dbValue": db_row.get("remarks"),
        })

    if not deep_lab_equal(extracted.get("lab_results"), db_row.get("lab_results")):
        diffs.append({
            "field": "lab_results",
            "emailValue": extracted.get("lab_results"),
            "dbValue": db_row.get("lab_results"),
        })

    return diffs


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="Classify RC DELIVERIES rows against DB.")
    parser.add_argument("--extract-json", required=True, help="Extracted rows JSON (output of extract_rc_deliveries.py + optional enrich_prices.py)")
    parser.add_argument("--db-rows-json", required=True, help="DB rows JSON from a Supabase query of deliveries in the date window")
    parser.add_argument("--output", required=True, help="Where to write the classified result JSON")
    parser.add_argument("--verbose", action="store_true", help="Also print a human-readable summary to stdout")
    args = parser.parse_args()

    extract_path = Path(args.extract_json).expanduser()
    db_path = Path(args.db_rows_json).expanduser()
    output_path = Path(args.output).expanduser()

    if not extract_path.exists():
        sys.stderr.write(json.dumps({"error": f"Extract file not found: {extract_path}"}) + "\n")
        return 1
    if not db_path.exists():
        sys.stderr.write(json.dumps({"error": f"DB rows file not found: {db_path}"}) + "\n")
        return 1

    try:
        extracted_data = json.loads(extract_path.read_text())
        db_rows = json.loads(db_path.read_text())
    except json.JSONDecodeError as e:
        sys.stderr.write(json.dumps({"error": f"JSON parse error: {e}"}) + "\n")
        return 2

    # DB rows may be wrapped in {"data": [...]} from json_agg, unwrap if needed
    if isinstance(db_rows, list) and len(db_rows) == 1 and isinstance(db_rows[0], dict) and "data" in db_rows[0]:
        db_rows = db_rows[0]["data"]

    extracted_rows = extracted_data.get("rows", [])

    # Index DB rows by natural key
    db_index: dict[tuple, list[dict]] = {}
    for db_row in db_rows:
        key = make_natural_key(db_row)
        db_index.setdefault(key, []).append(db_row)

    classified_new = []
    classified_changed = []
    classified_noop = []
    classified_malformed = []

    for ex_row in extracted_rows:
        if not ex_row.get("transaction_date") or not ex_row.get("batch_code") or not ex_row.get("weight_kg"):
            classified_malformed.append({
                "row": ex_row,
                "reason": "Missing required field (transaction_date / batch_code / weight_kg)",
            })
            continue

        key = make_natural_key(ex_row)
        matches = db_index.get(key, [])

        if not matches:
            classified_new.append({"index": ex_row.get("_source_row"), "row": ex_row})
        else:
            db_row = matches[0]
            diffs = field_differences(ex_row, db_row)
            if not diffs:
                classified_noop.append({
                    "index": ex_row.get("_source_row"),
                    "natural_key": list(key),
                    "db_id": db_row.get("id"),
                })
            else:
                classified_changed.append({
                    "index": ex_row.get("_source_row"),
                    "row": ex_row,
                    "db_row": db_row,
                    "diff": diffs,
                })

    result = {
        "summary": {
            "extracted_total": len(extracted_rows),
            "new_count": len(classified_new),
            "changed_count": len(classified_changed),
            "noop_count": len(classified_noop),
            "malformed_count": len(classified_malformed),
            "db_rows_in_window": len(db_rows),
        },
        "new": classified_new,
        "changed": classified_changed,
        "noop": classified_noop,
        "malformed": classified_malformed,
    }

    output_path.write_text(json.dumps(result, indent=2, default=str))

    if args.verbose:
        s = result["summary"]
        print(f"=== Classification Summary ===", file=sys.stderr)
        print(f"Extracted total:    {s['extracted_total']}", file=sys.stderr)
        print(f"  NEW             : {s['new_count']}", file=sys.stderr)
        print(f"  VALUE_CHANGED   : {s['changed_count']}", file=sys.stderr)
        print(f"  DUPLICATE_NOOP  : {s['noop_count']}", file=sys.stderr)
        print(f"  MALFORMED       : {s['malformed_count']}", file=sys.stderr)
        print(f"DB rows in window:  {s['db_rows_in_window']}", file=sys.stderr)

    # Also print compact summary to stdout for the calling agent
    print(json.dumps({
        "ok": True,
        "summary": result["summary"],
        "output_path": str(output_path),
    }))

    return 0


if __name__ == "__main__":
    sys.exit(main())
