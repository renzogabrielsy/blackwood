#!/usr/bin/env python3
"""
Lean two-phase orchestrator for gsheet-sync.

Goal: keep the LLM agent's context window tiny. The agent never cats the full DB
dump or the full classified JSON. Python does ALL the heavy lifting:
  - pulls the Sheet (reusing extract_gsheet.py)
  - fetches in-scope DB rows ITSELF via lib/db.py (PostgREST, service-role) — these
    rows never enter the agent's context
  - runs the EXISTING classify logic (imported from classify_gsheet.py — diff rules
    are NOT duplicated here)
  - emits a COMPACT `decisions_<mode>.json` containing ONLY actionable items
    (NEW, material VALUE_CHANGED, FLAGGED, MALFORMED, UNMAPPED) + a summary block.
  - the full classified JSON is still written to disk for audit, but is NEVER printed.

Phases
------
--phase classify --mode rc_in|rc_out --since 2025-01-01
    Pull Sheet + DB, classify, write full classified JSON (audit) + compact
    decisions_<mode>.json. Print to STDOUT only: summary counts + path to the
    compact file. READ-ONLY. No DB writes.

--phase apply --decisions <approved.json>
    Take an approved compact decisions file (optionally with per-row "skip": true
    flags the agent set, and per-flagged/unmapped "decision" fields) and perform the
    writes + audit logs DETERMINISTICALLY via lib/db.py:
      - RC IN NEW   -> INSERT deliveries (cost_basis=0 placeholder per L-008), then
                       UPDATE the trigger-written audit row for provenance (L-001).
                       NEVER touch current_weight (trigger owns it, L-005/L-006).
      - RC OUT NEW  -> INSERT rc_out, then INSERT a manual audit row (rc_out has no
                       audit trigger).
      - material VALUE_CHANGED -> UPDATE only the differing fields (Sheet-wins),
                       never cost_basis; audit accordingly.
      - FLAGGED / UNMAPPED rows are NEVER written unless an explicit per-row decision
        is present in the approved file. Default = skip.
    Print a compact result. (This script does NOT run --phase apply automatically;
    the agent invokes it only after Renzo approves.)

Usage:
    python3 sync_gsheet.py --phase classify --mode rc_in  --since 2025-01-01 --work-dir /tmp/gsheet-sync/<ts>
    python3 sync_gsheet.py --phase classify --mode rc_out --since 2025-01-01 --work-dir /tmp/gsheet-sync/<ts>
    python3 sync_gsheet.py --phase apply --decisions /tmp/gsheet-sync/<ts>/decisions_rc_in.json
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR / "lib"))

# Reuse the proven extract + classify logic — do NOT re-implement diff rules.
import extract_gsheet  # noqa: E402
import classify_gsheet  # noqa: E402
from lib.db import DBClient  # noqa: E402
import lib.orchestrator_common as oc  # noqa: E402  (contract envelopes + ingestion_watermarks)

GSHEET_FILE_ID = "1yBZ0wW0DTr4ktYYtDIgXSVVoGsiETawyppkdyV1EiMM"
GSHEET_EXPORT_URL = (
    f"https://docs.google.com/spreadsheets/d/{GSHEET_FILE_ID}/export?format=xlsx"
)

# Columns we actually need from the DB (keeps the PostgREST payload lean too).
DELIVERIES_COLS = [
    "id", "transaction_date", "supplier", "batch_code", "block_loc",
    "truck_plate", "sacks", "weight_kg", "cost_basis", "remarks", "lab_results",
]
RC_OUT_COLS = [
    "id", "transaction_date", "batch_id", "production_batch", "destination",
    "weight_kg", "block_loc", "remarks",
]


# ---------------------------------------------------------------------------
# Compact decisions builder — the ONLY thing the agent reads.
# ---------------------------------------------------------------------------
def _compact_rc_in_new(item: dict) -> dict:
    r = item["row"]
    return {
        "kind": "NEW",
        "index": item.get("index"),
        "date": r.get("transaction_date"),
        "batch_code": r.get("batch_code_resolved") or r.get("batch_code_primary"),
        "block_loc": r.get("block_loc"),
        "weight_kg": r.get("weight_kg"),
        "supplier": r.get("supplier"),
        "truck_plate": r.get("truck_plate"),
        "sacks": r.get("sacks"),
        "remarks": r.get("remarks"),
        "lab_results": r.get("lab_results"),
        "confidence": r.get("confidence"),
    }


def _compact_rc_out_new(item: dict) -> dict:
    r = item["row"]
    return {
        "kind": "NEW",
        "index": item.get("index"),
        "date": r.get("transaction_date"),
        "batch_code": r.get("batch_code_resolved") or r.get("batch_code_primary"),
        "batch_id": r.get("batch_id"),
        "destination": r.get("destination"),
        "weight_kg": r.get("weight_kg"),
        "production_batch": r.get("production_batch"),
        "block_loc": r.get("block_loc"),
        "remarks": r.get("remarks"),
        "confidence": r.get("confidence"),
    }


def _compact_changed(item: dict, mode: str) -> dict:
    r = item.get("row", {})
    bc = r.get("batch_code_resolved") or r.get("batch_code_primary")
    diffs = [
        {"field": d["field"], "db": d.get("dbValue"), "sheet": d.get("sheetValue")}
        for d in item.get("diff", [])
    ]
    out = {
        "kind": "VALUE_CHANGED",
        "index": item.get("index"),
        "db_id": item.get("db_id"),
        "date": r.get("transaction_date"),
        "batch_code": bc,
        "diff": diffs,
    }
    if mode == "rc_in":
        out["block_loc"] = r.get("block_loc")
    else:
        out["destination"] = r.get("destination")
    return out


def _compact_flagged(item: dict) -> dict:
    conflicts = item.get("db_conflicts", [])
    return {
        "kind": "FLAGGED",
        "index": item.get("index"),
        "flag_kind": item.get("kind"),
        "reason": item.get("reason"),
        "db_conflict_ids": [c.get("id") for c in conflicts],
        "db_conflict_batches": [c.get("batch_code") for c in conflicts],
        # decision is filled in by the agent/Renzo: 'skip' | 'insert' | 'reassign:<db_id>'
        "decision": "skip",
    }


def _compact_unmapped(item: dict) -> dict:
    r = item.get("row", {})
    return {
        "kind": "UNMAPPED",
        "index": item.get("index"),
        "date": r.get("transaction_date"),
        "batch_code_primary": r.get("batch_code_primary"),
        "batch_code_fallbacks": r.get("batch_code_fallbacks"),
        "weight_kg": r.get("weight_kg"),
        "reason": item.get("reason"),
        # decision: a real batch_code to use, or 'skip'
        "decision": "skip",
    }


def _compact_malformed(item: dict) -> dict:
    r = item.get("row", {})
    return {
        "kind": "MALFORMED",
        "date": r.get("transaction_date"),
        "batch_code": r.get("batch_code_primary"),
        "weight_kg": r.get("weight_kg"),
        "reason": item.get("reason"),
    }


def build_compact(classified: dict, mode: str) -> dict:
    """Reduce the full classified bundle to ONLY actionable items + a summary."""
    new_fn = _compact_rc_in_new if mode == "rc_in" else _compact_rc_out_new
    return {
        "mode": mode,
        "since": classified.get("since"),
        "summary": classified["summary"],  # counts only — NOOP/out-of-scope kept as numbers
        "actionable": {
            "new": [new_fn(i) for i in classified.get("new", [])],
            "changed": [_compact_changed(i, mode) for i in classified.get("changed", [])],
            "flagged": [_compact_flagged(i) for i in classified.get("flagged", [])],
            "unmapped": [_compact_unmapped(i) for i in classified.get("unmapped", [])],
            "malformed": [_compact_malformed(i) for i in classified.get("malformed", [])],
        },
    }


# ---------------------------------------------------------------------------
# CLASSIFY phase
# ---------------------------------------------------------------------------
def ensure_workbook(work_dir: Path, xlsx_path: Path) -> None:
    """Download the Sheet once per work_dir (reused across rc_in + rc_out)."""
    if xlsx_path.exists() and xlsx_path.stat().st_size > 0:
        return
    work_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["curl", "-sL", GSHEET_EXPORT_URL, "-o", str(xlsx_path)],
        check=True,
    )
    head = xlsx_path.read_bytes()[:2]
    if head != b"PK":
        raise RuntimeError(
            "Sheet not reachable as XLSX (got an HTML login page?). "
            "It may have gone restricted — re-share as 'anyone with link'."
        )


def _classify_one_mode(work_dir: Path, mode: str, since: str) -> tuple[dict, Path, dict]:
    """
    Core per-mode classify (shared by the legacy CLI and the contract CLI). Downloads the
    Sheet once per work_dir, classifies one mode against the live DB, writes the full
    classified JSON (audit) + the compact decisions file, and returns
    (compact_dict, compact_path, classified_summary). Prints NOTHING.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    xlsx_path = work_dir / "rc_gsheet.xlsx"
    ensure_workbook(work_dir, xlsx_path)

    from openpyxl import load_workbook
    wb = load_workbook(filename=str(xlsx_path), data_only=True, read_only=True)
    if mode == "rc_in":
        extract = extract_gsheet.extract_rc_in(wb["RC IN"])
    else:
        extract = extract_gsheet.extract_rc_out(wb["RC OUT"])
    rows = extract["rows"]

    db = DBClient()
    if mode == "rc_in":
        db_rows = db.read_rows("deliveries", since_date=since, columns=DELIVERIES_COLS)
        classified = classify_gsheet.classify_rc_in(rows, db_rows, since)
    else:
        db_rows = db.read_rows("rc_out", since_date=since, columns=RC_OUT_COLS)
        batches = db.read_rows("batches", columns=["batch_code", "id"], since_column=None)
        lookup = {b["batch_code"]: b["id"] for b in batches if b.get("batch_code")}
        (work_dir / "batch_lookup.json").write_text(json.dumps(lookup, default=str))
        classified = classify_gsheet.classify_rc_out(rows, db_rows, lookup, since)

    full_path = work_dir / f"{mode}_classified.json"
    full_path.write_text(json.dumps(classified, indent=2, default=str))

    compact = build_compact(classified, mode)
    compact_path = work_dir / f"decisions_{mode}.json"
    compact_path.write_text(json.dumps(compact, indent=2, default=str))
    return compact, compact_path, classified["summary"]


def phase_classify(args) -> int:
    compact, compact_path, s = _classify_one_mode(Path(args.work_dir), args.mode, args.since)
    full_path = Path(args.work_dir) / f"{args.mode}_classified.json"
    # STDOUT: summary counts + compact path ONLY. Never the row set. (LEGACY output shape.)
    print(json.dumps({
        "ok": True,
        "phase": "classify",
        "mode": args.mode,
        "since": args.since,
        "summary": {
            "extracted_total": s["extracted_total"],
            "out_of_scope": s["out_of_scope_count"],
            "in_scope": s["in_scope_total"],
            "noop": s["noop_count"],
            "new": s["new_count"],
            "changed": s["changed_count"],
            "flagged": s["flagged_count"],
            "unmapped": s["unmapped_count"],
            "malformed": s["malformed_count"],
            "db_rows_in_window": s["db_rows_in_window"],
        },
        "decisions_file": str(compact_path),
        "full_classified_file_for_audit_only": str(full_path),
        "actionable_total": (s["new_count"] + s["changed_count"] + s["flagged_count"]
                             + s["unmapped_count"] + s["malformed_count"]),
    }, indent=2))
    return 0


# ---------------------------------------------------------------------------
# APPLY phase  (deterministic write-back — agent invokes only after approval)
# ---------------------------------------------------------------------------
RUN_TS = datetime.now(timezone.utc).isoformat()


def _provenance_comment(mode: str, index: Any, note_extra: str = "") -> str:
    tab = "RC IN" if mode == "rc_in" else "RC OUT"
    base = (f"provenance=gsheet | Ingested by gsheet-sync (lean orchestrator) from Google Sheet "
            f"(file {GSHEET_FILE_ID}, tab {tab}, row {index}) on {RUN_TS}. "
            f"Sheet = source of truth (2025+ scope).")
    return base + (f" {note_extra}" if note_extra else "")


def _apply_from_compact(compact: dict) -> dict:
    """
    Core deterministic apply for one mode's compact decisions dict. Returns the legacy
    result dict (inserted/updated ids, new_batches, flagged_resolved, skipped). Prints
    NOTHING — shared by the legacy CLI and the contract CLI.
    """
    mode = compact["mode"]
    actionable = compact["actionable"]
    db = DBClient()

    inserted_ids: list[str] = []
    updated_ids: list[str] = []
    skipped: list[dict] = []
    new_batches: list[str] = []

    # --- Safety gate: too many NEW rows means the scope/window is wrong. ---
    new_rows = [r for r in actionable["new"] if not r.get("skip")]
    if len(new_rows) > 50:
        print(json.dumps({"ok": False, "error": f"Too many NEW rows ({len(new_rows)}) for auto-write. Route to manual triage."}))
        return 1
    low_conf = [r for r in new_rows if (r.get("confidence") or 1.0) < 0.7]
    if low_conf:
        print(json.dumps({"ok": False, "error": f"{len(low_conf)} NEW rows below confidence 0.7 — manual review required.",
                          "indexes": [r.get("index") for r in low_conf]}))
        return 1

    # --- NEW rows ---
    for r in new_rows:
        if mode == "rc_in":
            bc = r["batch_code"]
            # defensive batch upsert (current_weight starts 0; trigger maintains it)
            existing = db.select_one("batches", {"batch_code": f"eq.{bc}"}, columns="batch_code")
            if not existing:
                try:
                    db.insert("batches", [{
                        "batch_code": bc,
                        "location_ref": r.get("block_loc") or "",
                        "status": "STORED", "current_weight": 0, "avg_cost": 0,
                    }], returning="minimal")
                    new_batches.append(bc)
                except Exception as bexc:  # noqa: BLE001
                    # block_loc already holds an active batch → skip (held), don't abort the mode.
                    if oc.is_location_collision(bexc):
                        skipped.append({"index": r.get("index"),
                                        "why": f"location_occupied: block_loc {r.get('block_loc')} already "
                                               f"holds an active batch; new batch {bc} not created — resolve the slot"})
                        continue
                    raise
            payload = {
                "transaction_date": r["date"],
                "supplier": r.get("supplier"),
                "batch_code": bc,
                "block_loc": r.get("block_loc"),
                "truck_plate": r.get("truck_plate"),
                "sacks": r.get("sacks"),
                "weight_kg": r["weight_kg"],
                "cost_basis": 0,  # L-008 placeholder; deliveries-manager enriches from Czarina
                "remarks": r.get("remarks"),
                "lab_results": r.get("lab_results"),
            }
            ins = db.insert("deliveries", [payload])
            new_id = ins[0]["id"]
            inserted_ids.append(new_id)
            # L-001: trigger already wrote the audit row — UPDATE it for provenance.
            db.update_trigger_audit_provenance(
                "deliveries", new_id,
                _provenance_comment(mode, r.get("index"),
                                    "cost_basis=0 is an UNPRICED PLACEHOLDER (L-008) — "
                                    "deliveries-manager to enrich from Czarina/email."),
                snapshot=payload,
            )
        else:  # rc_out
            if not r.get("batch_id"):
                skipped.append({"index": r.get("index"), "why": "NEW rc_out without resolved batch_id"})
                continue
            payload = {
                "transaction_date": r["date"],
                "batch_id": r["batch_id"],
                "destination": r.get("destination") or "MAIN",
                "weight_kg": r["weight_kg"],
                "remarks": r.get("remarks"),
                "block_loc": r.get("block_loc"),
                "production_batch": r.get("production_batch"),
            }
            ins = db.insert("rc_out", [payload])
            new_id = ins[0]["id"]
            inserted_ids.append(new_id)
            # rc_out has NO audit trigger — insert manually.
            db.insert_manual_audit(
                table_name="rc_out", record_id=new_id, operation="INSERT",
                comment=_provenance_comment(mode, r.get("index")),
                snapshot=payload,
            )

    # --- material VALUE_CHANGED (Sheet-wins) ---
    for r in actionable["changed"]:
        if r.get("skip"):
            skipped.append({"index": r.get("index"), "why": "agent set skip on changed"})
            continue
        db_id = r["db_id"]
        patch: dict[str, Any] = {}
        for d in r["diff"]:
            f = d["field"]
            if f == "cost_basis":
                continue  # never written by gsheet-sync
            patch[f] = d["sheet"]
        if not patch:
            continue
        table = "deliveries" if mode == "rc_in" else "rc_out"
        db.update(table, {"id": f"eq.{db_id}"}, patch, returning="minimal")
        updated_ids.append(db_id)
        diff_json = {d["field"]: {"old": d["db"], "new": d["sheet"]} for d in r["diff"]}
        if mode == "rc_in":
            # deliveries: no UPDATE trigger assumed — record provenance on the existing
            # INSERT audit row if present, else add a manual one.
            ok = db.update_trigger_audit_provenance(
                "deliveries", db_id,
                _provenance_comment(mode, r.get("index"), f"Sheet-wins UPDATE diff={json.dumps(diff_json, default=str)}"),
            )
            if not ok:
                db.insert_manual_audit(table_name="deliveries", record_id=db_id, operation="UPDATE",
                                       comment=_provenance_comment(mode, r.get("index"), "Sheet-wins UPDATE"),
                                       diff=diff_json)
        else:
            db.insert_manual_audit(table_name="rc_out", record_id=db_id, operation="UPDATE",
                                   comment=_provenance_comment(mode, r.get("index"), "Sheet-wins UPDATE"),
                                   diff=diff_json)

    # --- FLAGGED rows: ONLY per explicit decision (default skip; never delete) ---
    flagged_resolved: list[dict] = []
    for r in actionable["flagged"]:
        decision = (r.get("decision") or "skip").strip()
        if decision == "skip":
            skipped.append({"index": r.get("index"), "why": "flagged left as skip"})
            continue
        if decision == "insert":
            skipped.append({"index": r.get("index"),
                            "why": "flagged decision=insert requires re-running with this row promoted to NEW — not auto-handled here"})
            continue
        if decision.startswith("reassign:"):
            target_id = decision.split(":", 1)[1]
            # reassignment never deletes — UPDATE the existing DB row's batch.
            # (left as an explicit, audited manual op; we do not guess the new batch_id field here.)
            flagged_resolved.append({"index": r.get("index"), "reassign_to": target_id,
                                     "note": "reassignment must be applied as a reviewed single UPDATE; not auto-executed"})
            continue
        skipped.append({"index": r.get("index"), "why": f"unknown flagged decision '{decision}'"})

    # --- UNMAPPED: only if a real batch_code decision was supplied ---
    for r in actionable["unmapped"]:
        decision = (r.get("decision") or "skip").strip()
        if decision == "skip":
            skipped.append({"index": r.get("index"), "why": "unmapped left as skip — never auto-create a batch"})
        else:
            skipped.append({"index": r.get("index"),
                            "why": f"unmapped decision='{decision}' requires re-classify with corrected batch_code"})

    return {
        "ok": True, "phase": "apply", "mode": mode,
        "inserted": len(inserted_ids), "inserted_ids": inserted_ids,
        "updated": len(updated_ids), "updated_ids": updated_ids,
        "new_batches_created": new_batches,
        "flagged_resolved": flagged_resolved,
        "skipped": skipped,
    }


def phase_apply(args) -> int:
    """LEGACY apply CLI (`--phase apply --decisions <file>`). Byte-identical output."""
    compact = json.loads(Path(args.decisions).read_text())
    print(json.dumps(_apply_from_compact(compact), indent=2))
    return 0


# ---------------------------------------------------------------------------
# CONTRACT phase (SYNC_CLI_CONTRACT.md) — the in-app Run Sync button path.
# report_type "gsheet"; runs BOTH rc_in + rc_out in one invocation; NO Gmail label
# (it's a Sheet, not email) → labeled:false always; still upserts ingestion_watermarks.
# ---------------------------------------------------------------------------
REPORT_TYPE = "gsheet"
CODIFIED_RULES = [
    "rounding-null-zero-noop", "sheet-wins-material-value-changed", "L-004", "L-008",
    "L-013", "L-018", "batch_code-fallback-prefixes", "never-auto-create-batch",
    "never-delete", "2025-scope-floor",
]


def phase_classify_contract(work_dir: Path, since: str) -> int:
    """Run rc_in + rc_out classify, emit ONE contract classify envelope (report_type gsheet)."""
    modes_out: dict[str, dict] = {}
    combined_actionable: dict[str, list] = {}
    totals = {"noop": 0, "insert": 0, "update": 0, "flagged": 0}
    preview: list[dict] = []

    for mode in ("rc_in", "rc_out"):
        compact, _cpath, s = _classify_one_mode(work_dir, mode, since)
        modes_out[mode] = compact
        totals["noop"] += s["noop_count"]
        totals["insert"] += s["new_count"]
        totals["update"] += s["changed_count"]
        totals["flagged"] += s["flagged_count"] + s["unmapped_count"] + s["malformed_count"]
        a = compact["actionable"]
        for k in ("new", "changed", "flagged", "unmapped", "malformed"):
            combined_actionable.setdefault(k, []).extend(
                [{**item, "_mode": mode} for item in a.get(k, [])])
        for item in a.get("new", []):
            preview.append({"action": "INSERT", "natural_key": f"{mode}:{item.get('batch_code')}|{item.get('date')}",
                            "summary": f"{item.get('weight_kg')}kg"})
        for item in a.get("changed", []):
            preview.append({"action": "UPDATE", "natural_key": f"{mode}:{item.get('db_id')}",
                            "summary": f"{item.get('date')} diff={[d['field'] for d in item.get('diff', [])]}"})
        for item in a.get("flagged", []) + a.get("unmapped", []):
            preview.append({"action": "FLAGGED", "natural_key": f"{mode}:{item.get('index')}",
                            "summary": item.get("reason") or item.get("flag_kind") or "flagged"})

    # ONE combined classified file holding both modes' compacts — the apply --input.
    combined = {"report_type": REPORT_TYPE, "since": since, "modes": modes_out}
    combined_path = work_dir / "decisions_gsheet.json"
    combined_path.write_text(json.dumps(combined, indent=2, default=str))

    oc.emit(oc.classify_envelope(
        report_type=REPORT_TYPE, ok=True, gate_failures=[], counts=totals,
        rows_preview=preview, classified_path=str(combined_path),
        source={"email_subject": f"Google Sheet {GSHEET_FILE_ID} (RC IN + RC OUT tabs)",
                "email_uid": None},
        watermark=since, codified_rules_applied=CODIFIED_RULES,
        extra={"per_mode": {m: {"new": modes_out[m]["summary"]["new_count"],
                                "changed": modes_out[m]["summary"]["changed_count"],
                                "flagged": (modes_out[m]["summary"]["flagged_count"]
                                            + modes_out[m]["summary"]["unmapped_count"]
                                            + modes_out[m]["summary"]["malformed_count"])}
                            for m in modes_out}}))
    return 0


def phase_apply_contract(input_path: str) -> int:
    """Apply both modes' clean rows from the combined file; emit ONE contract apply envelope."""
    combined = json.loads(Path(input_path).read_text())
    modes = combined.get("modes", {})
    total_inserts = total_updates = 0
    held: list[dict] = []
    errors: list[str] = []

    for mode, compact in modes.items():
        try:
            # _apply_from_compact honors only top-level "skip"; FLAGGED/UNMAPPED default to
            # skip (never auto-written) — exactly the --only-clean contract. Sheet-wins
            # material VALUE_CHANGED is applied (locked policy); rounding/null↔0 already NOOP.
            res = _apply_from_compact(compact)
            total_inserts += res.get("inserted", 0)
            total_updates += res.get("updated", 0)
            for sk in res.get("skipped", []):
                held.append({"reason": "skipped", "natural_key": f"{mode}:{sk.get('index')}",
                             "detail": sk.get("why")})
            for fr in res.get("flagged_resolved", []):
                held.append({"reason": "flagged_needs_manual_apply", "natural_key": f"{mode}:{fr.get('index')}",
                             "detail": fr.get("note")})
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{mode} apply: {exc}")

    watermark_updated = False
    if not errors:
        # Sheet, not email → last_email_id is null; never label Gmail for gsheet.
        watermark_updated = oc.upsert_ingestion_watermark(DBClient(), REPORT_TYPE, last_email_id=None)

    oc.emit(oc.apply_envelope(
        report_type=REPORT_TYPE, ok=not errors, inserts=total_inserts, updates=total_updates,
        held=held, labeled=False, watermark_updated=watermark_updated, errors=errors))
    return 0 if not errors else 1


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="Lean two-phase gsheet-sync orchestrator.")
    ap.add_argument("--phase", required=True, choices=["classify", "apply"])
    ap.add_argument("--mode", choices=["rc_in", "rc_out"])
    ap.add_argument("--since", default=classify_gsheet.DEFAULT_SINCE)
    ap.add_argument("--work-dir", help="Work directory (classify phase). Default /tmp/gsheet-sync/<ts>.")
    ap.add_argument("--decisions", help="Approved compact decisions JSON (LEGACY apply phase).")
    # Contract CLI (in-app Run Sync button) — see SYNC_CLI_CONTRACT.md.
    ap.add_argument("--json", action="store_true",
                    help="Emit the SYNC_CLI_CONTRACT envelope (combined rc_in+rc_out). "
                         "When set on classify WITHOUT --mode, runs both modes.")
    ap.add_argument("--input", help="Combined classified JSON (contract apply phase).")
    ap.add_argument("--only-clean", action="store_true",
                    help="Apply only rows passing every codified rule; flagged/uncertain → held.")
    ap.add_argument("--no-label", action="store_true", help="(gsheet never labels; accepted for parity.)")
    args = ap.parse_args()

    # ---- CONTRACT path: --json AND --mode omitted (the button) ----
    if args.json and not args.mode:
        if not args.work_dir:
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            args.work_dir = f"/tmp/gsheet-sync/{ts}"
        if args.phase == "classify":
            Path(args.work_dir).mkdir(parents=True, exist_ok=True)
            return phase_classify_contract(Path(args.work_dir), args.since)
        else:
            if not args.input:
                oc.emit({"report_type": REPORT_TYPE, "ok": False,
                         "errors": ["--input required for contract apply"]})
                return 2
            return phase_apply_contract(args.input)

    # ---- LEGACY path (employee CLI) — byte-identical to before ----
    if args.phase == "classify":
        if not args.mode:
            print(json.dumps({"ok": False, "error": "--mode required for classify"}), file=sys.stderr)
            return 2
        if not args.work_dir:
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            args.work_dir = f"/tmp/gsheet-sync/{ts}"
        return phase_classify(args)
    else:
        if not args.decisions:
            print(json.dumps({"ok": False, "error": "--decisions required for apply"}), file=sys.stderr)
            return 2
        return phase_apply(args)


if __name__ == "__main__":
    sys.exit(main())
