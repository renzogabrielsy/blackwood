#!/usr/bin/env python3
"""
sync_rc_out.py — lean two-phase orchestrator for PROPOSED DAILY REPORT → `rc_out`
(LEAN_SYNC_REFACTOR §3). Wraps extract_proposed_daily.py + extract_rc_movement.py +
reconcile_rc_movement.py + classify_rc_out.py. No diff rule is re-implemented.

Two HARD gates are baked in as Python HALTING conditions (see SYNC_EFFICIENCY_AUDIT §6):
  GATE 1 — PROPOSED-vs-RC-MOVEMENT >500 kg drift (reconcile pass 1, exit 2).
  GATE 2 — Step-9.5 DB-vs-RC-MOVEMENT duplication O>M (reconcile pass 2, exit 2).
When EITHER trips: ok=false, the gate is listed in gate_failures, and apply writes NOTHING.

CLI contract (SYNC_CLI_CONTRACT.md):
  python3 sync_rc_out.py --phase classify --json
  python3 sync_rc_out.py --phase apply --input <classified_path> --only-clean --json

Codified mechanical rules (trusted from the wrapped scripts + this orchestrator):
  * rounding / null↔0 → NOOP            — classify_rc_out.field_differences + norm_*.
  * L-019 full-span dedup + sub-watermark → flagged — classify_rc_out (--watermark passed).
  * L-020 idempotent insert (natural key) — apply, via lib.db.insert_if_absent.
  * >500 kg drift HARD gate (GATE 1)     — this orchestrator.
  * Step-9.5 O>M duplication HARD gate (GATE 2) — this orchestrator.
  * batch_code fallback prefixes         — extract_proposed_daily + classify_rc_out.resolve_batch_id.
  * never auto-create a batch            — UNMAPPED → held.
Stays JUDGMENT (→ held, never auto-written): UNMAPPED batch_code, L-002/L-003/L-010/L-011/L-012
overflow/continuation/reassignment/double-count rows (all surfaced as flagged), and any drift the
gate trips (agent explains; never auto-overrides).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR / "lib"))

from lib.db import DBClient  # noqa: E402
import lib.orchestrator_common as oc  # noqa: E402

REPORT_TYPE = "rc_out"
EXTRACT_PROP = str(SCRIPT_DIR / "extract_proposed_daily.py")
EXTRACT_RCM = str(SCRIPT_DIR / "extract_rc_movement.py")
RECONCILE = str(SCRIPT_DIR / "reconcile_rc_movement.py")
CLASSIFY = str(SCRIPT_DIR / "classify_rc_out.py")

RC_OUT_COLS = ["id", "transaction_date", "batch_id", "production_batch", "destination",
               "weight_kg", "block_loc", "remarks"]

CODIFIED_RULES = [
    "rounding-null-zero-noop", "L-019", "L-020", "rc_out-drift-gate-500kg",
    "rc_out-db-duplication-gate", "batch_code-fallback-prefixes", "never-auto-create-batch",
]

GMAIL_PROP = 'label:"Work/ICTC Daily" subject:"PROPOSED DAILY REPORT" after:{since} -label:"Blackwood-Processed"'
GMAIL_RCM = 'subject:"RC MOVEMENT" newer_than:7d -in:sent'


def _run_reconcile(work: Path, name: str, proposed: Path, movement: Path, sums: Path | None) -> tuple[int, dict]:
    out = work / name
    cmd = ["python3", RECONCILE, "--proposed-json", str(proposed), "--movement-json", str(movement),
           "--tolerance-kg", "50", "--serious-drift-kg", "500", "--output", str(out)]
    if sums:
        cmd += ["--rc-out-sums-json", str(sums)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.stderr:
        oc.log(proc.stderr.rstrip())
    return proc.returncode, json.loads(out.read_text())


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
    since = (date.fromisoformat(watermark) - timedelta(days=3)).isoformat() if watermark else "2025-01-01"
    since_gmail = since.replace("-", "/")

    # fetch PROPOSED + RC MOVEMENT
    oc.progress("fetch", "Checking Gmail for the daily feeding report…", pct=5)
    prop_fetch = oc.fetch_gmail(GMAIL_PROP.format(since=since_gmail), work / "prop")
    prop_xlsx, prop_email = oc.latest_xlsx(prop_fetch)
    if not prop_xlsx:
        oc.progress("finalize", "Nothing new today — no PROPOSED DAILY REPORT waiting.", pct=100)
        oc.emit(oc.classify_envelope(
            report_type=REPORT_TYPE, ok=True, gate_failures=[], counts={"noop": 0},
            rows_preview=[], classified_path="",
            source={"email_subject": None, "email_uid": None},
            watermark=watermark, codified_rules_applied=CODIFIED_RULES,
            extra={"note": "No PROPOSED DAILY REPORT email in window — nothing to ingest."}))
        return 0
    oc.progress("fetch", f"Found the report: {prop_email.get('subject') or 'PROPOSED DAILY REPORT'}", pct=15)
    oc.progress("fetch", "Checking Gmail for the movement cross-check sheet…", pct=20)
    rcm_fetch = oc.fetch_gmail(GMAIL_RCM, work / "rcm")
    rcm_xlsx, _ = oc.latest_xlsx(rcm_fetch)

    year = int(since[:4])
    oc.progress("extract", "Reading the daily feeding spreadsheet…", pct=28)
    proposed = oc.run_json(["python3", EXTRACT_PROP, "--file", prop_xlsx, "--year", str(year), "--all-sheets"])
    proposed_path = work / "extract_proposed.json"
    proposed_path.write_text(json.dumps(proposed, default=str))

    gate_failures: list[dict] = []
    reconcile_report = None
    if rcm_xlsx:
        oc.progress("reconcile", "Cross-checking feeding totals against the movement sheet…", pct=42)
        movement = oc.run_json(["python3", EXTRACT_RCM, "--file", rcm_xlsx, "--all-sheets"])
        movement_path = work / "extract_movement.json"
        movement_path.write_text(json.dumps(movement, default=str))

        # GATE 1 — PROPOSED vs RC MOVEMENT (>500 kg drift → exit 2)
        rc1, rep1 = _run_reconcile(work, "reconcile_p_vs_m.json", proposed_path, movement_path, None)
        reconcile_report = rep1
        if rc1 >= 2:
            gate_failures.append({"gate": "proposed_vs_movement_drift_500kg",
                                  "detail": f"{rep1['summary']['drift_dates']} drift date(s); serious >500kg — HALT, write nothing."})

        # GATE 2 — Step 9.5 DB-vs-RC-MOVEMENT duplication (O>M → exit 2)
        sums = _rc_out_sums(db, since)
        sums_path = work / "rc_out_sums.json"
        sums_path.write_text(json.dumps(sums, default=str))
        rc2, rep2 = _run_reconcile(work, "reconcile_db_dup.json", proposed_path, movement_path, sums_path)
        if rc2 >= 2:
            gate_failures.append({"gate": "db_vs_movement_duplication",
                                  "detail": "rc_out DB SUM exceeds RC MOVEMENT (O>M) on a settled date — suspected duplication; HALT."})
    else:
        oc.log("[warn] no RC MOVEMENT email — reconciliation gates skipped (cannot verify drift).")

    if gate_failures:
        oc.progress("reconcile", "Feeding totals disagree beyond tolerance — this run will not write.",
                    pct=52, level="warn")
    elif rcm_xlsx:
        oc.progress("reconcile", "Feeding totals reconcile — safe to proceed.", pct=52)

    # batch lookup (batch_code -> id) for classification
    oc.progress("classify", "Comparing the report against the database…", pct=58)
    batches = db.read_rows("batches", columns=["batch_code", "id"], since_column=None)
    lookup = {b["batch_code"]: b["id"] for b in batches if b.get("batch_code")}
    lookup_path = work / "batch_lookup.json"
    lookup_path.write_text(json.dumps(lookup, default=str))

    db_rows = db.read_rows("rc_out", since_date=since, columns=RC_OUT_COLS)
    db_path = work / "db_rows.json"
    db_path.write_text(json.dumps(db_rows, default=str))

    classified_path = work / "classified.json"
    cmd = ["python3", CLASSIFY, "--extract-json", str(proposed_path),
           "--batch-lookup-json", str(lookup_path), "--db-rows-json", str(db_path),
           "--output", str(classified_path)]
    if watermark:
        cmd += ["--watermark", watermark]
    oc.run_json(cmd)
    classified = json.loads(classified_path.read_text())
    s = classified["summary"]

    # If a HARD gate tripped, we STILL emit the classification (for review) but ok=false and
    # apply is instructed to write nothing (apply re-checks gate_failures in the compact file).
    gate_tripped = bool(gate_failures)

    compact = {
        "report_type": REPORT_TYPE, "since": since, "watermark": watermark,
        "gate_failures": gate_failures,
        "source": {"email_subject": prop_email.get("subject"), "email_uid": prop_email.get("uid"),
                   "email_thread_id": prop_email.get("thread_id")},
        "actionable": {
            "new": classified.get("new", []),
            "changed": classified.get("changed", []),
            "flagged": classified.get("flagged", []),
            "unmapped": classified.get("unmapped", []),
            "malformed": classified.get("malformed", []),
        },
        "batch_lookup": lookup,
    }
    compact_path = work / "decisions_rc_out.json"
    compact_path.write_text(json.dumps(compact, indent=2, default=str))

    preview = ([{"action": "INSERT", "natural_key": f"{i['row'].get('transaction_date')}|{i['row'].get('batch_code_resolved')}|{i['row'].get('destination') or 'MAIN'}",
                 "summary": f"{i['row'].get('weight_kg')}kg"} for i in classified.get("new", [])]
               + [{"action": "FLAGGED", "natural_key": f.get("index"), "summary": f.get("reason")}
                  for f in classified.get("flagged", []) + classified.get("unmapped", [])])

    _flag = s["flagged_count"] + s["unmapped_count"] + s["malformed_count"]
    oc.progress("classify",
                f"{s['noop_count']} already recorded · {s['new_count']} new · {s['changed_count']} changed"
                + (f" · {_flag} to review" if _flag else ""),
                pct=90)
    if gate_tripped:
        oc.progress("finalize", "Review ready — a safety check tripped, so apply will write nothing.",
                    pct=100, level="warn")
    else:
        oc.progress("finalize", "Review ready — nothing written yet.", pct=100)

    oc.emit(oc.classify_envelope(
        report_type=REPORT_TYPE, ok=not gate_tripped, gate_failures=gate_failures,
        counts={"noop": s["noop_count"], "insert": s["new_count"], "update": s["changed_count"],
                "flagged": s["flagged_count"] + s["unmapped_count"] + s["malformed_count"]},
        rows_preview=preview, classified_path=str(compact_path),
        source={"email_subject": prop_email.get("subject"), "email_uid": prop_email.get("uid")},
        watermark=watermark, codified_rules_applied=CODIFIED_RULES,
        extra={"reconcile_summary": (reconcile_report or {}).get("summary")},
    ))
    return 0


def _prov(index, extra=""):
    base = (f"provenance=rc_out-sync | Ingested by sync_rc_out.py (lean orchestrator) "
            f"row {index} on {oc.RUN_TS}.")
    return base + (f" {extra}" if extra else "")


def phase_apply(args) -> int:
    compact = json.loads(Path(args.input).read_text())
    db = DBClient()
    held: list[dict] = []
    errors: list[str] = []

    # HARD gate: if a gate tripped in classify, apply NOTHING.
    gate_failures = compact.get("gate_failures", [])
    if gate_failures:
        oc.progress("finalize", "A safety check tripped earlier — writing nothing.", pct=100, level="warn")
        oc.emit(oc.apply_envelope(
            report_type=REPORT_TYPE, ok=False,
            held=[{"reason": g["gate"], "natural_key": None, "detail": g["detail"]} for g in gate_failures],
            errors=[f"HARD gate tripped: {g['gate']} — nothing written." for g in gate_failures],
            extra={"gate_failures": gate_failures}))
        return 1

    inserts = updates = 0
    _new_rows = compact["actionable"]["new"]
    _chg_rows = compact["actionable"]["changed"]
    _total_writes = max(1, len(_new_rows) + len(_chg_rows))
    _write_batch = max(1, -(-_total_writes // 10))
    _done = 0
    oc.progress("apply", f"Writing {len(_new_rows)} new and {len(_chg_rows)} changed feeding row(s)…", pct=10)

    # NEW → INSERT rc_out (idempotent, L-020), manual audit via RPC (no audit trigger).
    for item in compact["actionable"]["new"]:
        r = item["row"]
        if not r.get("batch_id"):
            held.append({"reason": "unresolved_batch_id", "natural_key": item.get("index"),
                         "detail": "NEW rc_out without resolved batch_id"})
            continue
        payload = {
            "transaction_date": r["transaction_date"], "batch_id": r["batch_id"],
            "destination": r.get("destination") or "MAIN", "weight_kg": r["weight_kg"],
            "remarks": r.get("remarks"), "block_loc": r.get("block_loc"),
            "production_batch": r.get("production_batch"),
        }
        try:
            res = db.insert_if_absent("rc_out", [payload], natural_key=("transaction_date", "batch_id", "destination"))
            if res["inserted_count"] == 0:
                held.append({"reason": "already_exists", "natural_key": item.get("index"),
                             "detail": "idempotent skip (natural key already in DB)"})
                continue
            new_id = res["inserted"][0]["id"]
            inserts += 1
            db.insert_manual_audit(table_name="rc_out", record_id=new_id, operation="INSERT",
                                   comment=_prov(item.get("index")), snapshot=payload)
            _done += 1
            if _done % _write_batch == 0 or _done == _total_writes:
                oc.progress("apply", f"Writing {_done} of {_total_writes} — {r.get('weight_kg')}kg fed {r['transaction_date']}",
                            pct=10 + int(75 * _done / _total_writes))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"insert row {item.get('index')}: {exc}")

    # VALUE_CHANGED → UPDATE, manual audit.
    for c in compact["actionable"]["changed"]:
        try:
            patch = {d["field"]: d.get("emailValue") if "emailValue" in d else d.get("sheetValue")
                     for d in c.get("diff", [])}
            if not patch:
                continue
            db.update("rc_out", {"id": f"eq.{c['db_row']['id']}"}, patch, returning="minimal")
            updates += 1
            _done += 1
            if _done % _write_batch == 0 or _done == _total_writes:
                oc.progress("apply", f"Writing {_done} of {_total_writes} — updating a feeding row",
                            pct=10 + int(75 * _done / _total_writes))
            diff_json = {d["field"]: {"old": d.get("dbValue"), "new": d.get("emailValue")} for d in c["diff"]}
            db.insert_manual_audit(table_name="rc_out", record_id=c["db_row"]["id"], operation="UPDATE",
                                   comment=_prov(c.get("index"), "UPDATE"), diff=diff_json)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"update {c.get('index')}: {exc}")

    # flagged / unmapped / malformed → never auto-written under --only-clean.
    for bucket, reason in (("flagged", "flagged"), ("unmapped", "unmapped_batch_code"), ("malformed", "malformed")):
        for f in compact["actionable"].get(bucket, []):
            held.append({"reason": reason, "natural_key": f.get("index"),
                         "detail": f.get("reason") or "requires human decision — never auto-written"})

    watermark_updated = labeled = False
    if not errors:
        oc.progress("apply", "Updating the audit trail…", pct=90)
        watermark_updated = oc.upsert_ingestion_watermark(
            db, REPORT_TYPE, last_email_id=compact.get("source", {}).get("email_thread_id"))
        if not args.no_label:
            uid = compact.get("source", {}).get("email_uid")
            if uid:
                oc.progress("apply", "Marking the email as processed…", pct=95)
                labeled = oc.mark_processed([uid])

    if errors:
        oc.progress("finalize", f"Finished with {len(errors)} problem(s) — see details.", pct=100, level="warn")
    elif inserts or updates:
        oc.progress("finalize", f"Done — {inserts} new, {updates} updated.", pct=100)
    else:
        oc.progress("finalize", "Done — nothing new to write.", pct=100)

    oc.emit(oc.apply_envelope(
        report_type=REPORT_TYPE, ok=not errors, inserts=inserts, updates=updates,
        held=held, labeled=labeled, watermark_updated=watermark_updated, errors=errors))
    return 0 if not errors else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Lean two-phase rc_out sync orchestrator.")
    ap.add_argument("--phase", required=True, choices=["classify", "apply"])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--input")
    ap.add_argument("--only-clean", action="store_true")
    ap.add_argument("--no-label", action="store_true")
    ap.add_argument("--work-dir")
    args = ap.parse_args()
    if args.phase == "classify":
        return phase_classify(args)
    if not args.input:
        oc.emit({"report_type": REPORT_TYPE, "ok": False, "errors": ["--input required for apply"]})
        return 2
    return phase_apply(args)


if __name__ == "__main__":
    sys.exit(main())
