#!/usr/bin/env python3
"""
Classify PROPOSED DAILY REPORT extracted rows against existing rc_out rows.

Natural key: (transaction_date, batch_id, destination)
- batch_id is uuid; resolved from batch_code via a lookup table.
- destination is always 'MAIN' in current usage.

Outcomes per row:
  - NEW              : natural key not in DB -> queue for INSERT
  - DUPLICATE_NOOP   : natural key in DB, all non-key fields match -> silently skip
  - VALUE_CHANGED    : natural key in DB, >=1 field differs -> queue with diff for human decision
  - FLAGGED          : a sub-watermark row that classified as NEW -> NEVER auto-insert (see watermark guard)
  - UNMAPPED         : batch_code couldn't be resolved to a batch_id in the DB -> needs manual lookup
  - MALFORMED        : missing required field (date / weight) -> skip with reason

Equality rules:
  - weight_kg: numeric tolerance 0.001
  - remarks: case-insensitive trim, null == empty
  - destination: case-sensitive exact
  - production_batch: case-insensitive trim, null == empty
  - block_loc: usually empty string in DB; skip from comparison unless extracted is non-null

DEDUP-WINDOW RULE (BUG-1 fix, see SKILL.md / LEARNING_LEDGER L-019):
  The --db-rows-json passed in MUST cover the FULL date range of the rows being
  classified (min..max of the extract), not a fixed narrow tail. The PROPOSED
  report is cumulative (rows back to the season start); if the DB comparison set
  only covers a recent window, historical rows fall outside it, get mis-classified
  as NEW, and are re-INSERTed — doubling consumption. The calling agent is
  responsible for querying rc_out over the extract's min..max date span.

SUB-WATERMARK WRITE GUARD (BUG-1 fix):
  Pass --watermark = the live DB MAX(transaction_date) for rc_out. Any row whose
  transaction_date <= watermark that would otherwise be NEW is a SETTLED date and
  is routed to the FLAGGED bucket instead of NEW — a settled date must NEVER
  produce an INSERT. Settled dates may only be NOOP or VALUE_CHANGED. This is a
  hard guard: even if the DB comparison set is somehow incomplete, a sub-watermark
  row can no longer silently duplicate. Omitting --watermark disables the guard
  (first-time historical backfill ONLY — never the daily driver).

Usage:
    python3 classify_rc_out.py \\
        --extract-json /tmp/.../extract_proposed.json \\
        --batch-lookup-json /tmp/.../batch_lookup.json \\
        --db-rows-json /tmp/.../rc_out_rows.json \\
        --output /tmp/.../classified_rc_out.json \\
        [--watermark 2026-06-16] \\
        [--verbose]

batch_lookup.json format: {"BATCH_CODE": "uuid-string", ...}
db_rows.json format: array of rc_out rows with id, transaction_date, batch_id, destination,
                     weight_kg, remarks, block_loc, production_batch.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
def norm_str(s: Any) -> str | None:
    if s is None:
        return None
    s = str(s).strip()
    return s.lower() if s else None


def norm_num(v: Any, places: int = 3) -> float | None:
    if v is None:
        return None
    try:
        return round(float(v), places)
    except (TypeError, ValueError):
        return None


def make_natural_key(transaction_date: str, batch_id: str, destination: str = "MAIN") -> tuple:
    return (transaction_date, batch_id, destination)


def resolve_batch_id(row: dict, batch_lookup: dict[str, str]) -> tuple[str | None, str | None]:
    """
    Given an extracted row with batch_code_primary + batch_code_fallbacks,
    return (batch_id, batch_code_used) or (None, None) if not resolved.
    """
    primary = row.get("batch_code_primary")
    if primary and primary in batch_lookup:
        return batch_lookup[primary], primary
    for fb in row.get("batch_code_fallbacks", []) or []:
        if fb in batch_lookup:
            return batch_lookup[fb], fb
    return None, None


def field_differences(extracted: dict, db_row: dict) -> list[dict]:
    """Return list of {field, emailValue, dbValue}."""
    diffs = []

    # weight_kg
    e_w = norm_num(extracted.get("weight_kg") or extracted.get("day_total_kg"), 3)
    d_w = norm_num(db_row.get("weight_kg"), 3)
    if e_w != d_w:
        diffs.append({
            "field": "weight_kg",
            "emailValue": e_w,
            "dbValue": d_w,
        })

    # remarks
    e_r = norm_str(extracted.get("remarks"))
    d_r = norm_str(db_row.get("remarks"))
    # Treat None and empty string as equivalent
    if e_r != d_r:
        diffs.append({
            "field": "remarks",
            "emailValue": extracted.get("remarks"),
            "dbValue": db_row.get("remarks"),
        })

    # production_batch
    e_pb = norm_str(extracted.get("production_batch"))
    d_pb = norm_str(db_row.get("production_batch"))
    if e_pb != d_pb:
        diffs.append({
            "field": "production_batch",
            "emailValue": extracted.get("production_batch"),
            "dbValue": db_row.get("production_batch"),
        })

    # block_loc — only compare if extracted side is non-null
    # (DB typically stores empty string and pulls block_loc from batches.location_ref via join)
    e_bl = extracted.get("block_loc")
    if e_bl is not None and e_bl != "":
        d_bl = db_row.get("block_loc")
        if norm_str(e_bl) != norm_str(d_bl):
            diffs.append({
                "field": "block_loc",
                "emailValue": e_bl,
                "dbValue": d_bl,
            })

    return diffs


def main() -> int:
    parser = argparse.ArgumentParser(description="Classify PROPOSED rows against rc_out.")
    parser.add_argument("--extract-json", required=True)
    parser.add_argument("--batch-lookup-json", required=True,
                        help='JSON object mapping {batch_code: batch_id (uuid)}')
    parser.add_argument("--db-rows-json", required=True,
                        help='Array of existing rc_out rows covering the FULL min..max date '
                             'range of the extract (NOT a narrow tail) — see DEDUP-WINDOW RULE')
    parser.add_argument("--watermark",
                        help='Live DB MAX(transaction_date) for rc_out (YYYY-MM-DD). Sub-watermark '
                             'rows that would be NEW are routed to FLAGGED, never inserted. '
                             'Omit ONLY for a first-time historical backfill.')
    parser.add_argument("--output", required=True)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    watermark = (args.watermark or "").strip() or None

    extract_path = Path(args.extract_json).expanduser()
    lookup_path = Path(args.batch_lookup_json).expanduser()
    db_path = Path(args.db_rows_json).expanduser()
    output_path = Path(args.output).expanduser()

    for label, p in [("extract", extract_path), ("batch_lookup", lookup_path), ("db_rows", db_path)]:
        if not p.exists():
            print(json.dumps({"error": f"{label} file not found: {p}"}), file=sys.stderr)
            return 1

    extracted_data = json.loads(extract_path.read_text())
    batch_lookup = json.loads(lookup_path.read_text())
    db_rows = json.loads(db_path.read_text())

    # Handle wrapped {"data": [...]} from json_agg
    if isinstance(db_rows, list) and len(db_rows) == 1 and isinstance(db_rows[0], dict) and "data" in db_rows[0]:
        db_rows = db_rows[0]["data"] or []

    extracted_rows = extracted_data.get("rows", [])

    # Index DB by natural key
    db_index: dict[tuple, list[dict]] = {}
    for db_row in db_rows:
        key = make_natural_key(
            db_row.get("transaction_date"),
            db_row.get("batch_id"),
            db_row.get("destination") or "MAIN",
        )
        db_index.setdefault(key, []).append(db_row)

    classified_new = []
    classified_changed = []
    classified_noop = []
    classified_unmapped = []
    classified_malformed = []
    classified_flagged = []  # sub-watermark rows that classified as NEW — never auto-insert

    for ex_row in extracted_rows:
        # Required field check
        if not ex_row.get("transaction_date"):
            classified_malformed.append({"row": ex_row, "reason": "missing transaction_date"})
            continue
        w = ex_row.get("weight_kg") or ex_row.get("day_total_kg")
        if w is None or float(w) == 0:
            classified_malformed.append({"row": ex_row, "reason": "missing or zero weight"})
            continue

        # Resolve batch_id
        batch_id, batch_code_used = resolve_batch_id(ex_row, batch_lookup)
        if batch_id is None:
            classified_unmapped.append({
                "index": ex_row.get("_source_row"),
                "row": ex_row,
                "reason": (
                    f"No batch_id found for primary='{ex_row.get('batch_code_primary')}' "
                    f"or fallbacks={ex_row.get('batch_code_fallbacks')}"
                ),
            })
            continue

        # Enrich extracted with resolved batch info
        ex_row["batch_id"] = batch_id
        ex_row["batch_code_resolved"] = batch_code_used
        destination = ex_row.get("destination") or "MAIN"
        key = make_natural_key(ex_row["transaction_date"], batch_id, destination)
        matches = db_index.get(key, [])

        if not matches:
            # SUB-WATERMARK WRITE GUARD: a settled date (<= live DB watermark) must
            # never produce an INSERT. If a row with no natural-key match lands on or
            # before the watermark, the DB comparison set was likely incomplete OR this
            # is a genuine miss — either way it is NOT safe to auto-insert (that is the
            # exact path that doubled May 29–Jun 16). Route to FLAGGED for human review.
            if watermark is not None and ex_row["transaction_date"] <= watermark:
                classified_flagged.append({
                    "index": ex_row.get("_source_row"),
                    "row": ex_row,
                    "reason": (
                        f"sub-watermark NEW: transaction_date {ex_row['transaction_date']} "
                        f"<= watermark {watermark} but no DB natural-key match. A settled date "
                        f"must not be inserted (suspected duplicate / incomplete compare-set). "
                        f"Resolve manually: confirm it is truly missing before any write."
                    ),
                })
            else:
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

    # Compute the date span the DB comparison set actually covers, so the agent can
    # verify the DEDUP-WINDOW RULE held (db span must contain the extract span).
    extract_dates = [r["transaction_date"] for r in extracted_rows if r.get("transaction_date")]
    db_dates = [r.get("transaction_date") for r in db_rows if r.get("transaction_date")]
    db_span = {"min": min(db_dates), "max": max(db_dates)} if db_dates else {"min": None, "max": None}
    extract_span = ({"min": min(extract_dates), "max": max(extract_dates)}
                    if extract_dates else {"min": None, "max": None})

    result = {
        "summary": {
            "extracted_total": len(extracted_rows),
            "new_count": len(classified_new),
            "changed_count": len(classified_changed),
            "noop_count": len(classified_noop),
            "flagged_count": len(classified_flagged),
            "unmapped_count": len(classified_unmapped),
            "malformed_count": len(classified_malformed),
            "db_rows_in_window": len(db_rows),
            "watermark": watermark,
            "extract_date_span": extract_span,
            "db_date_span": db_span,
        },
        "new": classified_new,
        "changed": classified_changed,
        "noop": classified_noop,
        "flagged": classified_flagged,
        "unmapped": classified_unmapped,
        "malformed": classified_malformed,
    }
    output_path.write_text(json.dumps(result, indent=2, default=str))

    if args.verbose:
        s = result["summary"]
        print("=== rc_out Classification Summary ===", file=sys.stderr)
        for k in ("extracted_total", "new_count", "changed_count", "noop_count",
                  "flagged_count", "unmapped_count", "malformed_count", "db_rows_in_window"):
            print(f"  {k}: {s[k]}", file=sys.stderr)
        print(f"  watermark: {watermark}", file=sys.stderr)
        print(f"  extract_date_span: {extract_span}", file=sys.stderr)
        print(f"  db_date_span: {db_span}", file=sys.stderr)
        # Loud warning if the DB compare-set does not cover the extract span — this is
        # the precondition the dedup correctness depends on.
        if (extract_span["min"] and db_span["min"]
                and (db_span["min"] > extract_span["min"] or
                     (db_span["max"] or "") < (extract_span["max"] or ""))):
            print("  WARNING: DB compare-set span does NOT cover the extract span — "
                  "dedup may be incomplete. Re-query rc_out over the full extract "
                  "min..max before trusting NEW counts.", file=sys.stderr)
        if classified_flagged:
            print(f"  WARNING: {len(classified_flagged)} sub-watermark row(s) FLAGGED "
                  "(would have been NEW on a settled date — NOT auto-inserted).",
                  file=sys.stderr)

    print(json.dumps({"ok": True, "summary": result["summary"], "output_path": str(output_path)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
