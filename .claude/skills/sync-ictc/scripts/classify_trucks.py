#!/usr/bin/env python3
"""
Classify extracted truck meter readings against existing truck_readings rows.

Natural key: (reading_date, plate_no)

Outcomes per row:
  - NEW              : natural key not in DB -> queue for INSERT
  - DUPLICATE_NOOP   : natural key in DB, all comparable fields match -> silently skip
  - VALUE_CHANGED    : natural key in DB, >=1 comparable field differs -> queue with diff for human decision
  - MALFORMED        : empty plate_no, or missing start_km / end_km -> skip with reason

Comparable fields (numeric tolerance 0.01):
  - start_km, end_km, fuel_liters, remarks

IMPORTANT — generated column is NEVER compared or emitted:
  - ttl_km = end_km - start_km   [DB GENERATED]
  This classifier only ever touches the BASE columns the operator actually reports.

Equality rules:
  - start_km / end_km / fuel_liters: numeric tolerance 0.01
  - remarks: case-insensitive trim, null == empty
  - plate_no: case-insensitive on the key (normalized, whitespace-collapsed) but preserved in the record

Usage:
    python3 classify_trucks.py \\
        --extract-json /tmp/.../out_mc.json \\
        --db-rows-json /tmp/.../truck_rows.json \\
        --output /tmp/.../classified_trucks.json \\
        [--verbose]

extract-json: the MC daily-production extractor output; reads its top-level `trucks[]` array.
db-rows-json: array of existing truck_readings rows
              [{id, reading_date, plate_no, start_km, end_km, fuel_liters, remarks}].
              A json_agg-wrapped {"data": [...]} shape is also accepted.

Exit codes:
    0 = success
    1 = file not found or unreadable
    2 = JSON parse error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


# Comparable base columns. ttl_km is DB-generated and intentionally absent
# here so it is never compared nor written back.
NUMERIC_TOLERANCE = 0.01
COMPARABLE_NUMERIC_FIELDS = ("start_km", "end_km", "fuel_liters")
EMITTED_RECORD_FIELDS = (
    "reading_date",
    "plate_no",
    "start_km",
    "end_km",
    "fuel_liters",
    "remarks",
)


# ---------------------------------------------------------------------------
# Normalization helpers (mirrors classify_rc_out.py / classify_deliveries.py)
# ---------------------------------------------------------------------------
def norm_str(s: Any) -> str | None:
    if s is None:
        return None
    s = str(s).strip()
    return s.lower() if s else None


def norm_num(v: Any, places: int = 2) -> float | None:
    if v is None:
        return None
    try:
        return round(float(v), places)
    except (TypeError, ValueError):
        return None


def norm_plate(v: Any) -> str | None:
    """Plate: case-insensitive key, collapse internal whitespace ('AAV  6111' == 'AAV 6111')."""
    if v is None:
        return None
    s = re.sub(r"\s+", " ", str(v).strip())
    return s.upper() if s else None


def make_natural_key(reading_date: Any, plate_no: Any) -> tuple:
    return (reading_date, norm_plate(plate_no))


def clean_record(row: dict) -> dict:
    """Project an extracted row down to the emitted base columns only."""
    return {k: row.get(k) for k in EMITTED_RECORD_FIELDS}


def field_differences(extracted: dict, db_row: dict) -> list[dict]:
    """Return list of {field, emailValue, dbValue} over comparable base columns only."""
    diffs: list[dict] = []

    for field in COMPARABLE_NUMERIC_FIELDS:
        e_v = norm_num(extracted.get(field), 2)
        d_v = norm_num(db_row.get(field), 2)
        if e_v != d_v:
            diffs.append({
                "field": field,
                "emailValue": extracted.get(field),
                "dbValue": db_row.get(field),
            })

    # remarks — case-insensitive trim, null == empty
    if norm_str(extracted.get("remarks")) != norm_str(db_row.get("remarks")):
        diffs.append({
            "field": "remarks",
            "emailValue": extracted.get("remarks"),
            "dbValue": db_row.get("remarks"),
        })

    return diffs


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Classify extracted truck readings against truck_readings."
    )
    parser.add_argument("--extract-json", required=True,
                        help="MC extractor output; reads its top-level trucks[] array")
    parser.add_argument("--db-rows-json", required=True,
                        help="Array of existing truck_readings rows in the date window")
    parser.add_argument("--output", required=True, help="Where to write the classified result JSON")
    parser.add_argument("--verbose", action="store_true",
                        help="Also print a human-readable summary to stderr")
    args = parser.parse_args()

    extract_path = Path(args.extract_json).expanduser()
    db_path = Path(args.db_rows_json).expanduser()
    output_path = Path(args.output).expanduser()

    for label, p in [("extract", extract_path), ("db_rows", db_path)]:
        if not p.exists():
            sys.stderr.write(json.dumps({"error": f"{label} file not found: {p}"}) + "\n")
            return 1

    try:
        extracted_data = json.loads(extract_path.read_text())
        db_rows = json.loads(db_path.read_text())
    except json.JSONDecodeError as e:
        sys.stderr.write(json.dumps({"error": f"JSON parse error: {e}"}) + "\n")
        return 2

    # DB rows may be wrapped in {"data": [...]} from json_agg — unwrap if needed.
    if isinstance(db_rows, list) and len(db_rows) == 1 and isinstance(db_rows[0], dict) and "data" in db_rows[0]:
        db_rows = db_rows[0]["data"] or []

    # Accept either the full extractor dict ({"trucks": [...]}) or a bare list.
    if isinstance(extracted_data, dict):
        extracted_rows = extracted_data.get("trucks", []) or []
    elif isinstance(extracted_data, list):
        extracted_rows = extracted_data
    else:
        extracted_rows = []

    # Index DB by natural key.
    db_index: dict[tuple, list[dict]] = {}
    for db_row in db_rows:
        key = make_natural_key(db_row.get("reading_date"), db_row.get("plate_no"))
        db_index.setdefault(key, []).append(db_row)

    classifications: list[dict] = []
    counts = {"new": 0, "value_changed": 0, "duplicate_noop": 0, "malformed": 0}

    for idx, ex_row in enumerate(extracted_rows):
        reading_date = ex_row.get("reading_date")
        plate_no = norm_plate(ex_row.get("plate_no"))
        nat_key = {"reading_date": reading_date, "plate_no": plate_no}

        # MALFORMED: empty plate or missing start/end km.
        reasons_bad: list[str] = []
        if not reading_date:
            reasons_bad.append("missing reading_date")
        if not plate_no:
            reasons_bad.append("missing or empty plate_no")
        if ex_row.get("start_km") is None:
            reasons_bad.append("missing start_km")
        if ex_row.get("end_km") is None:
            reasons_bad.append("missing end_km")
        if reasons_bad:
            counts["malformed"] += 1
            classifications.append({
                "idx": idx,
                "class": "MALFORMED",
                "natural_key": nat_key,
                "existing_id": None,
                "diff": None,
                "record": clean_record(ex_row),
                "reasons": reasons_bad,
                "confidence": 1.0,
            })
            continue

        key = make_natural_key(reading_date, plate_no)
        matches = db_index.get(key, [])

        if not matches:
            counts["new"] += 1
            classifications.append({
                "idx": idx,
                "class": "NEW",
                "natural_key": nat_key,
                "existing_id": None,
                "diff": None,
                "record": clean_record(ex_row),
                "reasons": ["natural key (reading_date, plate_no) not present in DB"],
                "confidence": 1.0,
            })
            continue

        db_row = matches[0]
        diffs = field_differences(ex_row, db_row)
        ambiguous = len(matches) > 1

        if not diffs:
            counts["duplicate_noop"] += 1
            classifications.append({
                "idx": idx,
                "class": "DUPLICATE_NOOP",
                "natural_key": nat_key,
                "existing_id": db_row.get("id"),
                "diff": None,
                "record": clean_record(ex_row),
                "reasons": (["multiple DB rows share this natural key; matched first"]
                            if ambiguous else
                            ["all comparable base fields match existing row"]),
                "confidence": 0.85 if ambiguous else 1.0,
            })
        else:
            counts["value_changed"] += 1
            classifications.append({
                "idx": idx,
                "class": "VALUE_CHANGED",
                "natural_key": nat_key,
                "existing_id": db_row.get("id"),
                "diff": diffs,
                "record": clean_record(ex_row),
                "reasons": ([f"{len(diffs)} field(s) differ from existing row"]
                            + (["multiple DB rows share this natural key; matched first"]
                               if ambiguous else [])),
                "confidence": 0.7 if ambiguous else 0.95,
            })

    result = {
        "table": "truck_readings",
        "classifications": classifications,
        "summary": {
            "new": counts["new"],
            "value_changed": counts["value_changed"],
            "duplicate_noop": counts["duplicate_noop"],
            "malformed": counts["malformed"],
            "extracted_total": len(extracted_rows),
            "db_rows_in_window": len(db_rows),
        },
    }
    output_path.write_text(json.dumps(result, indent=2, default=str))

    if args.verbose:
        s = result["summary"]
        print("=== truck_readings Classification Summary ===", file=sys.stderr)
        print(f"  NEW            : {s['new']}", file=sys.stderr)
        print(f"  VALUE_CHANGED  : {s['value_changed']}", file=sys.stderr)
        print(f"  DUPLICATE_NOOP : {s['duplicate_noop']}", file=sys.stderr)
        print(f"  MALFORMED      : {s['malformed']}", file=sys.stderr)
        print(f"  extracted_total: {s['extracted_total']}", file=sys.stderr)
        print(f"  db_rows_window : {s['db_rows_in_window']}", file=sys.stderr)

    print(json.dumps({"ok": True, "summary": result["summary"], "output_path": str(output_path)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
