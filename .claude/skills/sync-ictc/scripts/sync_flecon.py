#!/usr/bin/env python3
"""
sync_flecon.py — lean two-phase orchestrator for FLECON BAGGED → `flecon_bag_movements`
(REPLACE-BY-DATE model). Wraps extract_flecon_bags.py + classify_flecon_bags.py.

APPLY model = REPLACE-BY-DATE, bounded `>= since`: for each NEW / DATE_CHANGED date in the
tail window, DELETE that date's movements then re-INSERT the sheet's current movements for
that date, and write ONE manual audit row per replaced date. Settled history below the
window is NEVER touched. Re-running a date reproduces exactly the same rows (idempotent).

Unmapped / missing columns are FLAGGED, never auto-created and never dropped — a candidate
NEW bag type must be registered by a human (same posture as an unmapped batch).

CLI contract (SYNC_CLI_CONTRACT.md):
  python3 sync_flecon.py --phase classify --json
  python3 sync_flecon.py --phase apply --input <classified_path> --only-clean --json

Codified mechanical rules:
  * REPLACE-BY-DATE bounded >= since        — this orchestrator + classify_flecon_bags.
  * day-set diff → NOOP when multiset equal  — classify_flecon_bags (day_multiset).
  * column mapping by header signature       — extract_flecon_bags (registry-driven).
  * unmapped/missing column → FLAGGED        — classify_flecon_bags.column_flags.
  * never auto-create a bag type / drop data — this orchestrator (unmapped → held).
Stays JUDGMENT (→ held): registering a candidate NEW bag type; acknowledging a
removed/renamed column; the INFORMATIONAL balance cross-check never gates.
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

REPORT_TYPE = "flecon"
EXTRACT = str(SCRIPT_DIR / "extract_flecon_bags.py")
CLASSIFY = str(SCRIPT_DIR / "classify_flecon_bags.py")

CODIFIED_RULES = [
    "replace-by-date-bounded-since", "day-set-multiset-noop", "column-header-signature-map",
    "unmapped-column-flagged", "never-auto-create-bag-type",
]

GMAIL = 'from:edilloivymae306ictc@gmail.com subject:"FLECON BAGGED" after:{since} -label:"Blackwood-Processed"'


def phase_classify(args) -> int:
    work = oc.make_work_dir(REPORT_TYPE, args.work_dir)
    db = DBClient()

    # watermark = MAX(flecon_bag_movements.transaction_date); NULL → first-run full-2026 backfill.
    watermark = oc.data_watermark(db, "flecon_bag_movements")
    if watermark:
        since = (date.fromisoformat(watermark) - timedelta(days=3)).isoformat()
        since_gmail = since.replace("-", "/")
    else:
        since = "2026-01-01"
        since_gmail = "2025/12/31"

    oc.progress("fetch", "Checking Gmail for the bag inventory report…", pct=5)
    fetch = oc.fetch_gmail(GMAIL.format(since=since_gmail), work / "gmail")
    xlsx, email_meta = oc.latest_xlsx(fetch)
    if not xlsx:
        oc.progress("finalize", "Nothing new today — no FLECON BAGGED report waiting.", pct=100)
        oc.emit(oc.classify_envelope(
            report_type=REPORT_TYPE, ok=True, gate_failures=[], counts={"noop": 0},
            rows_preview=[], classified_path="",
            source={"email_subject": None, "email_uid": None},
            watermark=watermark, codified_rules_applied=CODIFIED_RULES,
            extra={"note": "No FLECON BAGGED email in window — nothing to ingest."}))
        return 0
    oc.progress("fetch", f"Found the report: {email_meta.get('subject') or 'FLECON BAGGED'}", pct=18)

    oc.progress("extract", "Reading the bag inventory spreadsheet…", pct=30)
    extract = oc.run_json(["python3", EXTRACT, "--file", xlsx, "--since", since])
    extract_path = work / "extract.json"
    extract_path.write_text(json.dumps(extract, default=str))

    # classify_flecon_bags self-fetches DB movements + bag_types + view via lib.db when
    # --db-rows-json is omitted (it imports lib.db). We rely on that.
    oc.progress("classify", "Comparing bag movements against the database…", pct=55)
    classified_path = work / "classified.json"
    oc.run_json(["python3", CLASSIFY, "--extract-json", str(extract_path),
                 "--since", since, "--output", str(classified_path)])
    classified = json.loads(classified_path.read_text())
    s = classified["summary"]
    col_flags = classified.get("column_flags", {})
    column_flagged = bool(col_flags.get("flagged"))

    per_date = classified.get("per_date", [])
    replace_days = len(per_date)

    preview = ([{"action": f"REPLACE_DATE:{p['class']}", "natural_key": p["transaction_date"],
                 "summary": f"{p.get('sheet_movement_count')} sheet movements (db had {p.get('db_movement_count')})"}
                for p in per_date]
               + ([{"action": "FLAGGED_COLUMNS", "natural_key": "columns",
                    "summary": f"unmapped={col_flags.get('unmapped_columns')} missing={col_flags.get('missing_columns')}"}]
                  if column_flagged else []))

    oc.progress("classify",
                f"{s.get('duplicate_noop_days', 0)} day(s) already recorded · {s.get('new_days', 0)} new · "
                f"{s.get('date_changed_days', 0)} changed"
                + (" · columns to review" if column_flagged else ""),
                pct=90)
    oc.progress("finalize", "Review ready — nothing written yet.", pct=100)

    oc.emit(oc.classify_envelope(
        report_type=REPORT_TYPE, ok=True, gate_failures=[],
        counts={"noop": s.get("duplicate_noop_days", 0),
                "insert": s.get("new_days", 0), "update": s.get("date_changed_days", 0),
                "flagged": (1 if column_flagged else 0)},
        rows_preview=preview, classified_path=str(classified_path),
        source={"email_subject": email_meta.get("subject"), "email_uid": email_meta.get("uid")},
        watermark=watermark, codified_rules_applied=CODIFIED_RULES,
        extra={"replace_days": replace_days, "column_flags": col_flags,
               "balance_crosscheck": classified.get("balance_crosscheck", {}).get("note"),
               "email_thread_id": email_meta.get("thread_id"),
               "email_uid": email_meta.get("uid"), "since": since}))
    return 0


def _prov(d, cls, extra=""):
    base = (f"provenance=flecon-sync | REPLACE-BY-DATE ({cls}) for {d} by sync_flecon.py "
            f"(lean orchestrator) on {oc.RUN_TS}.")
    return base + (f" {extra}" if extra else "")


def phase_apply(args) -> int:
    classified = json.loads(Path(args.input).read_text())
    db = DBClient()
    since = classified.get("since")
    code_to_id = classified.get("code_to_id", {})
    per_date = classified.get("per_date", [])
    held: list[dict] = []
    errors: list[str] = []
    replaced_dates = inserts = 0

    _total = max(1, len(per_date))
    _batch = max(1, -(-_total // 10))
    oc.progress("apply", f"Rewriting bag movements for {len(per_date)} day(s)…", pct=12)

    # Column flags → held (never auto-create a bag type).
    col_flags = classified.get("column_flags", {})
    if col_flags.get("flagged"):
        held.append({"reason": "unmapped_or_missing_columns", "natural_key": "columns",
                     "detail": f"unmapped={col_flags.get('unmapped_columns')} missing={col_flags.get('missing_columns')} "
                               f"— register/acknowledge before these bag types can be written."})

    _seen = 0
    for p in per_date:
        d = p["transaction_date"]
        _seen += 1
        if since and d < since:  # bounded floor — never touch settled history
            held.append({"reason": "below_since_floor", "natural_key": d,
                         "detail": f"{d} < since {since}; settled history not replaced."})
            continue
        movements = p.get("movements", [])
        # map every movement's bag_type_code -> id; an unmapped code holds the whole date.
        rows = []
        unmapped_here = []
        for m in movements:
            code = str(m.get("bag_type_code") or "").strip().upper()
            bid = code_to_id.get(code) or code_to_id.get(m.get("bag_type_code"))
            if not bid:
                unmapped_here.append(code)
                continue
            rows.append({
                "transaction_date": d, "particular": m.get("particular"),
                "bag_type_id": bid, "qty_delta": m.get("qty_delta"),
                "source_row": m.get("source_row"), "remarks": m.get("remarks"),
            })
        if unmapped_here:
            held.append({"reason": "unmapped_bag_type_code", "natural_key": d,
                         "detail": f"date {d} has unmapped codes {sorted(set(unmapped_here))} — date NOT replaced."})
            continue
        try:
            # REPLACE-BY-DATE: DELETE this date then INSERT the sheet's current movements.
            db._session.delete(f"{db.base}/flecon_bag_movements",
                               params={"transaction_date": f"eq.{d}"},
                               headers={"Prefer": "return=minimal"})
            if rows:
                ins = db.insert("flecon_bag_movements", rows)
                inserts += len(ins)
            replaced_dates += 1
            # one manual audit row per replaced date (no audit trigger on flecon).
            marker_id = (ins[0]["id"] if rows and ins else None)
            if marker_id:
                db.insert_manual_audit(table_name="flecon_bag_movements", record_id=marker_id,
                                       operation="REPLACE", comment=_prov(d, p["class"], f"{len(rows)} movements"),
                                       snapshot={"transaction_date": d, "movement_count": len(rows)})
            if _seen % _batch == 0 or _seen == _total:
                oc.progress("apply", f"Rewriting day {_seen} of {_total} — {d}",
                            pct=12 + int(75 * _seen / _total))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"replace date {d}: {exc}")

    watermark_updated = labeled = False
    if not errors:
        oc.progress("apply", "Updating the audit trail…", pct=90)
        watermark_updated = oc.upsert_ingestion_watermark(
            db, REPORT_TYPE, last_email_id=classified.get("email_thread_id"))
        # label only if zero errors AND no held date left un-replaced that wasn't intentional.
        held_dates = [h for h in held if h["reason"] in ("unmapped_bag_type_code", "unmapped_or_missing_columns")]
        if not held_dates and not args.no_label:
            uid = classified.get("email_uid")
            if uid:
                oc.progress("apply", "Marking the email as processed…", pct=95)
                labeled = oc.mark_processed([uid])

    if errors:
        oc.progress("finalize", f"Finished with {len(errors)} problem(s) — see details.", pct=100, level="warn")
    elif replaced_dates:
        oc.progress("finalize", f"Done — {replaced_dates} day(s) rewritten, {inserts} movement(s) written.", pct=100)
    else:
        oc.progress("finalize", "Done — nothing new to write.", pct=100)

    oc.emit(oc.apply_envelope(
        report_type=REPORT_TYPE, ok=not errors, inserts=inserts, replaced_dates=replaced_dates,
        held=held, labeled=labeled, watermark_updated=watermark_updated, errors=errors))
    return 0 if not errors else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Lean two-phase flecon sync orchestrator (REPLACE-BY-DATE).")
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
