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


def phase_classify(args) -> int:
    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    xlsx_path = work_dir / "rc_gsheet.xlsx"
    ensure_workbook(work_dir, xlsx_path)

    # --- extract (reuse extract_gsheet) ---
    from openpyxl import load_workbook
    wb = load_workbook(filename=str(xlsx_path), data_only=True, read_only=True)
    if args.mode == "rc_in":
        extract = extract_gsheet.extract_rc_in(wb["RC IN"])
    else:
        extract = extract_gsheet.extract_rc_out(wb["RC OUT"])
    rows = extract["rows"]

    # --- fetch DB rows OURSELVES (never into the agent context) ---
    db = DBClient()
    if args.mode == "rc_in":
        db_rows = db.read_rows("deliveries", since_date=args.since, columns=DELIVERIES_COLS)
        classified = classify_gsheet.classify_rc_in(rows, db_rows, args.since)
    else:
        db_rows = db.read_rows("rc_out", since_date=args.since, columns=RC_OUT_COLS)
        # batch lookup: {batch_code: id}
        batches = db.read_rows("batches", columns=["batch_code", "id"], since_column=None)
        lookup = {b["batch_code"]: b["id"] for b in batches if b.get("batch_code")}
        # write the lookup for the apply phase to reuse (so it need not refetch)
        (work_dir / "batch_lookup.json").write_text(json.dumps(lookup, default=str))
        classified = classify_gsheet.classify_rc_out(rows, db_rows, lookup, args.since)

    # --- write full classified JSON (audit) — NEVER printed ---
    full_path = work_dir / f"{args.mode}_classified.json"
    full_path.write_text(json.dumps(classified, indent=2, default=str))

    # --- write COMPACT decisions (the only thing the agent reads) ---
    compact = build_compact(classified, args.mode)
    compact_path = work_dir / f"decisions_{args.mode}.json"
    compact_path.write_text(json.dumps(compact, indent=2, default=str))

    s = classified["summary"]
    # STDOUT: summary counts + compact path ONLY. Never the row set.
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


def phase_apply(args) -> int:
    decisions_path = Path(args.decisions)
    compact = json.loads(decisions_path.read_text())
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
                db.insert("batches", [{
                    "batch_code": bc,
                    "location_ref": r.get("block_loc") or "",
                    "status": "STORED", "current_weight": 0, "avg_cost": 0,
                }], returning="minimal")
                new_batches.append(bc)
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

    print(json.dumps({
        "ok": True, "phase": "apply", "mode": mode,
        "inserted": len(inserted_ids), "inserted_ids": inserted_ids,
        "updated": len(updated_ids), "updated_ids": updated_ids,
        "new_batches_created": new_batches,
        "flagged_resolved": flagged_resolved,
        "skipped": skipped,
    }, indent=2))
    return 0


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="Lean two-phase gsheet-sync orchestrator.")
    ap.add_argument("--phase", required=True, choices=["classify", "apply"])
    ap.add_argument("--mode", choices=["rc_in", "rc_out"])
    ap.add_argument("--since", default=classify_gsheet.DEFAULT_SINCE)
    ap.add_argument("--work-dir", help="Work directory (classify phase). Default /tmp/gsheet-sync/<ts>.")
    ap.add_argument("--decisions", help="Approved compact decisions JSON (apply phase).")
    args = ap.parse_args()

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
