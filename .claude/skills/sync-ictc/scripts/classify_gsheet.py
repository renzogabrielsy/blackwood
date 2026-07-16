#!/usr/bin/env python3
"""
GSHEET classifier — forward-only alignment of Sheet RC IN / RC OUT against the
live Blackwood DB. PROPOSE / dry-run only: emits buckets, never writes.

LOCKED POLICY (Renzo, 2026-05-30) encoded here:
  1. SCOPE = 2025-01-01 onward (`--since`, default 2025-01-01). Sheet rows before
     the cutoff are SKIPPED entirely (out_of_scope bucket) — the Sheet's pre-2025
     legacy is incomplete. The DB's own pre-2025 rows are never matched, updated,
     or deleted by this tool.
  2. Sheet = SOURCE OF TRUTH for 2025+. NEW -> insert. VALUE_CHANGED -> Sheet wins
     (update DB to the Sheet). PURE/immaterial diffs (rounding, null<->empty) are
     demoted to NOOP so we never churn meaningless updates -> they land in the
     `noop` bucket (with `immaterial_note`), NOT the write plan.
  3. CONFLICT GUARDRAIL. A NEW Sheet row that collides with a DIFFERENT existing
     DB row on the same (date, [block]) at the SAME weight is treated as a likely
     batch REASSIGNMENT, not an edit. It is NOT auto-inserted (would double-count)
     and NEVER deletes a DB row — it goes to the `flagged` bucket for Renzo.

Outcomes per Sheet row:
  - DUPLICATE_NOOP : key present, all *material* fields agree -> nothing to do.
  - NEW            : key absent from DB -> would INSERT.
  - VALUE_CHANGED  : key present, >=1 *material* field differs -> Sheet-wins UPDATE.
  - FLAGGED        : NEW-but-collides (same date/block/weight as a different DB
                     batch) -> potential reassignment/double-count. Human decision.
  - UNMAPPED       : batch_code (primary + all fallbacks) doesn't resolve to a
                     known DB batch -> manual batch decision. NEVER auto-create.
  - MALFORMED      : missing a required field (date / batch / weight).
  - OUT_OF_SCOPE   : transaction_date < --since (skipped, reported as a count).

Natural keys
  RC IN  : (transaction_date, resolved_batch_code, block_loc, weight_kg~tol)
  RC OUT : (transaction_date, batch_id, destination)   [+ weight tolerance in diff]

Tolerance matching (decision #3): the Sheet may log one aggregated per-block
row where the DB/email logged several per-truck rows (or vice-versa). So for
RC IN we FIRST try an exact weight key; if that misses we retry the key with
weight dropped and, among the date+batch+block candidates, accept the closest
weight within WEIGHT_TOL_KG as a NOOP/CHANGED match and flag the aggregation
mismatch rather than calling it a hard NEW row.

Batch resolution
  RC IN  : resolve batch_code against the set of batch_codes that actually
           exist in the DB deliveries window (primary -> fallbacks).
  RC OUT : resolve batch_code -> batch_id via the batches lookup
           (primary -> fallbacks), mirroring classify_rc_out.py.

Usage:
  python3 classify_gsheet.py --mode rc_in \
      --extract-json /tmp/gsheet_sync/rc_in_extract.json \
      --db-rows-json /tmp/gsheet_sync/db_deliveries.json \
      --output /tmp/gsheet_sync/rc_in_classified.json [--verbose]

  python3 classify_gsheet.py --mode rc_out \
      --extract-json /tmp/gsheet_sync/rc_out_extract.json \
      --db-rows-json /tmp/gsheet_sync/db_rc_out.json \
      --batch-lookup-json /tmp/gsheet_sync/batch_lookup.json \
      --output /tmp/gsheet_sync/rc_out_classified.json [--verbose]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Weight tolerance for aggregation-mismatch matching (per-block vs per-truck).
WEIGHT_TOL_KG = 1.0       # exact-ish; numeric float noise
AGG_TOL_KG = 50.0         # accept as the "same event" when keys otherwise match
CONFLICT_TOL_KG = 1.0     # NEW-row collision detection: same weight within this

DEFAULT_SINCE = "2025-01-01"  # locked scope cutoff


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
def norm_str(s: Any) -> str | None:
    if s is None:
        return None
    s = str(s).strip()
    return s.lower() if s else None


def norm_block_loc(s: Any) -> str | None:
    if s is None:
        return None
    s = str(s).strip()
    return s.upper() if s else None


def norm_num(v: Any, places: int = 3) -> float | None:
    if v is None:
        return None
    try:
        return round(float(v), places)
    except (TypeError, ValueError):
        return None


def norm_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def deep_lab_equal(a: dict | None, b: dict | None) -> bool:
    """Lab JSONB comparison at 2-decimal precision (variable source precision)."""
    a = a or {}
    b = b or {}
    for k in set(a) | set(b):
        if norm_num(a.get(k), 2) != norm_num(b.get(k), 2):
            return False
    return True


# ---------------------------------------------------------------------------
# Material-change gate (LOCKED decision #2: skip pure-rounding / no-material diffs)
# ---------------------------------------------------------------------------
def _lab_diff_is_immaterial(sheet_lab: dict | None, db_lab: dict | None) -> bool:
    """
    True when a lab_results difference is just rounding/padding, not a real value
    change. Immaterial iff, for every key, the two values are either:
      - equal at INTEGER precision (the 2023/early rounding artifact:
        sheet mc=11.5 vs db mc=11 rounds-equal at 0 dp), OR
      - one side is null and the other is 0 (DB zero-padding), OR
      - one side is null and the other present but the other rounds to 0.
    Any pair that disagrees at integer precision AND isn't a null<->0 pad is MATERIAL.
    """
    a = sheet_lab or {}
    b = db_lab or {}
    for k in set(a) | set(b):
        va, vb = norm_num(a.get(k), 2), norm_num(b.get(k), 2)
        if va == vb:
            continue
        # null <-> 0 padding
        if (va is None and vb == 0) or (vb is None and va == 0):
            continue
        # one side missing entirely (DB lacks the metric the Sheet has, or vice
        # versa) — treat as immaterial only if the present value rounds to 0,
        # else it's a real new measurement and should win.
        if va is None or vb is None:
            present = va if vb is None else vb
            if norm_num(present, 0) == 0:
                continue
            return False
        # both present: immaterial only if equal at integer precision
        if norm_num(va, 0) != norm_num(vb, 0):
            return False
    return True


def is_material(diffs: list[dict]) -> tuple[bool, str | None]:
    """
    Decide whether a VALUE_CHANGED diff list warrants a Sheet-wins UPDATE.
    Returns (material, immaterial_note). Immaterial diffs are demoted to NOOP.

    Immaterial (skip) categories:
      - `sacks`: null <-> 0 (the Sheet leaves sacks blank on backlog rows).
      - `lab_results`: rounding/padding only (see _lab_diff_is_immaterial).
    Everything else (supplier, truck_plate, remarks, weight, real lab change,
    production_batch) is MATERIAL -> Sheet wins.
    """
    if not diffs:
        return False, None
    skipped: list[str] = []
    for d in diffs:
        f = d["field"]
        if f == "sacks":
            sv, dv = norm_int(d.get("sheetValue")), norm_int(d.get("dbValue"))
            if (sv is None and dv == 0) or (dv is None and sv == 0):
                skipped.append("sacks(null↔0)")
                continue
            return True, None
        if f == "lab_results":
            if _lab_diff_is_immaterial(d.get("sheetValue"), d.get("dbValue")):
                skipped.append("lab(rounding)")
                continue
            return True, None
        # any other field is inherently material
        return True, None
    # every diff was demoted
    return False, "immaterial: " + ", ".join(sorted(set(skipped)))


# ---------------------------------------------------------------------------
# Batch resolution
# ---------------------------------------------------------------------------
def resolve_against_set(row: dict, code_set: set[str]) -> tuple[str | None, str | None]:
    """RC IN: resolve primary -> fallbacks against the set of existing batch_codes."""
    primary = row.get("batch_code_primary")
    if primary and primary in code_set:
        return primary, primary
    for fb in row.get("batch_code_fallbacks") or []:
        if fb in code_set:
            return fb, fb
    # No DB match — return primary as the *intended* code (used in NEW rows) but
    # signal unresolved via the second slot being None.
    return primary, None


def resolve_batch_id(row: dict, lookup: dict[str, str]) -> tuple[str | None, str | None]:
    """RC OUT: resolve primary -> fallbacks to a batch_id uuid."""
    primary = row.get("batch_code_primary")
    if primary and primary in lookup:
        return lookup[primary], primary
    for fb in row.get("batch_code_fallbacks") or []:
        if fb in lookup:
            return lookup[fb], fb
    return None, None


# ---------------------------------------------------------------------------
# Diff functions
# ---------------------------------------------------------------------------
def rc_in_diffs(ex: dict, db: dict) -> list[dict]:
    # NOTE: true_weight_kg / deduction_note are intentionally NOT diffed here — they
    # are additive, write-only display fields (DEDUCTIONS_DESIGN.md / L-021): derived
    # from the remark at extract time, written on insert, but a Sheet-vs-DB diff must
    # never fire on them (else a deducted row becomes a perpetual VALUE_CHANGED before
    # the DB backfills them). The natural key stays (date, batch_code, block_loc,
    # weight_kg) and weight_kg stays the Sheet's deducted NET.
    diffs: list[dict] = []

    if norm_str(ex.get("supplier")) != norm_str(db.get("supplier")):
        diffs.append({"field": "supplier", "sheetValue": ex.get("supplier"), "dbValue": db.get("supplier")})

    if norm_str(ex.get("truck_plate")) != norm_str(db.get("truck_plate")):
        diffs.append({"field": "truck_plate", "sheetValue": ex.get("truck_plate"), "dbValue": db.get("truck_plate")})

    if norm_int(ex.get("sacks")) != norm_int(db.get("sacks")):
        diffs.append({"field": "sacks", "sheetValue": ex.get("sacks"), "dbValue": db.get("sacks")})

    # cost_basis is OUT OF SCOPE for gsheet-sync (Sheet has no price). Never diff it.

    if norm_str(ex.get("remarks")) != norm_str(db.get("remarks")):
        diffs.append({"field": "remarks", "sheetValue": ex.get("remarks"), "dbValue": db.get("remarks")})

    if not deep_lab_equal(ex.get("lab_results"), db.get("lab_results")):
        diffs.append({"field": "lab_results", "sheetValue": ex.get("lab_results"), "dbValue": db.get("lab_results")})

    return diffs


def rc_out_diffs(ex: dict, db: dict) -> list[dict]:
    diffs: list[dict] = []

    e_w = norm_num(ex.get("weight_kg"), 3)
    d_w = norm_num(db.get("weight_kg"), 3)
    if e_w is not None and d_w is not None and abs(e_w - d_w) > WEIGHT_TOL_KG:
        diffs.append({"field": "weight_kg", "sheetValue": e_w, "dbValue": d_w})

    if norm_str(ex.get("remarks")) != norm_str(db.get("remarks")):
        diffs.append({"field": "remarks", "sheetValue": ex.get("remarks"), "dbValue": db.get("remarks")})

    # production_batch: Sheet stores a month label ("MAY"); DB stores '' for
    # most legacy rows. Only flag when BOTH are non-empty and differ — otherwise
    # this would create thousands of noise diffs on a non-load-bearing field.
    e_pb = norm_str(ex.get("production_batch"))
    d_pb = norm_str(db.get("production_batch"))
    if e_pb and d_pb and e_pb != d_pb:
        diffs.append({"field": "production_batch", "sheetValue": ex.get("production_batch"), "dbValue": db.get("production_batch")})

    return diffs


# ---------------------------------------------------------------------------
# RC IN classification (with aggregation-tolerant fallback)
# ---------------------------------------------------------------------------
def classify_rc_in(extracted: list[dict], db_rows: list[dict], since: str) -> dict:
    # Existing batch_codes in the DB window (for resolution).
    code_set = {r.get("batch_code") for r in db_rows if r.get("batch_code")}

    # Exact index: (date, batch_code, block_loc, weight) -> [db rows]
    exact: dict[tuple, list[dict]] = {}
    # Loose index: (date, batch_code, block_loc) -> [db rows]  (for tolerance match)
    loose: dict[tuple, list[dict]] = {}
    # Collision index for the conflict guardrail: (date, block_loc, weight) -> [db rows]
    # Used to detect a NEW Sheet row that lands on the same slot+weight as a
    # DIFFERENT existing batch (likely a reassignment, not an insert).
    by_date_block_wt: dict[tuple, list[dict]] = {}
    for r in db_rows:
        bc = r.get("batch_code")
        d = r.get("transaction_date")
        bl = norm_block_loc(r.get("block_loc"))
        w = norm_num(r.get("weight_kg"), 3)
        exact.setdefault((d, bc, bl, w), []).append(r)
        loose.setdefault((d, bc, bl), []).append(r)
        by_date_block_wt.setdefault((d, bl, w), []).append(r)

    new, changed, noop, unmapped, malformed, flagged = [], [], [], [], [], []
    out_of_scope = 0
    for ex in extracted:
        d = ex.get("transaction_date")
        w = norm_num(ex.get("weight_kg"), 3)

        # LOCKED scope: drop pre-cutoff Sheet rows entirely.
        if d and d < since:
            out_of_scope += 1
            continue

        if not d or w is None or not ex.get("batch_code_primary"):
            malformed.append({"row": ex, "reason": "missing date / batch_code / weight"})
            continue

        resolved_code, db_matched_code = resolve_against_set(ex, code_set)
        bl = norm_block_loc(ex.get("block_loc"))

        if db_matched_code is None:
            # batch_code not found in DB at all -> UNMAPPED (never auto-create).
            unmapped.append({
                "index": ex.get("_source_row"),
                "row": ex,
                "reason": (f"batch_code primary='{ex.get('batch_code_primary')}' "
                           f"+ fallbacks={ex.get('batch_code_fallbacks')} not in DB"),
            })
            continue

        # 1) exact natural-key hit
        key = (d, db_matched_code, bl, w)
        matches = exact.get(key, [])
        if matches:
            db_row = matches[0]
            diffs = rc_in_diffs(ex, db_row)
            _route_changed(ex, db_row, diffs, key, noop, changed, _pack_rc_in)
            continue

        # 2) tolerance / aggregation fallback: same date+batch+block, weight within AGG_TOL
        cands = loose.get((d, db_matched_code, bl), [])
        best, best_delta = None, None
        for c in cands:
            cw = norm_num(c.get("weight_kg"), 3)
            if cw is None:
                continue
            delta = abs(cw - w)
            if delta <= AGG_TOL_KG and (best_delta is None or delta < best_delta):
                best, best_delta = c, delta
        if best is not None:
            diffs = rc_in_diffs(ex, best)
            note = (f"weight matched within tolerance (sheet={w}, db={norm_num(best.get('weight_kg'),3)}, "
                    f"Δ={round(best_delta,3)}kg) — likely per-block vs per-truck aggregation")
            _route_changed(ex, best, diffs, (d, db_matched_code, bl, w), noop, changed,
                           _pack_rc_in, extra={"aggregation_note": note})
            continue

        # 3) CONFLICT GUARDRAIL: a would-be NEW row that collides with a DIFFERENT
        #    batch on the same (date, block, weight) is a likely reassignment.
        collisions = [c for c in by_date_block_wt.get((d, bl, w), [])
                      if c.get("batch_code") != db_matched_code]
        if bl is not None and collisions:
            flagged.append({
                "index": ex.get("_source_row"),
                "kind": "reassignment_suspected",
                "row": ex,
                "db_conflicts": collisions,
                "reason": (f"Sheet row ({d} {ex.get('batch_code_primary')} @ {bl} {w}kg) would be NEW, "
                           f"but the DB already has the same date/block/weight under "
                           f"{[c.get('batch_code') for c in collisions]} — likely a batch reassignment, "
                           f"not an insert. Held to avoid double-count; never deletes a DB row."),
            })
            continue

        # 4) genuinely new
        ex["batch_code_resolved"] = resolved_code
        new.append({"index": ex.get("_source_row"), "row": ex})

    return _bundle("rc_in", extracted, db_rows, new, changed, noop, unmapped, malformed,
                   flagged=flagged, out_of_scope=out_of_scope, since=since)


def _pack_rc_in(ex: dict, db_row: dict, diffs: list[dict], key: tuple) -> dict:
    base = {"index": ex.get("_source_row"), "natural_key": list(key), "db_id": db_row.get("id")}
    if diffs:
        base.update({"row": ex, "db_row": db_row, "diff": diffs})
    return base


def _route_changed(ex, db_row, diffs, key, noop, changed, packer, extra=None):
    """
    Shared NOOP/VALUE_CHANGED router that applies the material-change gate
    (LOCKED decision #2). Immaterial diffs (rounding/padding) are demoted to NOOP
    so they never enter the Sheet-wins write plan.
    """
    if not diffs:
        packed = packer(ex, db_row, [], key)
        if extra:
            packed.update(extra)
        noop.append(packed)
        return
    material, note = is_material(diffs)
    packed = packer(ex, db_row, diffs, key)
    if extra:
        packed.update(extra)
    if material:
        changed.append(packed)
    else:
        # keep the (immaterial) diff visible for transparency, but it's a NOOP
        packed["immaterial_note"] = note
        noop.append(packed)


# ---------------------------------------------------------------------------
# RC OUT classification
# ---------------------------------------------------------------------------
def classify_rc_out(extracted: list[dict], db_rows: list[dict], lookup: dict[str, str], since: str) -> dict:
    # Index DB by (date, batch_id, destination); a key may hold >1 row.
    db_index: dict[tuple, list[dict]] = {}
    # Collision index for the conflict guardrail: (date, dest, weight) -> [db rows].
    # A NEW Sheet feed at the same date+dest+weight under a DIFFERENT batch is a
    # likely reassignment, not an insert (RC OUT block_loc is often empty, so we
    # key on weight rather than block).
    by_date_dest_wt: dict[tuple, list[dict]] = {}
    for r in db_rows:
        dest = r.get("destination") or "MAIN"
        k = (r.get("transaction_date"), r.get("batch_id"), dest)
        db_index.setdefault(k, []).append(r)
        by_date_dest_wt.setdefault((r.get("transaction_date"), dest, norm_num(r.get("weight_kg"), 3)), []).append(r)

    # Track consumed DB rows so multiple Sheet rows mapping the same key each
    # pair with a distinct DB row when possible.
    consumed: dict[tuple, int] = {}

    new, changed, noop, unmapped, malformed, flagged = [], [], [], [], [], []
    out_of_scope = 0
    for ex in extracted:
        d = ex.get("transaction_date")
        w = ex.get("weight_kg")

        # LOCKED scope: drop pre-cutoff Sheet rows entirely.
        if d and d < since:
            out_of_scope += 1
            continue

        if not d:
            malformed.append({"row": ex, "reason": "missing transaction_date"})
            continue
        if w is None or float(w) == 0:
            malformed.append({"row": ex, "reason": "missing or zero weight"})
            continue

        batch_id, code_used = resolve_batch_id(ex, lookup)
        if batch_id is None:
            unmapped.append({
                "index": ex.get("_source_row"),
                "row": ex,
                "reason": (f"batch_code primary='{ex.get('batch_code_primary')}' "
                           f"+ fallbacks={ex.get('batch_code_fallbacks')} -> no batch_id"),
            })
            continue

        ex["batch_id"] = batch_id
        ex["batch_code_resolved"] = code_used
        dest = ex.get("destination") or "MAIN"
        key = (d, batch_id, dest)
        matches = db_index.get(key, [])

        if not matches:
            # CONFLICT GUARDRAIL: would-be NEW that collides with a DIFFERENT
            # batch at the same date/dest/weight -> likely reassignment.
            collisions = [c for c in by_date_dest_wt.get((d, dest, norm_num(w, 3)), [])
                          if c.get("batch_id") != batch_id]
            if collisions:
                flagged.append({
                    "index": ex.get("_source_row"),
                    "kind": "reassignment_suspected",
                    "row": ex,
                    "db_conflicts": collisions,
                    "reason": (f"Sheet feed ({d} {ex.get('batch_code_resolved')} {dest} {norm_num(w,3)}kg) would "
                               f"be NEW, but the DB already has the same date/dest/weight under a different "
                               f"batch_id ({[c.get('id') for c in collisions]}) — likely a batch reassignment, "
                               f"not an insert. Held to avoid double-count; never deletes a DB row."),
                })
                continue
            new.append({"index": ex.get("_source_row"), "row": ex})
            continue

        # Pick the closest-weight DB row among the (possibly several) matches,
        # preferring an as-yet-unconsumed one.
        start = consumed.get(key, 0)
        pool = matches[start:] or matches
        best, best_delta = None, None
        ew = norm_num(w, 3)
        for c in pool:
            cw = norm_num(c.get("weight_kg"), 3)
            delta = abs((cw or 0) - (ew or 0))
            if best_delta is None or delta < best_delta:
                best, best_delta = c, delta
        consumed[key] = start + 1

        diffs = rc_out_diffs(ex, best)
        _route_changed(ex, best, diffs, [d, batch_id, dest], noop, changed, _pack_rc_out)

    return _bundle("rc_out", extracted, db_rows, new, changed, noop, unmapped, malformed,
                   flagged=flagged, out_of_scope=out_of_scope, since=since)


def _pack_rc_out(ex: dict, db_row: dict, diffs: list[dict], key) -> dict:
    base = {"index": ex.get("_source_row"), "natural_key": list(key), "db_id": db_row.get("id")}
    if diffs:
        base.update({"row": ex, "db_row": db_row, "diff": diffs})
    return base


# ---------------------------------------------------------------------------
# Shared bundling
# ---------------------------------------------------------------------------
def _bundle(mode, extracted, db_rows, new, changed, noop, unmapped, malformed,
            flagged=None, out_of_scope=0, since=None) -> dict:
    flagged = flagged or []
    return {
        "mode": mode,
        "since": since,
        "summary": {
            "extracted_total": len(extracted),
            "out_of_scope_count": out_of_scope,      # pre-cutoff Sheet rows skipped
            "in_scope_total": len(extracted) - out_of_scope,
            "noop_count": len(noop),
            "new_count": len(new),                   # -> INSERT
            "changed_count": len(changed),           # -> Sheet-wins UPDATE (material only)
            "flagged_count": len(flagged),           # -> human decision (no auto-write)
            "unmapped_count": len(unmapped),
            "malformed_count": len(malformed),
            "db_rows_in_window": len(db_rows),
        },
        "new": new,
        "changed": changed,
        "flagged": flagged,
        "noop": noop,
        "unmapped": unmapped,
        "malformed": malformed,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="Classify Sheet RC IN / RC OUT vs DB (dry-run).")
    ap.add_argument("--mode", required=True, choices=["rc_in", "rc_out"])
    ap.add_argument("--extract-json", required=True)
    ap.add_argument("--db-rows-json", required=True)
    ap.add_argument("--batch-lookup-json", help="Required for --mode rc_out")
    ap.add_argument("--since", default=DEFAULT_SINCE,
                    help=f"Scope cutoff (inclusive). Sheet rows before this date are skipped. Default {DEFAULT_SINCE}.")
    ap.add_argument("--output", required=True)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    extract = json.loads(Path(args.extract_json).read_text())
    db_rows = json.loads(Path(args.db_rows_json).read_text())
    # Unwrap {"data":[...]} if present
    if isinstance(db_rows, list) and len(db_rows) == 1 and isinstance(db_rows[0], dict) and "data" in db_rows[0]:
        db_rows = db_rows[0]["data"] or []
    rows = extract.get("rows", extract if isinstance(extract, list) else [])

    if args.mode == "rc_in":
        result = classify_rc_in(rows, db_rows, args.since)
    else:
        if not args.batch_lookup_json:
            print(json.dumps({"error": "--batch-lookup-json required for rc_out"}), file=sys.stderr)
            return 1
        lookup = json.loads(Path(args.batch_lookup_json).read_text())
        result = classify_rc_out(rows, db_rows, lookup, args.since)

    Path(args.output).write_text(json.dumps(result, indent=2, default=str))

    if args.verbose:
        s = result["summary"]
        print(f"=== {args.mode} alignment (since {args.since}) ===", file=sys.stderr)
        for k in ("extracted_total", "out_of_scope_count", "in_scope_total", "noop_count",
                  "new_count", "changed_count", "flagged_count",
                  "unmapped_count", "malformed_count", "db_rows_in_window"):
            print(f"  {k}: {s[k]}", file=sys.stderr)

    print(json.dumps({"ok": True, "summary": result["summary"], "output_path": args.output}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
