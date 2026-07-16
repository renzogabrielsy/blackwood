#!/usr/bin/env python3
"""
sync_production.py — lean two-phase orchestrator for PRODUCTION (LEAN_SYNC_REFACTOR §4).
SIX tables across TWO emails:
  MC "Daily Production Report"  -> production_runs + production_downtime + electricity_readings + truck_readings
  Ivy "WASTE PRODUCTION REPORT" -> production_waste
production_shifts is the PARENT of runs/downtime/waste (FK shift_id). electricity_readings and
truck_readings are independent natural-key tables (no shift).

Wraps extract_daily_production.py + extract_waste_production.py + the 5 classifiers
(classify_production_runs / _downtime / _waste / classify_electricity / classify_trucks) +
reconcile_production.py. No diff rule is re-implemented.

APPLY ordering (FK-safe, deterministic):
  1. From every NEW / needs_shift_upsert child (runs+downtime+waste), collect the distinct
     (transaction_date, production_batch, shift) triplets and UPSERT the parent shifts FIRST;
     build a triplet -> shift_id map from the returned rows.
  2. INSERT NEW children resolving shift_id from the map (or from resolved_shift_id).
  3. INSERT NEW electricity_readings + truck_readings (natural-key, no shift). NEVER write the
     generated columns diff_kwh / consumption_kwh / ttl_km.
  4. One manual audit row per inserted row (production_* / electricity / trucks have NO audit trigger).
Reconciliation is INFORMATIONAL and NEVER gates (RC-IN vs production drift is expected — feed
tank empties month-end).

CLI contract (SYNC_CLI_CONTRACT.md):
  python3 sync_production.py --phase classify --json
  python3 sync_production.py --phase apply --input <classified_path> --only-clean --json

Codified mechanical rules:
  * rounding / null↔0 → NOOP                — each classifier's field_diff + tolerances.
  * L-007 STARTING/ENDING batch boundary     — extract_daily_production (two shift parents same date).
  * L-014 dt_mins>=60 split into dt_hrs+dt_mins — extract_daily_production.
  * L-025 blank shift defaults to Morning    — extract_daily_production.
  * L-026 combine duplicate (shift,customer,grade) run rows — codified guard in this orchestrator.
  * L-027 grade allowlist (3X50/6X50/8X50/2X6/4X8) — extract + classify_production_runs VALID_GRADES + DB CHECK.
  * L-028 month-transition second waste row = new shift — extract_waste_production + waste natural key.
  * parent-shift-first FK ordering + generated cols never written — apply.
Stays JUDGMENT (→ held): L-007 batch inference when column C blank & indeterminate; the
waste-collision sum-vs-separate-shift question; any MALFORMED; deferred Bagging/QC/Sundry sections.
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

REPORT_TYPE = "production"
EXTRACT_MC = str(SCRIPT_DIR / "extract_daily_production.py")
EXTRACT_IVY = str(SCRIPT_DIR / "extract_waste_production.py")
CLS_RUNS = str(SCRIPT_DIR / "classify_production_runs.py")
CLS_DT = str(SCRIPT_DIR / "classify_production_downtime.py")
CLS_WASTE = str(SCRIPT_DIR / "classify_production_waste.py")
CLS_ELEC = str(SCRIPT_DIR / "classify_electricity.py")
CLS_TRUCK = str(SCRIPT_DIR / "classify_trucks.py")

CODIFIED_RULES = [
    "rounding-null-zero-noop", "L-007", "L-014", "L-025", "L-026", "L-027", "L-028",
    "parent-shift-first-fk-order", "generated-cols-never-written",
]

GMAIL_MC = 'from:mccontinedo.ictc@gmail.com subject:"Daily Production Report" after:{since} -label:"Blackwood-Processed"'
GMAIL_IVY = 'from:edilloivymae306ictc@gmail.com subject:"WASTE PRODUCTION REPORT" after:{since} -label:"Blackwood-Processed"'

WASTE_STREAMS = ["rs1a_kg", "rs1b_kg", "bf_kg", "rs23_kg", "rs5_kg", "trml1_kg", "trml2_kg", "grit_kg"]


def _run_cls(cmd: list[str], out_path: Path) -> dict:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.stderr:
        oc.log(proc.stderr.rstrip())
    if proc.returncode not in (0,):
        oc.log(f"[warn] classifier rc={proc.returncode}: {' '.join(cmd)}")
    return json.loads(out_path.read_text()) if out_path.exists() else {"classifications": [], "summary": {}}


def phase_classify(args) -> int:
    work = oc.make_work_dir(REPORT_TYPE, args.work_dir)
    db = DBClient()
    watermark = oc.data_watermark(db, "production_shifts")
    since = watermark if watermark else "2025-01-01"  # extractors treat --since EXCLUSIVE
    since_gmail = ((date.fromisoformat(watermark) - timedelta(days=1)) if watermark
                   else date(2025, 1, 1)).isoformat().replace("-", "/")
    year = int(since[:4])

    # fetch MC + Ivy
    oc.progress("fetch", "Checking Gmail for the daily production report…", pct=5)
    mc_fetch = oc.fetch_gmail(GMAIL_MC.format(since=since_gmail), work / "mc")
    mc_xlsx, mc_email = oc.latest_xlsx(mc_fetch)
    oc.progress("fetch", "Checking Gmail for the waste report…", pct=15)
    ivy_fetch = oc.fetch_gmail(GMAIL_IVY.format(since=since_gmail), work / "ivy")
    ivy_xlsx, ivy_email = oc.latest_xlsx(ivy_fetch)

    if not mc_xlsx and not ivy_xlsx:
        oc.progress("finalize", "Nothing new today — no production or waste report waiting.", pct=100)
        oc.emit(oc.classify_envelope(
            report_type=REPORT_TYPE, ok=True, gate_failures=[], counts={"noop": 0},
            rows_preview=[], classified_path="",
            source={"email_subject": None, "email_uid": None},
            watermark=watermark, codified_rules_applied=CODIFIED_RULES,
            extra={"note": "No MC or Ivy production email in window — nothing to ingest."}))
        return 0
    _found = [name for name, x in (("production report", mc_xlsx), ("waste report", ivy_xlsx)) if x]
    oc.progress("fetch", f"Found {len(_found)} report(s): {', '.join(_found)}", pct=22)

    # extract
    oc.progress("extract", "Reading the production spreadsheet(s)…", pct=30)
    runs = downtime = electricity = trucks = {"runs": [], "downtime": [], "electricity": [], "trucks": []}
    if mc_xlsx:
        mc = oc.run_json(["python3", EXTRACT_MC, "--file", mc_xlsx, "--year", str(year),
                          "--all-sheets", "--since", since])
        (work / "extract_mc.json").write_text(json.dumps(mc, default=str))
    else:
        mc = {"runs": [], "downtime": [], "electricity": [], "trucks": []}
    if ivy_xlsx:
        ivy = oc.run_json(["python3", EXTRACT_IVY, "--file", ivy_xlsx, "--all-sheets", "--since", since])
        (work / "extract_ivy.json").write_text(json.dumps(ivy, default=str))
    else:
        ivy = {"waste": []}

    # write per-section extract JSONs under the SECTION KEY each classifier reads
    # (classify_production_runs reads .get("runs"), downtime .get("downtime"), etc.
    # Wrapping everything as {"rows": ...} made every classifier see [] and silently
    # classify ZERO production rows — found by the M2 parity-oracle build 2026-07-04.)
    def _rows_file(name: str, key: str, rows: list) -> Path:
        p = work / name
        p.write_text(json.dumps({key: rows}, default=str))
        return p

    runs_ex = _rows_file("ex_runs.json", "runs", mc.get("runs", []))
    dt_ex = _rows_file("ex_downtime.json", "downtime", mc.get("downtime", []))
    elec_ex = _rows_file("ex_electricity.json", "electricity", mc.get("electricity", []))
    truck_ex = _rows_file("ex_trucks.json", "trucks", mc.get("trucks", []))
    waste_ex = _rows_file("ex_waste.json", "waste", ivy.get("waste", []))

    # DB window for shifts + children
    all_dates = [str(r.get("transaction_date"))[:10] for r in
                 mc.get("runs", []) + mc.get("downtime", []) + ivy.get("waste", []) if r.get("transaction_date")]
    if all_dates:
        lo = (date.fromisoformat(min(all_dates)) - timedelta(days=3)).isoformat()
        hi = (date.fromisoformat(max(all_dates)) + timedelta(days=3)).isoformat()
    else:
        lo, hi = since, since

    shifts = db.read_rows("production_shifts", since_date=lo,
                          columns=["id", "transaction_date", "production_batch", "shift"])
    shifts = [s for s in shifts if str(s.get("transaction_date"))[:10] <= hi]
    shifts_path = work / "shifts.json"
    shifts_path.write_text(json.dumps(shifts, default=str))

    # child DB rows joined with shift triplet — the classifiers expect that shape.
    def _child_db(table: str, extra_cols: list[str]) -> Path:
        rows = db.read_rows(table, since_column=None, columns=["id", "shift_id", *extra_cols])
        shift_by_id = {s["id"]: s for s in shifts}
        out = []
        for r in rows:
            sh = shift_by_id.get(r.get("shift_id"))
            if not sh:
                continue
            out.append({**r, "transaction_date": sh["transaction_date"],
                        "production_batch": sh["production_batch"], "shift": sh["shift"]})
        p = work / f"db_{table}.json"
        p.write_text(json.dumps(out, default=str))
        return p

    db_runs = _child_db("production_runs", ["customer", "grade", "ttl_kg", "sacks_bags", "remarks"])
    db_dt = _child_db("production_downtime", ["shift_hrs", "dt_hrs", "dt_mins", "dt_reason"])  # no remarks col
    db_waste = _child_db("production_waste", [*WASTE_STREAMS, "remarks"])
    db_elec = work / "db_electricity.json"
    db_elec.write_text(json.dumps(db.read_rows("electricity_readings", since_date=lo, since_column="reading_date",
                       columns=["id", "reading_date", "meter", "start_kwh", "end_kwh", "meter_multiplier", "remarks"]), default=str))
    db_truck = work / "db_trucks.json"
    db_truck.write_text(json.dumps(db.read_rows("truck_readings", since_date=lo, since_column="reading_date",
                        columns=["id", "reading_date", "plate_no", "start_km", "end_km", "fuel_liters", "remarks"]), default=str))

    # classify each section
    _row_count = len(mc.get("runs", [])) + len(mc.get("downtime", [])) + len(ivy.get("waste", []))
    oc.progress("extract", f"Read {_row_count} production/waste row(s) across 5 sections.", pct=45)
    oc.progress("classify", "Comparing the reports against the database…", pct=55)
    c_runs = _run_cls(["python3", CLS_RUNS, "--extract-json", str(runs_ex), "--db-rows-json", str(db_runs),
                       "--shifts-json", str(shifts_path), "--output", str(work / "cls_runs.json")], work / "cls_runs.json")
    c_dt = _run_cls(["python3", CLS_DT, "--extract-json", str(dt_ex), "--db-rows-json", str(db_dt),
                     "--shifts-json", str(shifts_path), "--output", str(work / "cls_dt.json")], work / "cls_dt.json")
    c_waste = _run_cls(["python3", CLS_WASTE, "--extract-json", str(waste_ex), "--db-rows-json", str(db_waste),
                        "--shifts-json", str(shifts_path), "--output", str(work / "cls_waste.json")], work / "cls_waste.json")
    c_elec = _run_cls(["python3", CLS_ELEC, "--extract-json", str(elec_ex), "--db-rows-json", str(db_elec),
                       "--output", str(work / "cls_elec.json")], work / "cls_elec.json")
    c_truck = _run_cls(["python3", CLS_TRUCK, "--extract-json", str(truck_ex), "--db-rows-json", str(db_truck),
                        "--output", str(work / "cls_truck.json")], work / "cls_truck.json")

    # informational reconcile (never gates) — best-effort
    oc.progress("reconcile", "Running an informational production cross-check…", pct=80)
    recon_summary = None
    try:
        recon_out = work / "reconcile.json"
        recon_cmd = ["python3", str(SCRIPT_DIR / "reconcile_production.py"),
                     "--prod-extract-json", str(work / "extract_mc.json"),
                     "--output", str(recon_out)]
        if ivy_xlsx:
            recon_cmd += ["--waste-extract-json", str(work / "extract_ivy.json")]
        subprocess.run(recon_cmd, capture_output=True, text=True)
        if recon_out.exists():
            recon_summary = json.loads(recon_out.read_text()).get("summary")
    except Exception as exc:  # noqa: BLE001
        oc.log(f"[info] reconcile skipped (informational, non-gating): {exc}")

    compact = {
        "report_type": REPORT_TYPE, "since": since, "window": [lo, hi],
        "source": {"mc_subject": mc_email.get("subject") if mc_email else None,
                   "mc_uid": mc_email.get("uid") if mc_email else None,
                   "mc_thread_id": mc_email.get("thread_id") if mc_email else None,
                   "ivy_subject": ivy_email.get("subject") if ivy_email else None,
                   "ivy_uid": ivy_email.get("uid") if ivy_email else None,
                   "ivy_thread_id": ivy_email.get("thread_id") if ivy_email else None},
        "sections": {
            "runs": c_runs.get("classifications", []),
            "downtime": c_dt.get("classifications", []),
            "waste": c_waste.get("classifications", []),
            "electricity": c_elec.get("classifications", []),
            "trucks": c_truck.get("classifications", []),
        },
        "reconcile_summary": recon_summary,
    }
    compact_path = work / "decisions_production.json"
    compact_path.write_text(json.dumps(compact, indent=2, default=str))

    def _count(cls_list, klass):
        return sum(1 for c in cls_list if c.get("class") == klass)
    all_cls = [c for sec in compact["sections"].values() for c in sec]
    noop = sum(_count(sec, "DUPLICATE_NOOP") for sec in compact["sections"].values())
    new = sum(_count(sec, "NEW") for sec in compact["sections"].values())
    changed = sum(_count(sec, "VALUE_CHANGED") for sec in compact["sections"].values())
    malformed = sum(_count(sec, "MALFORMED") for sec in compact["sections"].values())

    preview = [{"action": c.get("class"), "natural_key": json.dumps(c.get("natural_key"), default=str),
                "summary": "; ".join(c.get("reasons", []))[:120]}
               for c in all_cls if c.get("class") in ("NEW", "VALUE_CHANGED", "MALFORMED")][:20]

    oc.progress("classify",
                f"{noop} already recorded · {new} new · {changed} changed"
                + (f" · {malformed} to review" if malformed else ""),
                pct=92)
    oc.progress("finalize", "Review ready — nothing written yet.", pct=100)

    oc.emit(oc.classify_envelope(
        report_type=REPORT_TYPE, ok=True, gate_failures=[],
        counts={"noop": noop, "insert": new, "update": changed, "flagged": malformed},
        rows_preview=preview, classified_path=str(compact_path),
        source={"email_subject": (mc_email or ivy_email or {}).get("subject"),
                "email_uid": (mc_email or ivy_email or {}).get("uid")},
        watermark=watermark, codified_rules_applied=CODIFIED_RULES,
        extra={"reconcile_summary": recon_summary,
               "per_section": {k: len(v) for k, v in compact["sections"].items()}}))
    return 0


def _prov(table, extra=""):
    base = f"provenance=production-sync | Ingested by sync_production.py (lean orchestrator) into {table} on {oc.RUN_TS}."
    return base + (f" {extra}" if extra else "")


def phase_apply(args) -> int:
    compact = json.loads(Path(args.input).read_text())
    db = DBClient()
    sections = compact["sections"]
    held: list[dict] = []
    errors: list[str] = []
    inserts = updates = 0

    def _norm(s):
        return (str(s).strip().upper() if s is not None else s)

    oc.progress("apply", "Setting up production shifts…", pct=15)

    # --- 1. collect distinct shift triplets needing upsert from runs+downtime+waste NEW rows ---
    triplets: dict[tuple, dict] = {}
    for sec_name in ("runs", "downtime", "waste"):
        for c in sections.get(sec_name, []):
            if c.get("class") == "NEW" and c.get("needs_shift_upsert"):
                rec = c.get("record", {})
                key = (rec.get("transaction_date"), _norm(rec.get("production_batch")), _norm(rec.get("shift")))
                triplets.setdefault(key, {"transaction_date": rec.get("transaction_date"),
                                          "production_batch": rec.get("production_batch"),
                                          "shift": rec.get("shift")})
    shift_map: dict[tuple, str] = {}
    for key, payload in triplets.items():
        try:
            res = db.insert_if_absent("production_shifts", [payload],
                                      natural_key=("transaction_date", "production_batch", "shift"))
            if res["inserted"]:
                sid = res["inserted"][0]["id"]
                db.insert_manual_audit(table_name="production_shifts", record_id=sid, operation="INSERT",
                                       comment=_prov("production_shifts"), snapshot=payload)
            else:
                existing = db.select_one("production_shifts",
                                         {"transaction_date": f"eq.{payload['transaction_date']}",
                                          "production_batch": f"eq.{payload['production_batch']}",
                                          "shift": f"eq.{payload['shift']}"}, columns="id")
                sid = existing["id"] if existing else None
            if sid:
                shift_map[key] = sid
        except Exception as exc:  # noqa: BLE001
            errors.append(f"shift upsert {key}: {exc}")

    def _resolve_shift(c) -> str | None:
        if c.get("resolved_shift_id"):
            return c["resolved_shift_id"]
        rec = c.get("record", {})
        return shift_map.get((rec.get("transaction_date"), _norm(rec.get("production_batch")), _norm(rec.get("shift"))))

    oc.progress("apply", "Writing production runs, downtime, and waste…", pct=40)

    # --- 2. children (runs / downtime / waste) ---
    # L-026: combine duplicate (shift_id, customer, grade) NEW run rows before insert.
    run_news = [c for c in sections.get("runs", []) if c.get("class") == "NEW"]
    combined: dict[tuple, dict] = {}
    for c in run_news:
        sid = _resolve_shift(c)
        if not sid:
            held.append({"reason": "unresolved_shift", "natural_key": json.dumps(c.get("natural_key"), default=str),
                         "detail": "run NEW without resolvable shift_id"})
            continue
        rec = c.get("record", {})
        k = (sid, _norm(rec.get("customer")), _norm(rec.get("grade")))
        if k in combined:  # L-026 combine
            combined[k]["ttl_kg"] = (combined[k].get("ttl_kg") or 0) + (rec.get("ttl_kg") or 0)
            combined[k]["sacks_bags"] = (combined[k].get("sacks_bags") or 0) + (rec.get("sacks_bags") or 0)
            combined[k]["remarks"] = "; ".join(filter(None, [combined[k].get("remarks"), rec.get("remarks")]))
        else:
            combined[k] = {"shift_id": sid, "customer": rec.get("customer"), "grade": rec.get("grade"),
                           "ttl_kg": rec.get("ttl_kg"), "sacks_bags": rec.get("sacks_bags"), "remarks": rec.get("remarks")}
    for payload in combined.values():
        try:
            res = db.insert_if_absent("production_runs", [payload], natural_key=("shift_id", "customer", "grade"))
            if res["inserted"]:
                nid = res["inserted"][0]["id"]; inserts += 1
                db.insert_manual_audit(table_name="production_runs", record_id=nid, operation="INSERT",
                                       comment=_prov("production_runs"), snapshot=payload)
            else:
                held.append({"reason": "already_exists", "natural_key": f"{payload['shift_id']}|{payload['customer']}|{payload['grade']}",
                             "detail": "idempotent skip"})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"run insert {payload.get('customer')}/{payload.get('grade')}: {exc}")

    for sec_name, cols, nkey in (
        ("downtime", ["shift_hrs", "dt_hrs", "dt_mins", "dt_reason"], ("shift_id",)),  # production_downtime has NO remarks col
        ("waste", [*WASTE_STREAMS, "remarks"], ("shift_id",)),
    ):
        for c in sections.get(sec_name, []):
            if c.get("class") != "NEW":
                continue
            sid = _resolve_shift(c)
            if not sid:
                held.append({"reason": "unresolved_shift", "natural_key": sec_name,
                             "detail": f"{sec_name} NEW without resolvable shift_id"})
                continue
            rec = c.get("record", {})
            payload = {"shift_id": sid, **{col: rec.get(col) for col in cols}}
            try:
                res = db.insert_if_absent(f"production_{sec_name}", [payload], natural_key=nkey)
                if res["inserted"]:
                    nid = res["inserted"][0]["id"]; inserts += 1
                    db.insert_manual_audit(table_name=f"production_{sec_name}", record_id=nid, operation="INSERT",
                                           comment=_prov(f"production_{sec_name}"), snapshot=payload)
                else:
                    held.append({"reason": "already_exists_or_collision", "natural_key": f"{sec_name}:{sid}",
                                 "detail": f"{sec_name} UNIQUE(shift_id) already present — held (L-028/L-007 collision review)"})
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{sec_name} insert shift {sid}: {exc}")

    oc.progress("apply", "Writing electricity and truck readings…", pct=62)

    # --- 3. electricity + trucks (natural-key, no shift; never write generated cols) ---
    for sec_name, cols, nkey in (
        ("electricity_readings", ["reading_date", "meter", "start_kwh", "end_kwh", "meter_multiplier", "remarks"], ("reading_date", "meter")),
        ("truck_readings", ["reading_date", "plate_no", "start_km", "end_km", "fuel_liters", "remarks"], ("reading_date", "plate_no")),
    ):
        for c in sections.get(sec_name.split("_")[0] if sec_name == "electricity_readings" else "trucks", []):
            if c.get("class") != "NEW":
                continue
            rec = c.get("record", {})
            payload = {col: rec.get(col) for col in cols}
            try:
                res = db.insert_if_absent(sec_name, [payload], natural_key=nkey)
                if res["inserted"]:
                    nid = res["inserted"][0]["id"]; inserts += 1
                    db.insert_manual_audit(table_name=sec_name, record_id=nid, operation="INSERT",
                                           comment=_prov(sec_name), snapshot=payload)
                else:
                    held.append({"reason": "already_exists", "natural_key": f"{sec_name}",
                                 "detail": "idempotent skip"})
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{sec_name} insert: {exc}")

    oc.progress("apply", "Applying changed rows…", pct=78)

    # --- VALUE_CHANGED (all sections) → UPDATE existing_id + manual audit ---
    table_for = {"runs": "production_runs", "downtime": "production_downtime", "waste": "production_waste",
                 "electricity": "electricity_readings", "trucks": "truck_readings"}
    for sec_name, tbl in table_for.items():
        for c in sections.get(sec_name, []):
            if c.get("class") != "VALUE_CHANGED" or not c.get("existing_id"):
                continue
            diff = c.get("diff") or {}
            patch = {f: (v.get("new") if isinstance(v, dict) else v) for f, v in diff.items()}
            # never write generated columns
            for gen in ("diff_kwh", "consumption_kwh", "ttl_km"):
                patch.pop(gen, None)
            if not patch:
                continue
            try:
                db.update(tbl, {"id": f"eq.{c['existing_id']}"}, patch, returning="minimal")
                updates += 1
                db.insert_manual_audit(table_name=tbl, record_id=c["existing_id"], operation="UPDATE",
                                       comment=_prov(tbl, "UPDATE"), diff=diff)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{tbl} update {c.get('existing_id')}: {exc}")

    # MALFORMED → held everywhere.
    for sec_name in sections:
        for c in sections[sec_name]:
            if c.get("class") == "MALFORMED":
                held.append({"reason": "malformed", "natural_key": sec_name,
                             "detail": "; ".join(c.get("reasons", [])) or "malformed row held"})

    watermark_updated = labeled = False
    if not errors:
        oc.progress("apply", "Updating the audit trail…", pct=90)
        watermark_updated = oc.upsert_ingestion_watermark(
            db, REPORT_TYPE, last_email_id=compact.get("source", {}).get("mc_thread_id"))
        if not args.no_label:
            uids = [u for u in (compact.get("source", {}).get("mc_uid"),
                                compact.get("source", {}).get("ivy_uid")) if u]
            if uids:
                oc.progress("apply", "Marking the email(s) as processed…", pct=95)
                labeled = oc.mark_processed(uids)

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
    ap = argparse.ArgumentParser(description="Lean two-phase production sync orchestrator (6 tables).")
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
