#!/usr/bin/env python3
"""
sync_deliveries.py — lean two-phase orchestrator for RC DELIVERIES → `deliveries`
(LEAN_SYNC_REFACTOR §2). Wraps the EXISTING extract_rc_deliveries.py + enrich_prices.py
+ classify_deliveries.py; it does NOT re-implement any diff rule.

CLI contract (SYNC_CLI_CONTRACT.md):
  python3 sync_deliveries.py --phase classify --json
  python3 sync_deliveries.py --phase apply --input <classified_path> --only-clean --json

Pipeline (classify):
  1. watermark = MAX(deliveries.transaction_date); since = watermark − 3d (tail-scope).
  2. fetch latest "RC DELIVERIES" operator xlsx + latest Czarina prices xlsx.
  3. extract_rc_deliveries → tail-filter rows to transaction_date >= since (L: extractor
     is cumulative year-to-date; settled bulk must not be re-classified).
  4. enrich_prices (if Czarina file present) → cost_basis on matched rows.
  5. classify_deliveries vs the DB window (Python fetches the window itself).
  6. L-004 guard: a NEW row matching an existing DB row on (date,batch_code,weight_kg) at a
     DIFFERENT block_loc is a block_loc correction → FLAGGED, never an insert.
  7. emit the classify envelope. NEW→insert, VALUE_CHANGED→update, block_loc-correction &
     low-confidence & unenriched-price → flagged/held per the rules below.

Codified mechanical rules (trusted from the wrapped scripts + this orchestrator):
  * rounding / null↔0 → NOOP           — classify_deliveries.field_differences + norm_*.
  * L-001 UPDATE trigger audit row       — apply, via lib.db.update_trigger_audit_provenance.
  * L-006 never touch current_weight     — apply never writes current_weight.
  * L-008 cost_basis=0 placeholder       — apply, when a NEW row has no enriched price.
  * L-021 deduction passthrough (write-only, not diffed) — extractor + classifier + lib.db.
  * batch_code fallback prefixes         — extract_rc_deliveries (never auto-create a batch
                                           beyond a defensive upsert of the resolved code).
  * L-004 block_loc-correction → flagged — this orchestrator (below).
Stays JUDGMENT (→ held, never auto-written): UNMAPPED supplier/batch_code, an ambiguous
Czarina price match, any classifier MALFORMED, and any L-004 block_loc correction.
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

REPORT_TYPE = "deliveries"
EXTRACT = str(SCRIPT_DIR / "extract_rc_deliveries.py")
ENRICH = str(SCRIPT_DIR / "enrich_prices.py")
CLASSIFY = str(SCRIPT_DIR / "classify_deliveries.py")

DELIVERIES_COLS = [
    "id", "transaction_date", "supplier", "batch_code", "block_loc",
    "truck_plate", "sacks", "weight_kg", "cost_basis", "remarks", "lab_results",
]

CODIFIED_RULES = [
    "rounding-null-zero-noop", "L-001", "L-004", "L-006", "L-008", "L-021",
    "L-033-cross-batch-duplicate", "L-033-piled-in-remark-hint",
    "batch_code-fallback-prefixes", "never-auto-create-batch",
]

GMAIL_OP = 'label:"Work/ICTC Daily" subject:"RC DELIVERIES" after:{since} -label:"Blackwood-Processed"'
GMAIL_CZ = 'from:czarinaloumaximoictc@gmail.com newer_than:5d'

CONF_FLOOR = 0.7


def _month_sheet(d: str) -> str:
    y, m, _ = d.split("-")
    return f"{date(int(y), int(m), 1).strftime('%B')} {y}"


def phase_classify(args) -> int:
    work = oc.make_work_dir(REPORT_TYPE, args.work_dir)
    db = DBClient()
    watermark = oc.data_watermark(db, "deliveries")
    since = (date.fromisoformat(watermark) - timedelta(days=3)).isoformat() if watermark else "2025-01-01"
    since_gmail = since.replace("-", "/")

    # 1. fetch operator RC DELIVERIES
    oc.progress("fetch", "Checking Gmail for new delivery reports…", pct=5)
    fetch = oc.fetch_gmail(GMAIL_OP.format(since=since_gmail), work / "op")
    op_xlsx, op_email = oc.latest_xlsx(fetch)
    if not op_xlsx:
        oc.progress("finalize", "Nothing new today — no RC DELIVERIES report waiting.", pct=100)
        oc.emit(oc.classify_envelope(
            report_type=REPORT_TYPE, ok=True, gate_failures=[],
            counts={"noop": 0}, rows_preview=[], classified_path="",
            source={"email_subject": None, "email_uid": None},
            watermark=watermark, codified_rules_applied=CODIFIED_RULES,
            extra={"note": "No RC DELIVERIES email in window — nothing to ingest."},
        ))
        return 0
    oc.progress("fetch", f"Found the report: {op_email.get('subject') or 'RC DELIVERIES'}", pct=15)

    # 2. fetch Czarina prices (optional)
    oc.progress("fetch", "Checking Gmail for the latest price sheet…", pct=20)
    cz_fetch = oc.fetch_gmail(GMAIL_CZ, work / "cz")
    cz_xlsx, _ = oc.latest_xlsx(cz_fetch)

    # 3. extract + tail-filter
    oc.progress("extract", "Reading the delivery spreadsheet…", pct=28)
    extract = oc.run_json(["python3", EXTRACT, "--file", op_xlsx])
    rows = [r for r in extract.get("rows", []) if str(r.get("transaction_date") or "")[:10] >= since]
    extract["rows"] = rows
    oc.progress("extract", f"Read {len(rows)} recent delivery row(s) to check.", pct=40)
    extract_path = work / "extract.json"
    extract_path.write_text(json.dumps(extract, default=str))

    # 4. enrich (best-effort). enrich_prices.py prints HUMAN lines to stdout (not JSON) but
    #    writes the enriched JSON to --output — so we run it directly and check the file, we do
    #    NOT parse its stdout. A missing/empty output file means enrichment truly failed → L-008.
    import subprocess
    enriched_path = extract_path
    price_enriched = False
    if cz_xlsx and rows:
        try:
            sheet = _month_sheet(max(r["transaction_date"][:10] for r in rows if r.get("transaction_date")))
            out = work / "enriched.json"
            proc = subprocess.run(["python3", ENRICH, "--extract-json", str(extract_path),
                                   "--prices-xlsx", cz_xlsx, "--sheet", sheet, "--output", str(out)],
                                  capture_output=True, text=True)
            if proc.stderr:
                oc.log(proc.stderr.rstrip())
            if proc.stdout:
                oc.log(proc.stdout.rstrip())
            if proc.returncode == 0 and out.exists() and out.stat().st_size > 0:
                enriched_path = out
                price_enriched = True
            else:
                oc.log(f"[warn] price enrichment produced no output (rc={proc.returncode}); "
                       f"proceeding with cost_basis=null → L-008 placeholder.")
        except Exception as exc:  # noqa: BLE001
            oc.log(f"[warn] price enrichment errored ({exc}); proceeding with cost_basis=null (L-008).")
            enriched_path = extract_path

    # 5. classify vs DB window
    oc.progress("classify", "Comparing the report against the database…", pct=55)
    db_rows = db.read_rows("deliveries", since_date=since, columns=DELIVERIES_COLS)
    db_path = work / "db_rows.json"
    db_path.write_text(json.dumps(db_rows, default=str))
    classified_path = work / "classified.json"
    oc.run_json(["python3", CLASSIFY, "--extract-json", str(enriched_path),
                 "--db-rows-json", str(db_path), "--output", str(classified_path)])
    classified = json.loads(classified_path.read_text())

    # 6. L-004 guard: NEW row that collides on (date,batch_code,weight_kg) at a different block_loc.
    from classify_deliveries import norm_num, norm_block_loc  # noqa: E402
    db_by_dbw: dict[tuple, list[dict]] = {}
    for r in db_rows:
        k = (str(r.get("transaction_date"))[:10], r.get("batch_code"), norm_num(r.get("weight_kg"), 3))
        db_by_dbw.setdefault(k, []).append(r)

    # L-033 index: the same physical truckload regardless of batch NAME.
    # Month-boundary piles ("PILED IN JUNE BLOCK 9" on a July date) make the extractor
    # derive a phantom current-month batch code (JULY-26-BLK9) for a truckload the DB
    # already holds under the prior month's code (JUNE-26-BLK9). Batch names lie across
    # month boundaries; (date, truck_plate, weight) doesn't.
    def _norm_truck(v) -> str:
        return "".join(ch for ch in str(v or "").upper() if ch.isalnum())

    db_by_dtw: dict[tuple, list[dict]] = {}
    for r in db_rows:
        k = (str(r.get("transaction_date"))[:10], _norm_truck(r.get("truck_plate")), norm_num(r.get("weight_kg"), 3))
        db_by_dtw.setdefault(k, []).append(r)

    import re as _re
    _MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
               "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
    _CODE_VARIANTS = {1: ["JAN"], 2: ["FEB"], 3: ["MARCH", "MAR"], 4: ["APRIL", "APR"],
                      5: ["MAY"], 6: ["JUNE", "JUN"], 7: ["JULY", "JUL"], 8: ["AUG"],
                      9: ["SEPT", "SEP"], 10: ["OCT"], 11: ["NOV"], 12: ["DEC"]}

    def _piled_in_hint(row: dict) -> str | None:
        """L-033: 'PILED IN <MONTH> BLOCK <N>' remark names the REAL batch. Return an
        EXISTING batch_code it resolves to, else None (never invent a batch)."""
        m = _re.search(r"PILED\s+IN\s+([A-Z]+)\.?\s+BLOCK\s*(\d+)", str(row.get("remarks") or ""), _re.I)
        if not m:
            return None
        word, blk = m.group(1).upper(), int(m.group(2))
        mnum = next((n for p, n in _MONTHS.items() if word.startswith(p)), None)
        if not mnum:
            return None
        txn = str(row.get("transaction_date") or "")[:10]
        try:
            ty, tm = int(txn[:4]), int(txn[5:7])
        except ValueError:
            return None
        year = ty - 1 if mnum > tm else ty  # Dec pile receiving a Jan truck crosses the year
        for v in _CODE_VARIANTS[mnum]:
            cand = f"{v}-{str(year)[2:]}-BLK{blk}"
            if db.select_one("batches", {"batch_code": f"eq.{cand}"}, columns="batch_code"):
                return cand
        return None

    inserts, flagged, dup_noops = [], [], []
    for item in classified.get("new", []):
        r = item["row"]

        # L-033a — cross-batch duplicate: same (date, truck, weight) already in the DB.
        kd = (str(r.get("transaction_date"))[:10], _norm_truck(r.get("truck_plate")), norm_num(r.get("weight_kg"), 3))
        dups = db_by_dtw.get(kd, []) if _norm_truck(r.get("truck_plate")) else []
        same_loc = [d for d in dups if norm_block_loc(d.get("block_loc")) == norm_block_loc(r.get("block_loc"))]
        if same_loc:
            db_bc = same_loc[0].get("batch_code")
            if db_bc != r.get("batch_code"):
                dup_noops.append({"index": item.get("index"),
                                  "natural_key": f"{r.get('transaction_date')}|{r.get('truck_plate')}|{r.get('weight_kg')}",
                                  "note": f"L-033: same truckload already recorded as {db_bc} — "
                                          f"extractor-derived name {r.get('batch_code')} is a month-boundary phantom."})
                continue
            # same batch_code + same everything would have classified NOOP upstream; fall through.
        elif dups:
            flagged.append({"kind": "L033_cross_batch_loc_mismatch", "index": item.get("index"), "row": r,
                            "reason": f"Same date/truck/weight exists as {dups[0].get('batch_code')} at "
                                      f"block_loc={dups[0].get('block_loc')} (report says {r.get('block_loc')}) — "
                                      f"same truckload under a different name AND location; needs a human.",
                            "decision": "skip"})
            continue

        # L-033b — remark hint: re-map to the EXISTING pile batch it names.
        hint = _piled_in_hint(r)
        if hint and hint != r.get("batch_code"):
            item.setdefault("notes", []).append(
                f"L-033: batch re-mapped {r.get('batch_code')} → {hint} per remark 'PILED IN … BLOCK …'")
            r["batch_code"] = hint

        k = (str(r.get("transaction_date"))[:10], r.get("batch_code"), norm_num(r.get("weight_kg"), 3))
        collision = [d for d in db_by_dbw.get(k, [])
                     if norm_block_loc(d.get("block_loc")) != norm_block_loc(r.get("block_loc"))]
        if collision:
            flagged.append({"kind": "L004_block_loc_correction", "index": item.get("index"),
                            "row": r, "db_id": collision[0].get("id"),
                            "reason": f"Same date/batch/weight exists at block_loc={collision[0].get('block_loc')} "
                                      f"(sheet says {r.get('block_loc')}) — block_loc correction, not a new delivery.",
                            "decision": "skip"})
        elif (r.get("confidence") or 1.0) < CONF_FLOOR:
            flagged.append({"kind": "low_confidence", "index": item.get("index"), "row": r,
                            "reason": f"confidence {r.get('confidence')} < {CONF_FLOOR}", "decision": "skip"})
        else:
            inserts.append(item)

    compact = {
        "report_type": REPORT_TYPE, "since": since, "price_enriched": price_enriched,
        "source": {"email_subject": op_email.get("subject"), "email_uid": op_email.get("uid"),
                   "email_thread_id": op_email.get("thread_id"), "czarina_present": bool(cz_xlsx)},
        "actionable": {
            "new": inserts,
            "changed": classified.get("changed", []),
            "flagged": flagged,
            "malformed": classified.get("malformed", []),
        },
    }
    compact_path = work / "decisions_deliveries.json"
    compact_path.write_text(json.dumps(compact, indent=2, default=str))

    preview = ([{"action": "INSERT", "natural_key": f"{i['row'].get('transaction_date')}|{i['row'].get('batch_code')}|{i['row'].get('block_loc')}",
                 "summary": f"{i['row'].get('weight_kg')}kg {i['row'].get('supplier')}"} for i in inserts]
               + [{"action": "UPDATE", "natural_key": c.get("db_id"),
                   "summary": f"{c.get('date')} diff={[d['field'] for d in c.get('diff', [])]}"} for c in classified.get("changed", [])]
               + [{"action": "FLAGGED", "natural_key": f.get("index"), "summary": f.get("reason")} for f in flagged]
               + [{"action": "NOOP_DUP", "natural_key": d["natural_key"], "summary": d["note"]} for d in dup_noops])

    _noop = classified["summary"]["noop_count"] + len(dup_noops)
    _flag = len(flagged) + len(classified.get("malformed", []))
    oc.progress("classify",
                f"{_noop} already recorded · {len(inserts)} new · {len(classified.get('changed', []))} changed"
                + (f" · {_flag} to review" if _flag else ""),
                pct=90)
    oc.progress("finalize", "Review ready — nothing written yet.", pct=100)

    oc.emit(oc.classify_envelope(
        report_type=REPORT_TYPE, ok=True, gate_failures=[],
        counts={"noop": classified["summary"]["noop_count"] + len(dup_noops), "insert": len(inserts),
                "update": len(classified.get("changed", [])),
                "flagged": len(flagged) + len(classified.get("malformed", []))},
        rows_preview=preview, classified_path=str(compact_path),
        source={"email_subject": op_email.get("subject"), "email_uid": op_email.get("uid")},
        watermark=watermark, codified_rules_applied=CODIFIED_RULES,
        extra={"price_enriched": price_enriched, "malformed": classified["summary"]["malformed_count"]},
    ))
    return 0


def _prov(index, extra=""):
    base = (f"provenance=deliveries-sync | Ingested by sync_deliveries.py (lean orchestrator) "
            f"row {index} on {oc.RUN_TS}.")
    return base + (f" {extra}" if extra else "")


def phase_apply(args) -> int:
    compact = json.loads(Path(args.input).read_text())
    only_clean = args.only_clean
    db = DBClient()
    inserts = updates = 0
    held: list[dict] = []
    errors: list[str] = []

    _new_rows = compact["actionable"]["new"]
    _chg_rows = compact["actionable"]["changed"]
    _total_writes = max(1, len(_new_rows) + len(_chg_rows))
    _write_batch = max(1, -(-_total_writes // 10))  # ceil(n/10): ≤10 progress ticks
    _done = 0
    oc.progress("apply", f"Writing {len(_new_rows)} new and {len(_chg_rows)} changed delivery row(s)…", pct=10)

    # NEW rows → INSERT deliveries (idempotent), UPDATE trigger audit row (L-001).
    for item in compact["actionable"]["new"]:
        r = item["row"]
        bc = r.get("batch_code")
        try:
            # defensive batch upsert (never auto-create beyond the resolved code; L-006: current_weight owned by trigger)
            if bc and not db.select_one("batches", {"batch_code": f"eq.{bc}"}, columns="batch_code"):
                try:
                    db.insert("batches", [{"batch_code": bc, "location_ref": r.get("block_loc") or "",
                                           "status": "STORED", "current_weight": 0, "avg_cost": 0}], returning="minimal")
                except Exception as bexc:  # noqa: BLE001
                    # block_loc already holds an active batch → HOLD, don't crash the run.
                    if oc.is_location_collision(bexc):
                        held.append({
                            "reason": "location_occupied",
                            "natural_key": f"{r['transaction_date']}|{bc}|{r.get('block_loc')}",
                            "detail": (f"block_loc {r.get('block_loc')} already holds an active batch; "
                                       f"new batch {bc} not created and this delivery was not written. "
                                       f"Resolve which batch owns this slot (close the prior batch or fix the "
                                       f"location) via the sync employee, then re-run."),
                        })
                        continue
                    raise
            payload = {
                "transaction_date": r["transaction_date"], "supplier": r.get("supplier"),
                "batch_code": bc, "block_loc": r.get("block_loc"), "truck_plate": r.get("truck_plate"),
                "sacks": r.get("sacks"), "weight_kg": r["weight_kg"],
                "cost_basis": r.get("cost_basis") if r.get("cost_basis") is not None else 0,  # L-008
                "remarks": r.get("remarks"), "lab_results": r.get("lab_results"),
                "true_weight_kg": r.get("true_weight_kg"), "deduction_note": r.get("deduction_note"),  # L-021
            }
            res = db.insert_if_absent("deliveries", [payload],
                                      natural_key=("transaction_date", "batch_code", "truck_plate", "weight_kg", "sacks"))
            if res["inserted_count"] == 0:
                held.append({"reason": "already_exists", "natural_key": f"{r['transaction_date']}|{bc}",
                             "detail": "idempotent skip (natural key already in DB)"})
                continue
            new_id = res["inserted"][0]["id"]
            inserts += 1
            note = "" if r.get("cost_basis") is not None else "cost_basis=0 UNPRICED PLACEHOLDER (L-008) — deliveries pricing enrich pending."
            db.update_trigger_audit_provenance("deliveries", new_id, _prov(item.get("index"), note), snapshot=payload)  # L-001
            _done += 1
            if _done % _write_batch == 0 or _done == _total_writes:
                oc.progress("apply", f"Writing {_done} of {_total_writes} — {bc} @ {r.get('block_loc')}",
                            pct=10 + int(70 * _done / _total_writes))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"insert row {item.get('index')}: {exc}")

    # VALUE_CHANGED → UPDATE differing fields (never cost_basis here unless enriched provided it).
    for c in compact["actionable"]["changed"]:
        try:
            patch = {d["field"]: d.get("emailValue") if "emailValue" in d else d.get("sheetValue")
                     for d in c.get("diff", [])}
            if not patch:
                continue
            db.update("deliveries", {"id": f"eq.{c['db_row']['id']}"}, patch, returning="minimal")
            updates += 1
            _done += 1
            if _done % _write_batch == 0 or _done == _total_writes:
                oc.progress("apply", f"Writing {_done} of {_total_writes} — updating delivery {c.get('date') or ''}".rstrip(),
                            pct=10 + int(70 * _done / _total_writes))
            diff_json = {d["field"]: {"old": d.get("dbValue"), "new": d.get("emailValue")} for d in c["diff"]}
            ok = db.update_trigger_audit_provenance("deliveries", c["db_row"]["id"],
                                                    _prov(c.get("index"), f"UPDATE diff={json.dumps(diff_json, default=str)}"))
            if not ok:
                db.insert_manual_audit(table_name="deliveries", record_id=c["db_row"]["id"],
                                       operation="UPDATE", comment=_prov(c.get("index"), "UPDATE"), diff=diff_json)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"update {c.get('db_id')}: {exc}")

    # FLAGGED + MALFORMED never auto-written under --only-clean.
    for f in compact["actionable"]["flagged"]:
        if only_clean and (f.get("decision") or "skip") == "skip":
            held.append({"reason": f.get("kind"), "natural_key": f.get("index"), "detail": f.get("reason")})
    for m in compact["actionable"].get("malformed", []):
        held.append({"reason": "malformed", "natural_key": m.get("row", {}).get("transaction_date"),
                     "detail": m.get("reason")})

    non_held_unapplied = bool(errors)
    watermark_updated = False
    labeled = False
    if not errors:
        oc.progress("apply", "Updating the audit trail…", pct=88)
        watermark_updated = oc.upsert_ingestion_watermark(
            db, REPORT_TYPE,
            last_email_id=compact.get("source", {}).get("email_thread_id"))
        # label only if zero errors AND zero unapplied non-held rows (SKILL.md:347).
        if not non_held_unapplied and not args.no_label:
            uid = compact.get("source", {}).get("email_uid")
            if uid:
                oc.progress("apply", "Marking the email as processed…", pct=94)
                labeled = oc.mark_processed([uid])

    if errors:
        oc.progress("finalize", f"Finished with {len(errors)} problem(s) — see details.", pct=100, level="warn")
    elif inserts or updates:
        oc.progress("finalize", f"Done — {inserts} new, {updates} updated.", pct=100)
    else:
        oc.progress("finalize", "Done — nothing new to write.", pct=100)

    oc.emit(oc.apply_envelope(
        report_type=REPORT_TYPE, ok=not errors, inserts=inserts, updates=updates,
        held=held, labeled=labeled, watermark_updated=watermark_updated, errors=errors,
    ))
    return 0 if not errors else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Lean two-phase deliveries sync orchestrator.")
    ap.add_argument("--phase", required=True, choices=["classify", "apply"])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--input", help="Approved classified/decisions JSON (apply phase).")
    ap.add_argument("--only-clean", action="store_true",
                    help="Apply only rows passing every codified rule; flagged/uncertain → held.")
    ap.add_argument("--no-label", action="store_true", help="Skip Gmail labeling (test runs).")
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
