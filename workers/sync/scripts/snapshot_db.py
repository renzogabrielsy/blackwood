#!/usr/bin/env python3
"""snapshot_db.py — capture the DB window each classifier consumes into a single
fixtures/<type>/db_window/<case>.json bundle, using the SAME lib/db.py the live
pipeline uses (so the snapshot shape is byte-identical to what the classifier
self-fetches). Run ONCE per real fixture (needs .env.local); the snapshots then
make the parity harness reproducible OFFLINE forever.

For SYNTHETIC fixtures you usually hand-author the db_window JSON directly (a
tiny curated DB context), so this script is mainly for the `real` cases.

Usage:
    python3 scripts/snapshot_db.py --type flecon --case flecon_real_latest --since 2026-01-01
    python3 scripts/snapshot_db.py --type rc_out --case rc_out_real_latest --since 2025-01-01

The `--since` is the classify window floor for that case (matches the case opts).
Writes the bundle to fixtures/<type>/db_window/<case>.json with the role keys the
oracle driver / TS port expect (see src/reports/types.ts DbWindow doc).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKER = HERE.parent
FIXTURES = WORKER / "fixtures"
SCRIPTS = (WORKER.parent.parent / ".claude/skills/sync-ictc/scripts").resolve()
sys.path.insert(0, str(SCRIPTS))

from lib.db import DBClient  # type: ignore  # noqa: E402

DELIVERIES_COLS = ["id", "transaction_date", "supplier", "batch_code", "block_loc",
                   "truck_plate", "sacks", "weight_kg", "cost_basis", "remarks", "lab_results"]
RC_OUT_COLS = ["id", "transaction_date", "batch_id", "production_batch", "destination",
               "weight_kg", "block_loc", "remarks"]


def snap_flecon(db, since):
    movements = db.read_rows("flecon_bag_movements", since_date=since,
                             since_column="transaction_date",
                             columns=["id", "transaction_date", "particular", "bag_type_id", "qty_delta"])
    bag_types = db.read_rows("flecon_bag_types", columns=["id", "code"], since_date=None)
    # The EXTRACTOR needs the registry with source_label/source_column to map columns.
    bag_type_registry = db.read_rows(
        "flecon_bag_types",
        columns=["code", "source_label", "source_column", "sort_order", "label"],
        since_date=None,
    )
    try:
        view_balance = db.read_rows("view_flecon_bag_balance", since_date=None)
    except Exception:
        view_balance = []
    return {"movements": movements, "bag_types": bag_types,
            "bag_type_registry": bag_type_registry, "view_balance": view_balance}


def snap_deliveries(db, since):
    rows = db.read_rows("deliveries", since_date=since, columns=DELIVERIES_COLS)
    # L-033b hint resolves a "PILED IN <MONTH> BLOCK <N>" remark to an EXISTING
    # batch_code — the guard checks batch existence via db.select_one("batches").
    # Snapshot the full batch_code set so that check is offline-reproducible.
    batches = db.read_rows("batches", columns=["batch_code"], since_column=None, since_date=None)
    batch_codes = sorted({b["batch_code"] for b in batches if b.get("batch_code")})
    return {"deliveries": rows, "batch_codes": batch_codes}


def snap_rc_out(db, since):
    rc_out = db.read_rows("rc_out", since_date=since, columns=RC_OUT_COLS)
    batches = db.read_rows("batches", columns=["id", "batch_code"], since_column=None, since_date=None)
    batch_lookup = {b["batch_code"]: b["id"] for b in batches if b.get("batch_code")}
    # rc_out sums by date over the window (for GATE 2 / audit reuse)
    sums: dict[str, float] = {}
    for r in rc_out:
        d = str(r["transaction_date"])[:10]
        sums[d] = round(sums.get(d, 0.0) + float(r.get("weight_kg") or 0), 3)
    return {"rc_out": rc_out, "batch_lookup": batch_lookup, "rc_out_sums": sums}


def snap_gsheet(db, since):
    deliveries = db.read_rows("deliveries", since_date=since, columns=DELIVERIES_COLS)
    rc_out = db.read_rows("rc_out", since_date=since, columns=RC_OUT_COLS)
    batches = db.read_rows("batches", columns=["id", "batch_code"], since_column=None, since_date=None)
    batch_lookup = {b["batch_code"]: b["id"] for b in batches if b.get("batch_code")}
    return {"deliveries": deliveries, "rc_out": rc_out, "batch_lookup": batch_lookup}


def snap_production(db, since):
    # Window: shifts >= since; children joined via shift ids (fetch all, join).
    shifts = db.read_rows("production_shifts", since_date=since,
                          columns=["id", "transaction_date", "production_batch", "shift"])
    shift_ids = {s["id"] for s in shifts}

    def child(table, cols):
        rows = db.read_rows(table, since_column=None, since_date=None, columns=cols)
        return [r for r in rows if r.get("shift_id") in shift_ids]

    runs = child("production_runs", ["id", "shift_id", "customer", "grade", "ttl_kg", "sacks_bags", "remarks"])
    downtime = child("production_downtime", ["id", "shift_id", "shift_hrs", "dt_hrs", "dt_mins", "dt_reason"])
    waste = child("production_waste", ["id", "shift_id", "rs1a_kg", "rs1b_kg", "bf_kg", "rs23_kg",
                                       "rs5_kg", "trml1_kg", "trml2_kg", "grit_kg", "remarks"])
    electricity = db.read_rows("electricity_readings", since_date=since, since_column="reading_date",
                               columns=["id", "reading_date", "meter", "start_kwh", "end_kwh",
                                        "meter_multiplier", "remarks"])
    trucks = db.read_rows("truck_readings", since_date=since, since_column="reading_date",
                          columns=["id", "reading_date", "plate_no", "start_km", "end_km",
                                   "fuel_liters", "remarks"])
    return {"shifts": shifts, "runs": runs, "downtime": downtime, "waste": waste,
            "electricity": electricity, "trucks": trucks}


def snap_rc_movement_audit(db, since):
    rc_out = db.read_rows("rc_out", since_date=since, columns=["transaction_date", "weight_kg"])
    sums: dict[str, float] = {}
    for r in rc_out:
        d = str(r["transaction_date"])[:10]
        sums[d] = round(sums.get(d, 0.0) + float(r.get("weight_kg") or 0), 3)
    return {"rc_out_sums": sums}


SNAP = {
    "flecon": snap_flecon,
    "deliveries": snap_deliveries,
    "rc_out": snap_rc_out,
    "gsheet": snap_gsheet,
    "production": snap_production,
    "rc_movement_audit": snap_rc_movement_audit,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", required=True, choices=sorted(SNAP.keys()))
    ap.add_argument("--case", required=True)
    ap.add_argument("--since", required=True)
    args = ap.parse_args()
    db = DBClient()
    bundle = SNAP[args.type](db, args.since)
    out_dir = FIXTURES / args.type / "db_window"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{args.case}.json"
    out.write_text(json.dumps(bundle, indent=2, default=str))
    counts = {k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in bundle.items()}
    print(f"wrote {out}  ({counts})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
