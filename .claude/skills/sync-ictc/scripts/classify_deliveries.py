#!/usr/bin/env python3
"""
Classify RC DELIVERIES extracted rows against existing DB rows.

IDENTITY (L-040b, 2026-08-08) — TWO-TIER. This MUST stay byte-identical to the TS
port's `workers/sync/src/lib/deliveryIdentity.ts`; the parity harness compares them.

  TIER 1 (preferred) : (transaction_date, NORMALIZED truck_plate, sacks)
  TIER 2 (fallback)  : (transaction_date, batch_code, block_loc, weight_kg)  [LEGACY]

  Lookup order is tier 1, then tier 2, so the set of rows that MATCH is a strict
  superset of what the old single key matched — the change can only turn an insert into
  a match, never the reverse.

WHY: the old key was tier 2 alone. The truck plate — the one fact that actually names
the physical truckload — was NOT in it, and three human-correctable facts were. Correct
a batch code, a block or a weight and this classifier stopped recognising the row and
reported it NEW, which is how duplicate deliveries were created (2026-02-04 block swap;
`FEEDING # 1` vs `JULY-26-FEED1` on 2026-07-08 / 07-20 / 08-05 — 7 rows archived and
deleted 2026-08-07). Sacks are counted at the gate and are not revised; weight IS revised
after ASH/wet deductions, which is why sacks are in the identity and weight is not.

Outcomes per row:
  - NEW              : identity not in DB -> queue for INSERT
  - DUPLICATE_NOOP   : identity in DB, all compared fields match -> silently skip
  - VALUE_CHANGED    : identity in DB, >=1 NON-identity field differs -> queue with diff
  - IDENTITY_DIFF    : identity in DB but batch_code / block_loc / weight_kg disagree ->
                       a human correction one source has not caught up with. NEVER
                       auto-applied; the guard layer folds these into `flagged`.
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


# ---------------------------------------------------------------------------
# Two-tier identity (L-040b). Mirror of workers/sync/src/lib/deliveryIdentity.ts.
# ---------------------------------------------------------------------------
MUTABLE_IDENTITY_FIELDS = ("batch_code", "block_loc", "weight_kg")


def norm_plate(v: Any) -> str:
    """Keep alphanumerics only, uppercase. 'MAV 9202' and 'MAV9202' are one truck
    (both spellings exist in the live data: 57 rows and 35 rows)."""
    s = "" if v is None else str(v)
    return "".join(ch for ch in s.upper() if ch.isascii() and ch.isalnum())


def _date10(v: Any) -> str:
    return "" if v is None else str(v)[:10]


def is_tier1_eligible(row: dict) -> bool:
    return norm_plate(row.get("truck_plate")) != "" and norm_int(row.get("sacks")) is not None


def tier1_key(row: dict) -> str | None:
    if not is_tier1_eligible(row):
        return None
    return "T1|%s|%s|%s" % (
        _date10(row.get("transaction_date")),
        norm_plate(row.get("truck_plate")),
        norm_int(row.get("sacks")),
    )


def legacy_key(row: dict) -> str:
    """TIER 2 — the OLD natural key verbatim, same fields, same normalizers."""
    bc = "" if row.get("batch_code") is None else str(row.get("batch_code"))
    bl = norm_block_loc(row.get("block_loc"))
    w = norm_num(row.get("weight_kg"), places=3)
    return "T2|%s|%s|%s|%s" % (
        _date10(row.get("transaction_date")),
        bc,
        "" if bl is None else bl,
        "" if w is None else _num_str(w),
    )


def _num_str(v: float) -> str:
    """Render a float the way JS String() does, so the two engines produce the SAME key
    string: an integer-valued float loses its '.0' (Python str(20640.0) == '20640.0',
    JS String(20640) == '20640')."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return repr(v) if isinstance(v, float) else str(v)


def build_identity_index(rows: list[dict]) -> tuple[dict, dict]:
    """Every row is registered under its LEGACY key AND, when eligible, its tier-1 key."""
    t1: dict[str, list[dict]] = {}
    t2: dict[str, list[dict]] = {}
    for r in rows:
        k1 = tier1_key(r)
        if k1 is not None:
            t1.setdefault(k1, []).append(r)
        t2.setdefault(legacy_key(r), []).append(r)
    return t1, t2


def match_delivery(index: tuple[dict, dict], row: dict):
    """TIER 1 first, then the LEGACY key.
    Returns (rows, matched_tier, key, peer_count) or None. `peer_count > 1` on a tier-1
    match means the DB already holds more than one row for this one truckload."""
    t1, t2 = index
    k1 = tier1_key(row)
    if k1 is not None and t1.get(k1):
        return (t1[k1], 1, k1, len(t1[k1]))
    k2 = legacy_key(row)
    if t2.get(k2):
        return (t2[k2], 2, k2, len(t2[k2]))
    return None


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
    perpetual VALUE_CHANGED just because the DB hasn't backfilled them yet).

    L-040b: `batch_code` / `block_loc` / `weight_kg` ARE compared here now, because they
    left the identity (see the module docstring). Without that, a corrected batch code
    would match on tier 1 and then read as a silent NOOP. `weight_kg` stays the source's
    deducted NET — only its ROLE changed (compared, not keyed).
    """
    diffs = []

    # L-040b — the three formerly-key fields. On a tier-2 match they are equal by
    # construction; on a tier-1 match a difference here IS the human correction the
    # old key could not see.
    if norm_str(extracted.get("batch_code")) != norm_str(db_row.get("batch_code")):
        diffs.append({
            "field": "batch_code",
            "emailValue": extracted.get("batch_code"),
            "dbValue": db_row.get("batch_code"),
        })

    if norm_block_loc(extracted.get("block_loc")) != norm_block_loc(db_row.get("block_loc")):
        diffs.append({
            "field": "block_loc",
            "emailValue": extracted.get("block_loc"),
            "dbValue": db_row.get("block_loc"),
        })

    if norm_num(extracted.get("weight_kg"), 3) != norm_num(db_row.get("weight_kg"), 3):
        diffs.append({
            "field": "weight_kg",
            "emailValue": extracted.get("weight_kg"),
            "dbValue": db_row.get("weight_kg"),
        })

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

    # L-040b — index DB rows under BOTH tiers.
    db_index = build_identity_index(db_rows)

    classified_new = []
    classified_changed = []
    classified_identity_diff = []
    classified_noop = []
    classified_malformed = []

    for ex_row in extracted_rows:
        if not ex_row.get("transaction_date") or not ex_row.get("batch_code") or not ex_row.get("weight_kg"):
            classified_malformed.append({
                "row": ex_row,
                "reason": "Missing required field (transaction_date / batch_code / weight_kg)",
            })
            continue

        match = match_delivery(db_index, ex_row)

        if match is None:
            classified_new.append({"index": ex_row.get("_source_row"), "row": ex_row})
        else:
            matches, matched_tier, matched_key, peer_count = match
            db_row = matches[0]
            diffs = field_differences(ex_row, db_row)
            if not diffs:
                classified_noop.append({
                    "index": ex_row.get("_source_row"),
                    "natural_key": matched_key,
                    "matched_tier": matched_tier,
                    "db_id": db_row.get("id"),
                })
            else:
                identity_fields = [
                    d["field"] for d in diffs if d["field"] in MUTABLE_IDENTITY_FIELDS
                ]
                if identity_fields:
                    classified_identity_diff.append({
                        "index": ex_row.get("_source_row"),
                        "row": ex_row,
                        "db_row": db_row,
                        "diff": diffs,
                        "matched_tier": matched_tier,
                        "identity_fields": identity_fields,
                        "peer_count": peer_count,
                    })
                else:
                    classified_changed.append({
                        "index": ex_row.get("_source_row"),
                        "row": ex_row,
                        "db_row": db_row,
                        "diff": diffs,
                        "matched_tier": matched_tier,
                    })

    result = {
        "summary": {
            "extracted_total": len(extracted_rows),
            "new_count": len(classified_new),
            "changed_count": len(classified_changed),
            "identity_diff_count": len(classified_identity_diff),
            "noop_count": len(classified_noop),
            "malformed_count": len(classified_malformed),
            "db_rows_in_window": len(db_rows),
        },
        "new": classified_new,
        "changed": classified_changed,
        "identity_diff": classified_identity_diff,
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
        print(f"  IDENTITY_DIFF   : {s['identity_diff_count']}", file=sys.stderr)
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
