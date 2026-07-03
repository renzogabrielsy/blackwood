#!/usr/bin/env python3
"""
audit_rc_movement.py — the RC MOVEMENT read-only auditor (LEAN_SYNC_REFACTOR §5).

CLASSIFY-ONLY. There is NO apply phase and this script NEVER writes to the DB and
NEVER labels Gmail. It is the watchdog, not the worker.

What it does (all in Python, rows never enter an agent context):
  1. Fetch the latest "RC MOVEMENT" email attachment (RAW CHARCOAL MOVEMENT xlsx).
  2. Extract its date -> fed_kls totals (extract_rc_movement.py).
  3. Fetch rc_out daily sums for the same window via lib/db.py.
  4. Run reconcile_rc_movement.py comparing RC MOVEMENT (reference) vs rc_out (actual):
       - a "proposed" file built from rc_out sums so the reconciler compares rc_out vs
         RC MOVEMENT, AND rc_out sums passed so the DB-duplication (O>M) signal fires.
  5. Emit the CLI classify envelope. `ok=false` ONLY when the reconciler reports
     SERIOUS drift (severity 2); warnings keep ok=true (informational).

Because there is no apply phase, `--phase apply` is rejected. The contract's
`counts`/`rows_preview` describe DISCREPANCIES, not writes:
  counts = {noop: agreeing_dates, insert:0, update:0, flagged: drift_dates}
  rows_preview = up to 20 drift dates.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR / "lib"))

from lib.db import DBClient  # noqa: E402
import lib.orchestrator_common as oc  # noqa: E402

REPORT_TYPE = "rc_movement_audit"
EXTRACT_RCM = str(SCRIPT_DIR / "extract_rc_movement.py")
RECONCILE = str(SCRIPT_DIR / "reconcile_rc_movement.py")

# RC MOVEMENT is a cross-check; the auditor codifies the reconciliation math + the
# two safety signals it interprets. (It never writes, so these are read-only checks.)
CODIFIED_RULES = ["reconcile-drift-math", "L-019", "L-024"]

GMAIL_QUERY = 'subject:"RC MOVEMENT" newer_than:7d -in:sent'


def _rc_out_sums(db: DBClient, since: str) -> dict[str, float]:
    rows = db.read_rows("rc_out", since_date=since, columns=["transaction_date", "weight_kg"])
    sums: dict[str, float] = {}
    for r in rows:
        d = str(r.get("transaction_date"))[:10]
        try:
            sums[d] = sums.get(d, 0.0) + float(r.get("weight_kg") or 0)
        except (TypeError, ValueError):
            continue
    return {k: round(v, 2) for k, v in sums.items()}


def phase_classify(args) -> int:
    work = oc.make_work_dir(REPORT_TYPE, args.work_dir)
    db = DBClient()

    watermark = oc.data_watermark(db, "rc_out")
    # audit window: default = last 30 days of data (auditor looks back further than a writer).
    if args.since:
        since = args.since
    elif watermark:
        since = (date.fromisoformat(watermark) - timedelta(days=30)).isoformat()
    else:
        since = "2025-01-01"

    # 1. fetch RC MOVEMENT
    fetch = oc.fetch_gmail(GMAIL_QUERY, work / "gmail")
    xlsx, email_meta = oc.latest_xlsx(fetch)
    if not xlsx:
        oc.emit(oc.classify_envelope(
            report_type=REPORT_TYPE, ok=True,
            gate_failures=[], counts={"noop": 0, "flagged": 0},
            rows_preview=[], classified_path="",
            source={"email_subject": None, "email_uid": None},
            watermark=watermark, codified_rules_applied=CODIFIED_RULES,
            extra={"note": "No RC MOVEMENT email found in window — nothing to audit."},
        ))
        return 0

    # 2. extract movement totals
    movement_json = work / "movement.json"
    ext = oc.run_json(["python3", EXTRACT_RCM, "--file", xlsx, "--all-sheets"])
    movement_json.write_text(json.dumps(ext, default=str))

    # 3. rc_out daily sums (never enters agent context)
    sums = _rc_out_sums(db, since)
    sums_path = work / "rc_out_sums.json"
    sums_path.write_text(json.dumps(sums, default=str))

    # A "proposed" built from rc_out sums so the reconciler compares rc_out vs RC MOVEMENT.
    proposed = {"rows": [{"transaction_date": d, "weight_kg": v} for d, v in sums.items()]}
    proposed_path = work / "proposed_from_rc_out.json"
    proposed_path.write_text(json.dumps(proposed, default=str))

    # 4. reconcile — returns exit code 0/1/2 (none/warning/serious)
    recon_out = work / "reconcile.json"
    import subprocess
    rc = subprocess.run(
        ["python3", RECONCILE,
         "--proposed-json", str(proposed_path),
         "--movement-json", str(movement_json),
         "--rc-out-sums-json", str(sums_path),
         "--output", str(recon_out)],
        capture_output=True, text=True,
    )
    if rc.stderr:
        oc.log(rc.stderr.rstrip())
    severity = rc.returncode  # 0/1/2
    report = json.loads(recon_out.read_text())
    drift = report.get("drift_dates", [])
    ok_dates = report.get("ok_dates", [])

    preview = [{
        "action": "DRIFT",
        "natural_key": d.get("date"),
        "summary": (f"movement={d.get('rc_movement_kg')} rc_out={d.get('rc_out_existing_kg')} "
                    f"p_vs_m={d.get('drift_p_vs_m_kg')} excess_o_vs_m={d.get('excess_o_vs_m_kg')} "
                    f"| {'; '.join(d.get('notes', []))}"),
    } for d in drift]

    oc.emit(oc.classify_envelope(
        report_type=REPORT_TYPE,
        ok=(severity < 2),
        gate_failures=([{"gate": "rc_movement_serious_drift",
                         "detail": f"{report['summary']['drift_dates']} drift date(s); max_severity=serious"}]
                       if severity >= 2 else []),
        counts={"noop": len(ok_dates), "insert": 0, "update": 0, "flagged": len(drift)},
        rows_preview=preview,
        classified_path=str(recon_out),
        source={"email_subject": email_meta.get("subject"), "email_uid": email_meta.get("uid")},
        watermark=watermark,
        codified_rules_applied=CODIFIED_RULES,
        extra={"severity": ["none", "warning", "serious"][severity], "audit_since": since},
    ))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="RC MOVEMENT read-only auditor (classify-only).")
    ap.add_argument("--phase", required=True, choices=["classify"],
                    help="Only 'classify' is valid — this auditor never writes.")
    ap.add_argument("--json", action="store_true", help="(Contract flag; output is always JSON.)")
    ap.add_argument("--since", help="Override audit window start (YYYY-MM-DD).")
    ap.add_argument("--work-dir")
    args = ap.parse_args()

    if args.phase != "classify":
        oc.emit({"report_type": REPORT_TYPE, "ok": False,
                 "gate_failures": [{"gate": "read_only",
                                    "detail": "audit_rc_movement has no apply phase — it never writes."}]})
        return 2
    return phase_classify(args)


if __name__ == "__main__":
    sys.exit(main())
