#!/usr/bin/env python3
"""
Classify extracted FLECON bag movements against existing flecon_bag_movements — DAY-SET diff.

REPLACE-BY-DATE model (FLECON_BAGGING_DESIGN.md §3, §5). Unlike the other classifiers, a bag
movement register legitimately repeats (two `BAGGED POWDER -X` same day/type), so there is NO
stable per-row natural key. The unit of comparison is therefore the WHOLE DAY:

  For each transaction_date in the extract window, compare the extracted day-set to the DB
  day-set as MULTISETS of (particular, bag_type_code, qty_delta):
    - date absent in DB                        -> NEW           (insert whole day on EXECUTE)
    - present, multisets identical             -> DUPLICATE_NOOP (skip)
    - present, any difference                  -> DATE_CHANGED  (whole day REPLACED on EXECUTE:
                                                   DELETE that date's rows then re-INSERT the
                                                   sheet's current movements for that date)

The classifier emits summary counts + the per-date deltas for NEW / DATE_CHANGED days only
(NOOP days are counted, never dumped, to keep the agent's context small).

COLUMN-MAPPING FLAGS (pass-through): the extractor now maps bag-type columns by HEADER
SIGNATURE (position-independent) rather than fixed letters, and reports `column_map`,
`unmapped_columns` (a header signature that matched NO registry entry but has qty — a
candidate NEW bag type), and `missing_columns` (a registry code with no column this run —
removed/renamed?). This classifier surfaces those verbatim under `column_flags` as FLAGGED
items for the user to register/acknowledge. They NEVER block the movements that DID map —
those still classify NEW / DATE_CHANGED / NOOP exactly as before.

DB access is via lib/db.py (service-role PostgREST) so rows never touch the agent's context.
Resolves bag_type_code -> bag_type_id from flecon_bag_types for the EXECUTE payload. Also
computes an INFORMATIONAL balance cross-check: our SQL view_flecon_bag_balance per code vs the
sheet's balance_snapshot (if the extractor located one). Drift is reported, NEVER gates.

Usage:
    python3 classify_flecon_bags.py \\
        --extract-json /tmp/run/extract_flecon_bags.json \\
        --since 2026-01-01 \\
        --output /tmp/run/classified_flecon_bags.json \\
        [--verbose]

    # Offline (no DB): pass a canned DB day-set + type map + view snapshot instead of hitting Supabase.
    python3 classify_flecon_bags.py --extract-json ... --since ... --output ... \\
        --db-rows-json /tmp/db_movements.json \\
        --bag-types-json /tmp/bag_types.json \\
        --view-balance-json /tmp/view_balance.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

# lib/db.py lives alongside this script under lib/.
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from lib.db import DBClient  # type: ignore
except Exception:  # noqa: BLE001  -- offline mode is still supported via --db-rows-json etc.
    DBClient = None  # type: ignore


# ---------------------------------------------------------------------------
# Normalization / day-set signature
# ---------------------------------------------------------------------------
def norm_particular(s: Any) -> str:
    """Trim + collapse internal whitespace + uppercase. Keeps both ZAMBOANGA spellings distinct
    (we do NOT canonicalize the spelling — only whitespace/case), so a genuine text edit still
    registers as a day change."""
    if s is None:
        return ""
    return " ".join(str(s).upper().split())


def movement_sig(m: dict) -> tuple[str, str, int]:
    """A single movement's identity within a day: (particular^, bag_type_code, qty_delta)."""
    try:
        qty = int(round(float(m.get("qty_delta"))))
    except (TypeError, ValueError):
        qty = 0
    return (
        norm_particular(m.get("particular")),
        str(m.get("bag_type_code") or "").strip().upper(),
        qty,
    )


def day_multiset(movements: list[dict]) -> Counter:
    return Counter(movement_sig(m) for m in movements)


def multiset_delta(extracted: Counter, db: Counter) -> dict[str, list[dict]]:
    """Symmetric difference expressed as added / removed movement signatures."""
    added = extracted - db      # in sheet, not (or fewer) in DB
    removed = db - extracted    # in DB, not (or fewer) in sheet
    def unpack(c: Counter) -> list[dict]:
        out = []
        for (particular, code, qty), n in sorted(c.items()):
            out.append({"particular": particular, "bag_type_code": code, "qty_delta": qty, "count": n})
        return out
    return {"added": unpack(added), "removed": unpack(removed)}


# ---------------------------------------------------------------------------
# DB loaders (live via lib/db.py, or offline via canned JSON)
# ---------------------------------------------------------------------------
def load_db_movements(args, since: str) -> list[dict]:
    if args.db_rows_json:
        rows = json.loads(Path(args.db_rows_json).expanduser().read_text())
        if isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict) and "data" in rows[0]:
            rows = rows[0]["data"] or []
        return rows
    if DBClient is None:
        raise RuntimeError("lib.db unavailable and no --db-rows-json provided (offline mode needs it).")
    # DB stores bag_type_id, not code. Fetch movements >= since joined to code via bag-types map.
    c = DBClient()
    rows = c.read_rows(
        "flecon_bag_movements",
        since_date=since,
        since_column="transaction_date",
        columns=["id", "transaction_date", "particular", "bag_type_id", "qty_delta"],
    )
    return rows


def load_bag_types(args) -> dict[str, str]:
    """Return {code: bag_type_id}. Also used to resolve DB rows' bag_type_id -> code."""
    if args.bag_types_json:
        types = json.loads(Path(args.bag_types_json).expanduser().read_text())
    elif DBClient is not None:
        types = DBClient().read_rows("flecon_bag_types", columns=["id", "code"], since_date=None)
    else:
        return {}
    return {str(t["code"]).strip().upper(): t["id"] for t in types}


def load_view_balance(args) -> list[dict]:
    if args.view_balance_json:
        v = json.loads(Path(args.view_balance_json).expanduser().read_text())
        if isinstance(v, list) and len(v) == 1 and isinstance(v[0], dict) and "data" in v[0]:
            v = v[0]["data"] or []
        return v
    if DBClient is not None:
        try:
            return DBClient().read_rows("view_flecon_bag_balance", since_date=None)
        except Exception:  # noqa: BLE001
            return []
    return []


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description="Classify FLECON bag movements (day-set / replace-by-date).")
    parser.add_argument("--extract-json", required=True, help="extract_flecon_bags.py output.")
    parser.add_argument("--since", required=True, help="Window start 'YYYY-MM-DD' (dates < since ignored).")
    parser.add_argument("--output", required=True, help="Path for the full classified JSON.")
    parser.add_argument("--verbose", action="store_true")
    # Offline overrides (skip live DB):
    parser.add_argument("--db-rows-json", default=None,
                        help="Canned flecon_bag_movements rows [{transaction_date, particular, "
                             "bag_type_id|bag_type_code, qty_delta, id}].")
    parser.add_argument("--bag-types-json", default=None,
                        help="Canned flecon_bag_types [{id, code}].")
    parser.add_argument("--view-balance-json", default=None,
                        help="Canned view_flecon_bag_balance [{code, balance, ...}].")
    args = parser.parse_args()

    extract_path = Path(args.extract_json).expanduser()
    if not extract_path.exists():
        print(json.dumps({"error": f"extract file not found: {extract_path}"}), file=sys.stderr)
        return 1
    extracted = json.loads(extract_path.read_text())
    ex_rows: list[dict] = extracted.get("rows", []) if isinstance(extracted, dict) else extracted

    # Column-mapping resilience signals from the extractor (position-independent header match).
    # These are FLAGGED items requiring the user to register a new bag type or acknowledge a
    # removed/renamed one. They do NOT block the movements that DID map.
    ex_column_map = extracted.get("column_map", []) if isinstance(extracted, dict) else []
    ex_unmapped = extracted.get("unmapped_columns", []) if isinstance(extracted, dict) else []
    ex_missing = extracted.get("missing_columns", []) if isinstance(extracted, dict) else []

    since = args.since.strip()

    # Resolve type map (code -> id) and its inverse (id -> code) for DB rows.
    code_to_id = load_bag_types(args)
    id_to_code = {v: k for k, v in code_to_id.items()}

    # Load DB movements in-window; normalize each to carry bag_type_code.
    db_rows = load_db_movements(args, since)
    for row in db_rows:
        if "bag_type_code" not in row and row.get("bag_type_id") in id_to_code:
            row["bag_type_code"] = id_to_code[row["bag_type_id"]]

    # Group extracted + DB movements by transaction_date.
    ex_by_date: dict[str, list[dict]] = defaultdict(list)
    for m in ex_rows:
        ex_by_date[m["transaction_date"]].append(m)
    db_by_date: dict[str, list[dict]] = defaultdict(list)
    for m in db_rows:
        d = str(m.get("transaction_date"))[:10]
        if d >= since:
            db_by_date[d].append(m)

    all_dates = sorted(set(ex_by_date) | set(db_by_date))

    per_date: list[dict] = []
    counts = {"new": 0, "date_changed": 0, "duplicate_noop": 0}
    for d in all_dates:
        ex_ms = day_multiset(ex_by_date.get(d, []))
        db_present = d in db_by_date
        db_ms = day_multiset(db_by_date.get(d, []))

        if not db_present:
            counts["new"] += 1
            per_date.append({
                "transaction_date": d,
                "class": "NEW",
                "sheet_movement_count": len(ex_by_date.get(d, [])),
                "db_movement_count": 0,
                "delta": multiset_delta(ex_ms, db_ms),   # all added
                "movements": ex_by_date.get(d, []),       # full day payload for INSERT
            })
        elif ex_ms == db_ms:
            counts["duplicate_noop"] += 1
            # NOOP days are counted only — never dumped.
        else:
            counts["date_changed"] += 1
            per_date.append({
                "transaction_date": d,
                "class": "DATE_CHANGED",
                "sheet_movement_count": len(ex_by_date.get(d, [])),
                "db_movement_count": len(db_by_date.get(d, [])),
                "delta": multiset_delta(ex_ms, db_ms),
                "movements": ex_by_date.get(d, []),       # full day payload for REPLACE
            })

    # --- Informational balance cross-check: SQL view vs sheet snapshot (never gates) ---
    view = load_view_balance(args)
    view_by_code = {str(v.get("code") or "").strip().upper(): v for v in view}
    sheet_snapshot = extracted.get("balance_snapshot") if isinstance(extracted, dict) else None
    balance_crosscheck: dict[str, Any] = {"available": False, "rows": [], "note": None}
    if sheet_snapshot:
        rows_out = []
        codes = sorted(set(view_by_code) | {c.strip().upper() for c in sheet_snapshot})
        for code in codes:
            db_bal = None
            if code in view_by_code:
                try:
                    db_bal = int(round(float(view_by_code[code].get("balance"))))
                except (TypeError, ValueError):
                    db_bal = view_by_code[code].get("balance")
            sheet_bal = sheet_snapshot.get(code)
            drift = None
            if isinstance(db_bal, int) and isinstance(sheet_bal, int):
                drift = db_bal - sheet_bal
            rows_out.append({
                "code": code, "db_view_balance": db_bal, "sheet_snapshot_balance": sheet_bal,
                "drift": drift,
            })
        balance_crosscheck = {
            "available": True,
            "rows": rows_out,
            "note": "INFORMATIONAL only — never gates writes. Drift = DB view balance - sheet snapshot.",
        }
    else:
        balance_crosscheck["note"] = "No sheet balance-snapshot located; cross-check skipped."

    # --- Column-mapping FLAGS (pass-through from the extractor; never gate movements) ---
    # unmapped_columns = a header signature that matched NO registry entry but carries qty →
    #   a possible NEW bag type the user must REGISTER (never auto-created, never dropped).
    # missing_columns = a registry code whose source_label matched NO column this run →
    #   a possibly removed/renamed column the user must ACKNOWLEDGE.
    column_flags = {
        "flagged": bool(ex_unmapped) or bool(ex_missing),
        "unmapped_columns": ex_unmapped,
        "missing_columns": ex_missing,
        "column_map": ex_column_map,
        "note": (
            "FLAGGED, informational — these do NOT block the movements that mapped. "
            "unmapped_columns = candidate NEW bag type(s) to register in flecon_bag_types; "
            "missing_columns = registry code(s) with no column this run (removed/renamed?). "
            "The agent must surface these for the user; never auto-create a bag type."
        ),
    }

    result = {
        "table": "flecon_bag_movements",
        "since": since,
        "model": "REPLACE_BY_DATE",
        "per_date": per_date,   # NEW + DATE_CHANGED only
        "code_to_id": code_to_id,
        "balance_crosscheck": balance_crosscheck,
        "column_flags": column_flags,
        "summary": {
            "new_days": counts["new"],
            "date_changed_days": counts["date_changed"],
            "duplicate_noop_days": counts["duplicate_noop"],
            "total_days_in_window": len(all_dates),
            "sheet_movements_in_window": len(ex_rows),
            "db_movements_in_window": sum(len(v) for v in db_by_date.values()),
            "unmapped_columns": len(ex_unmapped),
            "missing_columns": len(ex_missing),
            "column_map_size": len(ex_column_map),
        },
    }

    out_path = Path(args.output).expanduser()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2, default=str))

    if args.verbose:
        print("=== flecon_bag_movements Classification Summary ===", file=sys.stderr)
        for k, v in result["summary"].items():
            print(f"  {k}: {v}", file=sys.stderr)
        if column_flags["flagged"]:
            print("  !! COLUMN FLAGS (register/acknowledge — do NOT auto-create):", file=sys.stderr)
            for u in ex_unmapped:
                print(f"     unmapped col {u.get('column_letter')}: {u.get('signature')!r}", file=sys.stderr)
            for m in ex_missing:
                print(f"     missing code {m.get('code')} (was col {m.get('source_column')})", file=sys.stderr)

    print(json.dumps({"ok": True, "summary": result["summary"], "output_path": str(out_path)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
