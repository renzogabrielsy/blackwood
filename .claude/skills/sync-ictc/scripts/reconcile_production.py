#!/usr/bin/env python3
"""
Production reconciliation — a MONITORING report, NOT a write gate.

CRITICAL DESIGN CONTRACT (PRODUCTION_DESIGN.md Section 8):
  Unlike `reconcile_rc_movement.py`, which HARD-halts on PROPOSED-vs-RC-MOVEMENT
  drift (those two files record the same day's events and SHOULD match), this
  reconciler is purely informational. The RC IN -> RC OUT -> (production + waste)
  flow does NOT balance per day: raw charcoal sits in the feed tank for days and
  only reconciles at month-end when the tank is emptied. Daily drift is EXPECTED
  and is NOT a data-quality signal.

  Therefore this tool ALWAYS exits 0 by default. An optional `--strict` flag may
  return a nonzero exit code, but ONLY when a hard internal ARITHMETIC check
  fails — never on the inventory-in-transit drift. The arithmetic checks are:
    1. Runs day-total: sum(runs.ttl_kg) per date vs the extractor's
       summary.day_totals[date] (the G13 sheet total).
    2. Waste internal: the waste extractor's summary.recon_mismatches
       (summed per-stream kg vs the reported TOTAL WASTE).
  The production-vs-rc_out drift is ALWAYS informational and NEVER affects the
  exit code, even under --strict.

Checks (all reported; only the two arithmetic ones can gate under --strict):
  - Runs day-total check  (arithmetic, gateable under --strict)
  - Waste internal check  (arithmetic, gateable under --strict)
  - Production-vs-rc_out daily drift (informational ONLY — feed-tank trend)

Usage:
    python3 reconcile_production.py \\
        --prod-extract-json /tmp/.../out_mc.json \\
        [--waste-extract-json /tmp/.../out_ivy.json] \\
        [--rc-out-sums-json /tmp/.../rc_out_daily_sums.json] \\
        --output /tmp/.../reconcile_production.json \\
        [--strict]

  --prod-extract-json : MC extractor output (reads `runs[]` + `summary.day_totals`)
  --waste-extract-json: Ivy extractor output (reads `waste[]` + `summary.recon_mismatches`) — optional
  --rc-out-sums-json  : [{transaction_date, total_kg}] or {date: total_kg} — optional, informational only
  --strict            : allow a nonzero exit ONLY on a hard arithmetic mismatch (default OFF)

Exit codes:
    0 = success (ALWAYS, unless --strict AND an arithmetic check failed)
    1 = (only with --strict) a runs day-total or waste internal arithmetic mismatch was found
    3 = required input file not found / unreadable
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


# Tolerances
DAY_TOTAL_TOLERANCE_KG = 1.0   # runs sum vs G13 sheet total
RC_OUT_DRIFT_TOLERANCE_KG = 0.01  # below this, treat as zero drift (display only)

NOTE = (
    "Daily kg-in vs kg-out drift is EXPECTED, not an error: the feed tank is "
    "continuous-flow and only balances at month-end when emptied. The "
    "production-vs-rc_out drift below is INFORMATIONAL and never gates writes. "
    "Only the runs day-total and waste internal checks are hard arithmetic checks "
    "(gateable with --strict)."
)


def load_rc_out_sums(path_str: str | None) -> dict[str, float]:
    """Accept either {date: total} or [{transaction_date, total_kg}]; unwrap json_agg."""
    if not path_str:
        return {}
    p = Path(path_str).expanduser()
    if not p.exists():
        return {}
    raw = json.loads(p.read_text())
    if isinstance(raw, list) and len(raw) == 1 and isinstance(raw[0], dict) and "data" in raw[0]:
        raw = raw[0]["data"] or []
    sums: dict[str, float] = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            try:
                sums[k] = float(v)
            except (TypeError, ValueError):
                continue
    elif isinstance(raw, list):
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            d = entry.get("transaction_date") or entry.get("date")
            t = entry.get("total_kg")
            if t is None:
                t = entry.get("sum")
            if t is None:
                t = entry.get("weight_kg")
            if d is not None and t is not None:
                try:
                    sums[d] = float(t)
                except (TypeError, ValueError):
                    continue
    return sums


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Informational production reconciliation report (never gates by default)."
    )
    parser.add_argument("--prod-extract-json", required=True,
                        help="MC extractor output; reads runs[] + summary.day_totals")
    parser.add_argument("--waste-extract-json",
                        help="Ivy extractor output; reads waste[] + summary.recon_mismatches (optional)")
    parser.add_argument("--rc-out-sums-json",
                        help="rc_out daily sums [{transaction_date,total_kg}] or {date:total} (optional)")
    parser.add_argument("--output", required=True, help="Where to write the drift report JSON")
    parser.add_argument("--strict", action="store_true",
                        help="Allow nonzero exit ONLY on a hard arithmetic mismatch (default OFF)")
    args = parser.parse_args()

    prod_path = Path(args.prod_extract_json).expanduser()
    output_path = Path(args.output).expanduser()

    if not prod_path.exists():
        sys.stderr.write(json.dumps({"error": f"prod-extract file not found: {prod_path}"}) + "\n")
        return 3

    try:
        prod = json.loads(prod_path.read_text())
    except json.JSONDecodeError as e:
        sys.stderr.write(json.dumps({"error": f"JSON parse error (prod): {e}"}) + "\n")
        return 3

    waste = None
    if args.waste_extract_json:
        wp = Path(args.waste_extract_json).expanduser()
        if not wp.exists():
            sys.stderr.write(json.dumps({"error": f"waste-extract file not found: {wp}"}) + "\n")
            return 3
        try:
            waste = json.loads(wp.read_text())
        except json.JSONDecodeError as e:
            sys.stderr.write(json.dumps({"error": f"JSON parse error (waste): {e}"}) + "\n")
            return 3

    rc_out_sums = load_rc_out_sums(args.rc_out_sums_json)

    checks: list[dict] = []

    # ------------------------------------------------------------------
    # CHECK 1 — Runs day-total (ARITHMETIC, gateable under --strict)
    #   sum(runs.ttl_kg) per date  vs  summary.day_totals[date] (G13)
    # ------------------------------------------------------------------
    runs_by_date: dict[str, float] = defaultdict(float)
    for r in prod.get("runs", []) or []:
        d = r.get("transaction_date")
        if not d:
            continue
        try:
            runs_by_date[d] += float(r.get("ttl_kg") or 0)
        except (TypeError, ValueError):
            continue

    day_totals = (prod.get("summary", {}) or {}).get("day_totals", {}) or {}

    day_total_mismatches: list[dict] = []
    all_dates = sorted(set(runs_by_date.keys()) | set(day_totals.keys()))
    for d in all_dates:
        runs_sum = round(runs_by_date.get(d, 0.0), 2)
        sheet_total = day_totals.get(d)
        if sheet_total is None:
            # No G13 total to compare against — informational gap, not an arithmetic failure.
            day_total_mismatches.append({
                "date": d,
                "runs_sum_kg": runs_sum,
                "sheet_day_total_kg": None,
                "drift_kg": None,
                "reason": "no summary.day_totals entry for this date",
            })
            continue
        try:
            sheet_total_f = float(sheet_total)
        except (TypeError, ValueError):
            day_total_mismatches.append({
                "date": d,
                "runs_sum_kg": runs_sum,
                "sheet_day_total_kg": sheet_total,
                "drift_kg": None,
                "reason": "non-numeric summary.day_totals entry",
            })
            continue
        drift = round(runs_sum - sheet_total_f, 2)
        if abs(drift) > DAY_TOTAL_TOLERANCE_KG:
            day_total_mismatches.append({
                "date": d,
                "runs_sum_kg": runs_sum,
                "sheet_day_total_kg": round(sheet_total_f, 2),
                "drift_kg": drift,
                "reason": f"runs sum differs from sheet G13 total by {drift:+.2f} kg",
            })

    runs_arith_failed = any(m.get("drift_kg") is not None for m in day_total_mismatches)
    checks.append({
        "check": "runs_day_total",
        "kind": "arithmetic",
        "gateable": True,
        "dates_compared": len(all_dates),
        "mismatch_count": len(day_total_mismatches),
        "hard_arithmetic_failure": runs_arith_failed,
        "tolerance_kg": DAY_TOTAL_TOLERANCE_KG,
    })

    # ------------------------------------------------------------------
    # CHECK 2 — Waste internal (ARITHMETIC, gateable under --strict)
    #   re-surface waste extractor's summary.recon_mismatches
    # ------------------------------------------------------------------
    waste_mismatches: list[dict] = []
    waste_present = waste is not None
    if waste_present:
        waste_mismatches = list((waste.get("summary", {}) or {}).get("recon_mismatches", []) or [])
    # A recon_mismatch with a numeric `reported` that disagrees with `summed` is a
    # real arithmetic failure. Entries with reported=None are gaps, not failures.
    waste_arith_failed = any(m.get("reported") is not None for m in waste_mismatches)
    checks.append({
        "check": "waste_internal",
        "kind": "arithmetic",
        "gateable": True,
        "present": waste_present,
        "mismatch_count": len(waste_mismatches),
        "hard_arithmetic_failure": waste_arith_failed,
        "source": "waste extractor summary.recon_mismatches",
    })

    # ------------------------------------------------------------------
    # CHECK 3 — Production vs rc_out daily drift (INFORMATIONAL ONLY)
    #   per date: (sum runs.ttl_kg + sum waste streams) vs rc_out total_kg
    #   NEVER affects the exit code, even under --strict.
    # ------------------------------------------------------------------
    waste_by_date: dict[str, float] = defaultdict(float)
    if waste_present:
        for w in waste.get("waste", []) or []:
            d = w.get("transaction_date")
            if not d:
                continue
            streams = ("rs1a_kg", "rs1b_kg", "bf_kg", "rs23_kg",
                       "rs5_kg", "trml1_kg", "trml2_kg", "grit_kg")
            s = 0.0
            for k in streams:
                try:
                    s += float(w.get(k) or 0)
                except (TypeError, ValueError):
                    pass
            waste_by_date[d] += s

    rc_out_drift: list[dict] = []
    if rc_out_sums:
        drift_dates = sorted(set(runs_by_date.keys())
                             | set(waste_by_date.keys())
                             | set(rc_out_sums.keys()))
        for d in drift_dates:
            prod_kg = round(runs_by_date.get(d, 0.0), 2)
            waste_kg = round(waste_by_date.get(d, 0.0), 2)
            out_kg = rc_out_sums.get(d)
            if out_kg is None:
                continue
            out_kg = round(float(out_kg), 2)
            drift = round((prod_kg + waste_kg) - out_kg, 2)
            rc_out_drift.append({
                "date": d,
                "total_production_kg": prod_kg,
                "total_waste_kg": waste_kg,
                "rc_out_total_kg": out_kg,
                "drift_kg": drift,
                "label": "INFORMATIONAL — feed-tank-in-transit, never a failure",
            })
    checks.append({
        "check": "production_vs_rc_out",
        "kind": "informational",
        "gateable": False,
        "present": bool(rc_out_sums),
        "dates_compared": len(rc_out_drift),
        "note": "expected nonzero; monitors feed-tank fill, never gates",
    })

    # ------------------------------------------------------------------
    # Severity + exit decision
    # ------------------------------------------------------------------
    hard_arithmetic_failure = runs_arith_failed or waste_arith_failed
    if hard_arithmetic_failure:
        max_severity = "arithmetic_mismatch"
    elif day_total_mismatches or waste_mismatches:
        # Gaps (missing totals) — worth surfacing but not a failure.
        max_severity = "info_gap"
    else:
        max_severity = "ok"

    report = {
        "checks": checks,
        "day_total_mismatches": day_total_mismatches,
        "waste_mismatches": waste_mismatches,
        "rc_out_drift": rc_out_drift,
        "max_severity": max_severity,
        "hard_arithmetic_failure": hard_arithmetic_failure,
        "strict": bool(args.strict),
        "note": NOTE,
        "summary": {
            "runs_day_total_mismatches": len(day_total_mismatches),
            "runs_arithmetic_failure": runs_arith_failed,
            "waste_mismatches": len(waste_mismatches),
            "waste_arithmetic_failure": waste_arith_failed,
            "rc_out_drift_dates": len(rc_out_drift),
        },
    }
    output_path.write_text(json.dumps(report, indent=2, default=str))

    # Exit code: 0 by default ALWAYS. Only --strict + a hard arithmetic failure -> 1.
    exit_code = 1 if (args.strict and hard_arithmetic_failure) else 0

    print(json.dumps({
        "ok": True,                       # the tool ran successfully regardless of drift
        "max_severity": max_severity,
        "hard_arithmetic_failure": hard_arithmetic_failure,
        "strict": bool(args.strict),
        "exit_code": exit_code,
        "summary": report["summary"],
        "output_path": str(output_path),
    }))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
