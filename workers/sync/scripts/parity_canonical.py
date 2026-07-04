"""parity_canonical.py — Python mirror of test/parity/canonical.ts.

MUST stay byte-for-byte equivalent in OUTPUT to the TS canonicalizer: the whole
point of M2 is that canonicalizing the Python oracle and canonicalizing the TS
port produce identical JSON when the two are semantically equal. If you change a
rule here, change canonical.ts in lockstep (and vice-versa).

Rules (see canonical.ts for the authoritative prose):
  1. object keys sorted lexicographically (recursively)
  2. arrays of objects sorted by a natural-key projection, else by full canon JSON
  3. floats -> tagged string; integer-valued -> integer text; else round 9dp,
     strip trailing zeros; tag prefix " num:"
  4. volatile keys dropped at any depth (explicit allowlist)

The oracle files on disk are stored as the CANONICALIZED JS-value tree (so the
TS runner can json.load them and diff against canonicalize(tsOut) directly). We
emit that tree with json.dumps(sort_keys=False) preserving our own sorted order.
"""
from __future__ import annotations

import json
from typing import Any

FLOAT_TAG = " num:"

VOLATILE_KEYS = {
    "output_path", "classified_path", "decisions_file",
    "full_classified_file_for_audit_only", "path", "file", "filename", "work_dir",
    "generated_at", "run_ts", "run_at", "last_run_at", "timestamp", "created_at",
    "model",
    "id", "db_id", "record_id", "email_thread_id", "thread_id", "uid", "source_row",
}

NATURAL_KEY_CANDIDATES = [
    ["natural_key"],
    ["_mode", "natural_key"],
    ["transaction_date", "batch_code", "block_loc", "weight_kg", "truck_plate", "sacks"],
    ["transaction_date", "batch_id", "destination"],
    ["transaction_date", "production_batch", "shift", "customer", "grade"],
    ["reading_date", "meter"],
    ["reading_date", "plate_no"],
    ["transaction_date", "particular", "bag_type_code", "qty_delta"],
    ["date", "gate"],
    ["date"],
    ["transaction_date"],
    ["code"],
    ["gate"],
    ["reason"],
    ["kind"],
]


def canonicalize_number(n: float | int) -> str:
    # bool is an int subclass in Python; treat True/False as-is (never appears in
    # numeric fields, but be defensive and DON'T stringify as a number).
    if isinstance(n, bool):
        return n  # type: ignore[return-value]
    f = float(n)
    if f != f or f in (float("inf"), float("-inf")):
        return FLOAT_TAG + str(f)
    if f == int(f):
        return FLOAT_TAG + str(int(f))
    s = f"{f:.9f}".rstrip("0").rstrip(".")
    return FLOAT_TAG + s


def _is_obj(v: Any) -> bool:
    return isinstance(v, dict)


def canonicalize(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return canonicalize_number(value)
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, list):
        mapped = [canonicalize(e) for e in value]
        if len(mapped) > 1 and all(_is_obj(e) for e in mapped):
            return _sort_object_array(mapped)
        return mapped
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k in sorted(value.keys()):
            if k in VOLATILE_KEYS:
                continue
            out[k] = canonicalize(value[k])
        return out
    # Fallback for exotic types (datetime etc.) — stringify.
    return str(value)


def _row_sort_key(row: dict[str, Any]) -> str:
    for cand in NATURAL_KEY_CANDIDATES:
        if all(f in row for f in cand):
            proj = {f: row[f] for f in cand}
            return "K:" + stable_stringify(proj)
    return "F:" + stable_stringify(row)


def _sort_object_array(arr: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(arr, key=_row_sort_key)


def stable_stringify(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return canonicalize_number(value)  # defensive
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(stable_stringify(e) for e in value) + "]"
    if isinstance(value, dict):
        parts = []
        for k in value.keys():  # already sorted by canonicalize()
            parts.append(json.dumps(k, ensure_ascii=False) + ":" + stable_stringify(value[k]))
        return "{" + ",".join(parts) + "}"
    return json.dumps(str(value), ensure_ascii=False)


def canonical_json(value: Any) -> str:
    return stable_stringify(canonicalize(value))


def dump_canonical(value: Any) -> str:
    """Return the canonicalized TREE as JSON text (what the oracle file stores).

    We store the canonicalized tree (not the raw), pretty-ish but with our sorted
    key order preserved. The TS runner json.loads it and canonicalize()s the TS
    side, then diffs — storing the already-canonical tree makes the oracle file
    itself the human-auditable golden record.
    """
    tree = canonicalize(value)
    # Preserve our insertion order (already sorted); do NOT re-sort_keys (would
    # re-order after our volatile-strip). indent for readability/diff-ability.
    return json.dumps(tree, ensure_ascii=False, indent=2)
