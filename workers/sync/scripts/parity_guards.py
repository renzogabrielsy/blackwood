"""parity_guards.py — the orchestrator-level post-classify guard layers that a
faithful classify oracle must include (they run in sync_*.py AFTER the raw
classifier, and their result IS what the pipeline emits as its classify envelope).

Ported VERBATIM from the Python orchestrators so the oracle matches what the live
pipeline actually produces. The ONLY change vs sync_deliveries.py is that the
L-033b batch-existence check hits a SNAPSHOT SET of batch_codes (from the
db_window) instead of `db.select_one("batches", ...)` — semantically identical
("does this batch_code exist in the DB?") but offline-reproducible.

Wave-3's TS `classifyCase` for deliveries MUST reproduce this guard layer (it is
part of the deliveries classify contract, not a separate apply concern). This
module is the executable spec of that layer for the oracle side.
"""
from __future__ import annotations

import re
from typing import Any

CONF_FLOOR = 0.7

_MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
           "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
_CODE_VARIANTS = {1: ["JAN"], 2: ["FEB"], 3: ["MARCH", "MAR"], 4: ["APRIL", "APR"],
                  5: ["MAY"], 6: ["JUNE", "JUN"], 7: ["JULY", "JUL"], 8: ["AUG"],
                  9: ["SEPT", "SEP"], 10: ["OCT"], 11: ["NOV"], 12: ["DEC"]}


def _norm_truck(v: Any) -> str:
    return "".join(ch for ch in str(v or "").upper() if ch.isalnum())


def _import_norms():
    """norm_num / norm_block_loc from the real classifier (byte-parity)."""
    import sys
    from pathlib import Path
    scripts = (Path(__file__).resolve().parent.parent.parent.parent
               / ".claude/skills/sync-ictc/scripts")
    sys.path.insert(0, str(scripts))
    from classify_deliveries import norm_num, norm_block_loc  # type: ignore
    return norm_num, norm_block_loc


def apply_deliveries_guard(classified: dict, db_rows: list[dict], batch_codes: set[str]) -> dict:
    """Return a NEW classified dict with the L-033a/b + L-004 + low-confidence
    re-routing applied (sync_deliveries.py:152-246). Adds `dup_noops` and
    `flagged` buckets; trims `new` to genuine inserts. `changed`/`noop`/`malformed`
    pass through untouched.
    """
    norm_num, norm_block_loc = _import_norms()

    db_by_dbw: dict[tuple, list[dict]] = {}
    for r in db_rows:
        k = (str(r.get("transaction_date"))[:10], r.get("batch_code"), norm_num(r.get("weight_kg"), 3))
        db_by_dbw.setdefault(k, []).append(r)

    db_by_dtw: dict[tuple, list[dict]] = {}
    for r in db_rows:
        k = (str(r.get("transaction_date"))[:10], _norm_truck(r.get("truck_plate")), norm_num(r.get("weight_kg"), 3))
        db_by_dtw.setdefault(k, []).append(r)

    def _piled_in_hint(row: dict) -> str | None:
        m = re.search(r"PILED\s+IN\s+([A-Z]+)\.?\s+BLOCK\s*(\d+)", str(row.get("remarks") or ""), re.I)
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
        year = ty - 1 if mnum > tm else ty
        for v in _CODE_VARIANTS[mnum]:
            cand = f"{v}-{str(year)[2:]}-BLK{blk}"
            if cand in batch_codes:  # was db.select_one("batches", ...)
                return cand
        return None

    inserts: list[dict] = []
    flagged: list[dict] = []
    dup_noops: list[dict] = []
    for item in classified.get("new", []):
        r = item["row"]
        kd = (str(r.get("transaction_date"))[:10], _norm_truck(r.get("truck_plate")), norm_num(r.get("weight_kg"), 3))
        dups = db_by_dtw.get(kd, []) if _norm_truck(r.get("truck_plate")) else []
        same_loc = [d for d in dups if norm_block_loc(d.get("block_loc")) == norm_block_loc(r.get("block_loc"))]
        if same_loc:
            db_bc = same_loc[0].get("batch_code")
            if db_bc != r.get("batch_code"):
                dup_noops.append({
                    "index": item.get("index"),
                    "natural_key": f"{r.get('transaction_date')}|{r.get('truck_plate')}|{r.get('weight_kg')}",
                    "note": f"L-033: same truckload already recorded as {db_bc} — "
                            f"extractor-derived name {r.get('batch_code')} is a month-boundary phantom.",
                })
                continue
        elif dups:
            flagged.append({
                "kind": "L033_cross_batch_loc_mismatch", "index": item.get("index"), "row": r,
                "reason": f"Same date/truck/weight exists as {dups[0].get('batch_code')} at "
                          f"block_loc={dups[0].get('block_loc')} (report says {r.get('block_loc')}) — "
                          f"same truckload under a different name AND location; needs a human.",
                "decision": "skip",
            })
            continue

        hint = _piled_in_hint(r)
        if hint and hint != r.get("batch_code"):
            item.setdefault("notes", []).append(
                f"L-033: batch re-mapped {r.get('batch_code')} → {hint} per remark 'PILED IN … BLOCK …'")
            r["batch_code"] = hint

        k = (str(r.get("transaction_date"))[:10], r.get("batch_code"), norm_num(r.get("weight_kg"), 3))
        collision = [d for d in db_by_dbw.get(k, [])
                     if norm_block_loc(d.get("block_loc")) != norm_block_loc(r.get("block_loc"))]
        if collision:
            flagged.append({
                "kind": "L004_block_loc_correction", "index": item.get("index"), "row": r,
                "db_id": collision[0].get("id"),
                "reason": f"Same date/batch/weight exists at block_loc={collision[0].get('block_loc')} "
                          f"(sheet says {r.get('block_loc')}) — block_loc correction, not a new delivery.",
                "decision": "skip",
            })
        elif (r.get("confidence") or 1.0) < CONF_FLOOR:
            flagged.append({
                "kind": "low_confidence", "index": item.get("index"), "row": r,
                "reason": f"confidence {r.get('confidence')} < {CONF_FLOOR}", "decision": "skip",
            })
        else:
            inserts.append(item)

    # L-040b — fold the identity diffs into `flagged` so apply HOLDS them (a corrected
    # batch_code / block_loc / weight_kg is a disagreement between two sources, and
    # CLAUDE.md is explicit that a human arbitrates those). Appended AFTER the new-loop
    # flags so the guard's own ordering is untouched. Mirrors
    # src/reports/deliveries/classify.ts::applyDeliveriesGuard.
    for item in classified.get("identity_diff", []):
        flagged.append({
            "kind": "L040_identity_diff",
            "index": item.get("index"),
            "row": item.get("row"),
            "db_id": (item.get("db_row") or {}).get("id"),
            "reason": _identity_diff_reason(item),
            "decision": "skip",
        })

    out = dict(classified)
    out["new"] = inserts
    out["flagged"] = flagged
    out["dup_noops"] = dup_noops
    return out


def _js(v: Any) -> str:
    """Render a value the way a JS template literal does. PARITY TRAP: Python
    str(18827.0) == '18827.0' but JS String(18827) == '18827', and these strings live
    INSIDE a `reason` string, which the canonicalizer does not normalize (the same trap
    that bit the dup_noop natural_key)."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    return str(v)


def _fmt_side(v: Any) -> str:
    return "(blank)" if v is None or v == "" else _js(v)


def _identity_diff_reason(item: dict) -> str:
    """Names BOTH sides of every disagreeing field — a person has to pick the winner.
    Carries NO peso value (cost_basis is never an identity field)."""
    mutable = ("batch_code", "block_loc", "weight_kg")
    row = item.get("row") or {}
    if item.get("matched_tier") == 1:
        who = "same truck + sack count (%s, %s sacks) on %s" % (
            _js(row.get("truck_plate")) if row.get("truck_plate") is not None else "?",
            _js(row.get("sacks")) if row.get("sacks") is not None else "?",
            str(row.get("transaction_date"))[:10],
        )
    else:
        who = "same date/batch/block/weight"
    parts = [
        "%s: report says %s, app has %s" % (d["field"], _fmt_side(d.get("emailValue")), _fmt_side(d.get("dbValue")))
        for d in item.get("diff", [])
        if d.get("field") in mutable
    ]
    peer = ""
    if (item.get("peer_count") or 0) > 1:
        peer = (" NOTE: the app already holds %d rows for this one truckload — a "
                "duplicate that predates this run." % item["peer_count"])
    return (
        "L-040: this is the SAME delivery as an existing row (matched on %s), but the "
        "two sources disagree on %s. One side is a human correction the other has not "
        "caught up with — never auto-applied; a person picks the winner." % (who, "; ".join(parts))
    ) + peer
