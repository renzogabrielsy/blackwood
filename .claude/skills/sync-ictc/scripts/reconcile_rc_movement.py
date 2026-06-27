#!/usr/bin/env python3
"""
Reconciles PROPOSED DAILY REPORT block totals against RAW CHARCOAL MOVEMENT
daily totals AND against rc_out daily sums in the DB.

For each date where PROPOSED has data:
  P = sum of PROPOSED block_section.day_total_kg for that date
  M = RC MOVEMENT.raw_charcoal_fed_kls for that date (None if no row)
  O = SUM(rc_out.weight_kg) for that date (already-ingested DB data, optional)

Drift checks:
  abs(P - M) > tolerance_kg     -> flag "PROPOSED vs RC MOVEMENT drift"
  abs(P - O) > tolerance_kg     -> flag "PROPOSED vs existing rc_out drift"
                                   (only relevant for re-runs or partial ingestion)

DB-vs-RC-MOVEMENT DUPLICATION GATE (BUG-1 fix, see SKILL.md / LEARNING_LEDGER L-019):
  O_over_M = O - M, evaluated on EVERY date the DB already has rc_out rows for —
  NOT only the PROPOSED dates. If the DB's own per-date rc_out SUM (O) exceeds the
  RC MOVEMENT fed total (M) by more than tolerance, that is the signature of
  duplicated feedings already landed in the DB (e.g. the May 29–Jun 16 doubling).
  This must HALT (serious), because comparing the two operator reports to each
  other (P vs M) is blind to DB-side doubling. Pass --rc-out-sums-json so O is
  populated; the gate is skipped for dates with no DB rows or no M.
  An O *below* M is normal (continuous-flow tank; not every fed kg is ingested yet)
  and never trips the gate — only O materially ABOVE M does.

Output: human-readable + JSON drift report. Exit code reflects severity:
  0 = no drift
  1 = warnings but tolerable
  2 = serious drift (>500 kg or >5% relative, OR any DB-over-MOVEMENT duplication)

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

    # Walk every date present in PROPOSED *or* already in the DB rc_out sums, and
    # reconcile. Including DB-only dates is what makes the duplication gate work:
    # the doubled feedings (May 29–Jun 16) sit on SETTLED dates that the current
    # PROPOSED extract may no longer cover, so a PROPOSED-only walk is blind to them.
    drift_rows = []
    ok_rows = []
    max_drift_severity = 0  # 0=none, 1=warning, 2=serious

    all_dates = sorted(set(proposed_by_date.keys()) | set(rc_out_sums.keys()))

    for d in all_dates:
        P = round(proposed_by_date[d], 2) if d in proposed_by_date else None
        M = movement_date_to_fed.get(d)
        O = rc_out_sums.get(d)

        p_vs_m_drift = None
        p_vs_o_drift = None
        o_vs_m_excess = None  # DB rc_out SUM minus RC MOVEMENT (duplication signal)
        notes = []

        if P is not None:
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

        # DB-vs-RC-MOVEMENT DUPLICATION GATE — runs on every date the DB has rows for,
        # PROPOSED or not. Only a DB sum that EXCEEDS the fed total is a problem; a DB
        # sum below M is the normal continuous-flow lag, not duplication.
        if O is not None and M is not None:
            o_vs_m_excess = round(O - M, 2)
            if o_vs_m_excess > args.serious_drift_kg:
                notes.append(
                    f"SERIOUS DB-side DUPLICATION: rc_out DB SUM exceeds RC MOVEMENT by "
                    f"{o_vs_m_excess:+.0f} kg (O={O:.0f} > M={M:.0f}). Likely duplicated "
                    f"feedings already in the DB — do NOT write; investigate this date."
                )
                max_drift_severity = max(max_drift_severity, 2)
            elif o_vs_m_excess > args.tolerance_kg:
                notes.append(
                    f"DB rc_out SUM above RC MOVEMENT by {o_vs_m_excess:+.0f} kg "
                    f"(possible partial duplication) — review."
                )
                max_drift_severity = max(max_drift_severity, 1)

        entry = {
            "date": d,
            "proposed_sum_kg": P,
            "rc_movement_kg": M,
            "rc_out_existing_kg": O,
            "drift_p_vs_m_kg": p_vs_m_drift,
            "drift_p_vs_o_kg": p_vs_o_drift,
            "excess_o_vs_m_kg": o_vs_m_excess,
            "blocks": proposed_blocks_by_date.get(d, []),
            "notes": notes,
        }
        if notes:
            drift_rows.append(entry)
        else:
            ok_rows.append(entry)

    report = {
        "summary": {
            "total_dates": len(all_dates),
            "proposed_dates": len(proposed_by_date),
            "db_dates_checked": len(rc_out_sums),
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
