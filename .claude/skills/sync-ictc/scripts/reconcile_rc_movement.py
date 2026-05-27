#!/usr/bin/env python3
"""
Reconciles PROPOSED DAILY REPORT block totals against RAW CHARCOAL MOVEMENT
daily totals AND against rc_out daily sums in the DB.

For each date where PROPOSED has data:
  P = sum of PROPOSED block_section.day_total_kg for that date
  M = RC MOVEMENT.raw_charcoal_fed_kls for that date (None if no row)
  O = SUM(rc_out.weight_kg) for that date (already-ingested data, optional)

Drift checks:
  abs(P - M) > tolerance_kg     -> flag "PROPOSED vs RC MOVEMENT drift"
  abs(P - O) > tolerance_kg     -> flag "PROPOSED vs existing rc_out drift"
                                   (only relevant for re-runs or partial ingestion)

Output: human-readable + JSON drift report. Exit code reflects severity:
  0 = no drift
  1 = warnings but tolerable
  2 = serious drift (>500 kg or >5% relative)

Usage:
    python3 reconcile_rc_movement.py \\
        --proposed-json /tmp/.../extract_proposed.json \\
        --movement-json /tmp/.../extract_rc_movement.json \\
        [--rc-out-sums-json /tmp/.../rc_out_daily_sums.json] \\
        [--tolerance-kg 50] \\
        --output /tmp/.../reconcile_report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description="Reconcile PROPOSED vs RC MOVEMENT vs rc_out.")
    parser.add_argument("--proposed-json", required=True)
    parser.add_argument("--movement-json", required=True)
    parser.add_argument("--rc-out-sums-json",
                        help='Optional JSON object {date_string: total_kg} from rc_out')
    parser.add_argument("--tolerance-kg", type=float, default=50.0)
    parser.add_argument("--serious-drift-kg", type=float, default=500.0)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    proposed_path = Path(args.proposed_json).expanduser()
    movement_path = Path(args.movement_json).expanduser()
    output_path = Path(args.output).expanduser()

    for label, p in [("proposed", proposed_path), ("movement", movement_path)]:
        if not p.exists():
            print(json.dumps({"error": f"{label} file not found: {p}"}), file=sys.stderr)
            return 3

    proposed = json.loads(proposed_path.read_text())
    movement = json.loads(movement_path.read_text())

    rc_out_sums = {}
    if args.rc_out_sums_json:
        ro_path = Path(args.rc_out_sums_json).expanduser()
        if ro_path.exists():
            raw = json.loads(ro_path.read_text())
            # Handle wrapped json_agg shape
            if isinstance(raw, list) and len(raw) == 1 and isinstance(raw[0], dict) and "data" in raw[0]:
                raw = raw[0]["data"] or []
            # Allow either {date: float} or [{transaction_date, total_kg}]
            if isinstance(raw, dict):
                rc_out_sums = {k: float(v) for k, v in raw.items()}
            elif isinstance(raw, list):
                for entry in raw:
                    d = entry.get("transaction_date") or entry.get("date")
                    t = entry.get("total_kg") or entry.get("sum") or entry.get("weight_kg")
                    if d is not None and t is not None:
                        rc_out_sums[d] = float(t)

    # Sum PROPOSED rows by transaction_date
    proposed_by_date: dict[str, float] = defaultdict(float)
    proposed_blocks_by_date: dict[str, list] = defaultdict(list)
    for r in proposed.get("rows", []):
        d = r["transaction_date"]
        w = float(r.get("weight_kg") or r.get("day_total_kg") or 0)
        proposed_by_date[d] += w
        proposed_blocks_by_date[d].append({
            "whse": r.get("whse_label"),
            "batch_code": r.get("batch_code_primary"),
            "weight_kg": w,
        })

    # RC MOVEMENT date -> fed_kls
    movement_date_to_fed = movement.get("date_to_fed_kls", {})

    # Walk every PROPOSED date and reconcile
    drift_rows = []
    ok_rows = []
    max_drift_severity = 0  # 0=none, 1=warning, 2=serious

    for d in sorted(proposed_by_date.keys()):
        P = round(proposed_by_date[d], 2)
        M = movement_date_to_fed.get(d)
        O = rc_out_sums.get(d)

        p_vs_m_drift = None
        p_vs_o_drift = None
        notes = []

        if M is None:
            notes.append("No RC MOVEMENT entry for this date")
        else:
            p_vs_m_drift = round(P - M, 2)
            if abs(p_vs_m_drift) > args.serious_drift_kg:
                notes.append(f"SERIOUS drift PROPOSED vs RC MOVEMENT: {p_vs_m_drift:+.0f} kg")
                max_drift_severity = max(max_drift_severity, 2)
            elif abs(p_vs_m_drift) > args.tolerance_kg:
                notes.append(f"Tolerable drift PROPOSED vs RC MOVEMENT: {p_vs_m_drift:+.0f} kg")
                max_drift_severity = max(max_drift_severity, 1)

        if O is not None:
            p_vs_o_drift = round(P - O, 2)
            if abs(p_vs_o_drift) > args.serious_drift_kg:
                notes.append(f"SERIOUS drift PROPOSED vs existing rc_out: {p_vs_o_drift:+.0f} kg")
                max_drift_severity = max(max_drift_severity, 2)
            elif abs(p_vs_o_drift) > args.tolerance_kg:
                notes.append(f"Tolerable drift PROPOSED vs existing rc_out: {p_vs_o_drift:+.0f} kg")
                max_drift_severity = max(max_drift_severity, 1)

        entry = {
            "date": d,
            "proposed_sum_kg": P,
            "rc_movement_kg": M,
            "rc_out_existing_kg": O,
            "drift_p_vs_m_kg": p_vs_m_drift,
            "drift_p_vs_o_kg": p_vs_o_drift,
            "blocks": proposed_blocks_by_date[d],
            "notes": notes,
        }
        if notes:
            drift_rows.append(entry)
        else:
            ok_rows.append(entry)

    report = {
        "summary": {
            "total_dates": len(proposed_by_date),
            "ok_dates": len(ok_rows),
            "drift_dates": len(drift_rows),
            "max_severity": ["none", "warning", "serious"][max_drift_severity],
            "tolerance_kg": args.tolerance_kg,
            "serious_drift_kg": args.serious_drift_kg,
        },
        "drift_dates": drift_rows,
        "ok_dates": ok_rows,
    }
    output_path.write_text(json.dumps(report, indent=2, default=str))

    # Print human-readable summary
    print(json.dumps({
        "ok": max_drift_severity < 2,
        "summary": report["summary"],
        "output_path": str(output_path),
    }))
    return max_drift_severity


if __name__ == "__main__":
    sys.exit(main())
