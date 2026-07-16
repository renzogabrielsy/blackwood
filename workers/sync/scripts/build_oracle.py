#!/usr/bin/env python3
"""build_oracle.py — run the PYTHON classify path for every fixture case and
store the canonicalized output as fixtures/<type>/oracle/<case>.json.

This is the GOLDEN-MASTER generator. For each case in a type's manifest.json it:
  1. runs the type's extractor(s) on the case workbook(s),
  2. runs the type's classifier(s) with the case db_window snapshot fed via the
     Python offline --*-json flags (NEVER the live DB — reproducible forever),
  3. canonicalizes the classifier's raw output (parity_canonical.py, the exact
     mirror of test/parity/canonical.ts),
  4. writes fixtures/<type>/oracle/<case>.json.

The exact per-type invocation shapes below were read off the sync_*.py
orchestrators (SHARED.md / the specs). Where a pipeline classifies multiple
sections (production = 5, gsheet = 2), the oracle is a COMPOSED object keyed by
section, matching what the TS classifyCase returns for that type.

Usage:
    python3 scripts/build_oracle.py [--type <t>] [--verbose]

Env: reads .env.local ONLY for the one-time db_window snapshot step (separate
script); build_oracle itself runs fully offline against the snapshots.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKER = HERE.parent
FIXTURES = WORKER / "fixtures"
SCRIPTS = (WORKER.parent.parent / ".claude/skills/sync-ictc/scripts").resolve()

sys.path.insert(0, str(HERE))
from parity_canonical import dump_canonical  # noqa: E402

PYTHON = sys.executable


def run(cmd: list[str], *, env_scrub: bool = True) -> subprocess.CompletedProcess:
    """Run a Python child offline. We scrub the Supabase env so a classifier can
    NEVER accidentally hit the live DB when a --*-json snapshot is supplied."""
    import os

    env = dict(os.environ)
    if env_scrub:
        for k in ("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
                  "SUPABASE_URL", "SUPABASE_ANON_KEY"):
            env.pop(k, None)
    return subprocess.run(cmd, capture_output=True, text=True, env=env)


def _load(path: Path):
    return json.loads(path.read_text())


def _classifier(name: str) -> str:
    return str(SCRIPTS / name)


def _write_json(tmp: Path, name: str, data) -> Path:
    p = tmp / name
    p.write_text(json.dumps(data))
    return p


def _db_window(case: dict, fixture_dir: Path) -> dict:
    dw = case.get("db_window")
    if not dw:
        return {}
    return _load(fixture_dir / dw)


def _wb(case: dict, fixture_dir: Path, role: str) -> str | None:
    rel = (case.get("workbooks") or {}).get(role)
    if not rel:
        return None
    return str(fixture_dir / rel)


# ─────────────────────────────────────────────────────────────────────────────
# Per-type oracle drivers. Each returns the RAW classifier output object(s)
# (pre-canonicalization) for one case.
# ─────────────────────────────────────────────────────────────────────────────

def oracle_flecon(case, fixture_dir, tmp) -> dict:
    wb = _wb(case, fixture_dir, "primary")
    since = case["opts"]["since"]
    dw = _db_window(case, fixture_dir)
    extract = tmp / "extract.json"
    ext_cmd = [PYTHON, _classifier("extract_flecon_bags.py"), "--file", wb, "--since", since]
    # The extractor maps columns via the bag-type registry (source_label). Feed
    # the snapshot's registry offline so the map survives without a live DB.
    if dw.get("bag_type_registry"):
        reg = _write_json(tmp, "bag_type_registry.json", dw["bag_type_registry"])
        ext_cmd += ["--bag-types-json", str(reg)]
    r = run(ext_cmd)
    if r.returncode != 0:
        raise RuntimeError(f"flecon extract failed rc={r.returncode}: {r.stderr[-800:]}")
    # extractor prints the extract JSON to stdout
    extract.write_text(r.stdout)
    db_rows = _write_json(tmp, "db_movements.json", dw.get("movements", []))
    bag_types = _write_json(tmp, "bag_types.json", dw.get("bag_types", []))
    view_bal = _write_json(tmp, "view_balance.json", dw.get("view_balance", []))
    out = tmp / "classified.json"
    r = run([PYTHON, _classifier("classify_flecon_bags.py"),
             "--extract-json", str(extract), "--since", since,
             "--db-rows-json", str(db_rows), "--bag-types-json", str(bag_types),
             "--view-balance-json", str(view_bal), "--output", str(out)])
    if r.returncode != 0:
        raise RuntimeError(f"flecon classify failed rc={r.returncode}: {r.stderr[-800:]}")
    return _load(out)


def oracle_deliveries(case, fixture_dir, tmp) -> dict:
    wb = _wb(case, fixture_dir, "primary")
    dw = _db_window(case, fixture_dir)
    since = case["opts"]["since"]
    extract = tmp / "extract.json"
    r = run([PYTHON, _classifier("extract_rc_deliveries.py"), "--file", wb])
    if r.returncode != 0:
        raise RuntimeError(f"deliveries extract failed rc={r.returncode}: {r.stderr[-800:]}")
    extract.write_text(r.stdout)
    # tail-filter by since (sync_deliveries.py does this Python-side)
    ex = json.loads(r.stdout)
    ex["rows"] = [row for row in ex.get("rows", [])
                  if str(row.get("transaction_date"))[:10] >= since]
    extract.write_text(json.dumps(ex))
    db_rows = _write_json(tmp, "db_rows.json", dw.get("deliveries", []))
    out = tmp / "classified.json"
    r = run([PYTHON, _classifier("classify_deliveries.py"),
             "--extract-json", str(extract), "--db-rows-json", str(db_rows),
             "--output", str(out)])
    if r.returncode != 0:
        raise RuntimeError(f"deliveries classify failed rc={r.returncode}: {r.stderr[-800:]}")
    classified = _load(out)
    # Apply the orchestrator's L-033a/b + L-004 + low-confidence guard layer
    # (sync_deliveries.py:152-246) — part of the deliveries CLASSIFY contract.
    from parity_guards import apply_deliveries_guard
    batch_codes = set(dw.get("batch_codes") or [])
    return apply_deliveries_guard(classified, dw.get("deliveries", []), batch_codes)


def oracle_rc_out(case, fixture_dir, tmp) -> dict:
    wb = _wb(case, fixture_dir, "primary")
    dw = _db_window(case, fixture_dir)
    since = case["opts"]["since"]
    watermark = case["opts"].get("watermark")
    year = int(since[:4])
    extract = tmp / "extract_proposed.json"
    r = run([PYTHON, _classifier("extract_proposed_daily.py"),
             "--file", wb, "--year", str(year), "--all-sheets"])
    if r.returncode != 0:
        raise RuntimeError(f"rc_out extract failed rc={r.returncode}: {r.stderr[-800:]}")
    extract.write_text(r.stdout)
    batch_lookup = _write_json(tmp, "batch_lookup.json", dw.get("batch_lookup", {}))
    db_rows = _write_json(tmp, "db_rows.json", dw.get("rc_out", []))
    out = tmp / "classified.json"
    cmd = [PYTHON, _classifier("classify_rc_out.py"),
           "--extract-json", str(extract), "--batch-lookup-json", str(batch_lookup),
           "--db-rows-json", str(db_rows), "--output", str(out)]
    if watermark:
        cmd += ["--watermark", watermark]
    r = run(cmd)
    if r.returncode != 0:
        raise RuntimeError(f"rc_out classify failed rc={r.returncode}: {r.stderr[-800:]}")
    return _load(out)


def oracle_gsheet(case, fixture_dir, tmp) -> dict:
    wb = _wb(case, fixture_dir, "primary")
    dw = _db_window(case, fixture_dir)
    since = case["opts"]["since"]
    out_rc_in = tmp / "ex_rc_in.json"
    out_rc_out = tmp / "ex_rc_out.json"
    r = run([PYTHON, _classifier("extract_gsheet.py"), "--file", wb,
             "--out-rc-in", str(out_rc_in), "--out-rc-out", str(out_rc_out)])
    if r.returncode != 0:
        raise RuntimeError(f"gsheet extract failed rc={r.returncode}: {r.stderr[-800:]}")
    result: dict = {}
    # rc_in
    db_in = _write_json(tmp, "db_deliveries.json", dw.get("deliveries", []))
    ci = tmp / "cls_rc_in.json"
    r = run([PYTHON, _classifier("classify_gsheet.py"), "--mode", "rc_in",
             "--extract-json", str(out_rc_in), "--db-rows-json", str(db_in),
             "--since", since, "--output", str(ci)])
    if r.returncode != 0:
        raise RuntimeError(f"gsheet rc_in classify failed rc={r.returncode}: {r.stderr[-800:]}")
    result["rc_in"] = _load(ci)
    # rc_out
    db_out = _write_json(tmp, "db_rc_out.json", dw.get("rc_out", []))
    bl = _write_json(tmp, "batch_lookup.json", dw.get("batch_lookup", {}))
    co = tmp / "cls_rc_out.json"
    r = run([PYTHON, _classifier("classify_gsheet.py"), "--mode", "rc_out",
             "--extract-json", str(out_rc_out), "--db-rows-json", str(db_out),
             "--batch-lookup-json", str(bl), "--since", since, "--output", str(co)])
    if r.returncode != 0:
        raise RuntimeError(f"gsheet rc_out classify failed rc={r.returncode}: {r.stderr[-800:]}")
    result["rc_out"] = _load(co)
    return result


def oracle_production(case, fixture_dir, tmp) -> dict:
    dw = _db_window(case, fixture_dir)
    since = case["opts"]["since"]
    year = int(since[:4])
    mc = _wb(case, fixture_dir, "mc")
    ivy = _wb(case, fixture_dir, "ivy")
    result: dict = {}

    ex_mc = {"runs": [], "downtime": [], "electricity": [], "trucks": []}
    if mc:
        r = run([PYTHON, _classifier("extract_daily_production.py"),
                 "--file", mc, "--year", str(year), "--all-sheets", "--since", since])
        if r.returncode != 0:
            raise RuntimeError(f"production MC extract failed rc={r.returncode}: {r.stderr[-800:]}")
        ex_mc = json.loads(r.stdout)
    ex_ivy = {"waste": []}
    if ivy:
        r = run([PYTHON, _classifier("extract_waste_production.py"),
                 "--file", ivy, "--all-sheets", "--since", since])
        if r.returncode != 0:
            raise RuntimeError(f"production Ivy extract failed rc={r.returncode}: {r.stderr[-800:]}")
        ex_ivy = json.loads(r.stdout)

    shifts = _write_json(tmp, "shifts.json", dw.get("shifts", []))

    def run_section(section_key, classifier, ex_rows, db_key, extra=None):
        # NOTE (flagged bug): sync_production.py writes each section as
        # {"rows": [...]}, but every classify_production_*.py reads
        # extracted_data.get("<section>") — so the lean orchestrator's runs are
        # ALWAYS 0-classified (the section key never matches "rows"). We feed the
        # classifier a BARE LIST here so it exercises its real classify LOGIC (the
        # `else extracted_data` branch handles a bare list). The {"rows"}-vs-
        # {"<section>"} wiring mismatch is an orchestrator plumbing bug tracked
        # separately for the M3 apply layer — it is NOT a classify-logic parity
        # concern, and porting it forward would make every production oracle
        # vacuously empty. Wave-3's classifyCase must classify the real rows.
        exf = _write_json(tmp, f"ex_{section_key}.json", ex_rows)
        dbf = _write_json(tmp, f"db_{section_key}.json", dw.get(db_key, []))
        outf = tmp / f"cls_{section_key}.json"
        cmd = [PYTHON, _classifier(classifier), "--extract-json", str(exf),
               "--db-rows-json", str(dbf), "--output", str(outf)]
        if extra:
            cmd += extra
        r = run(cmd)
        if r.returncode != 0:
            raise RuntimeError(
                f"production {section_key} classify failed rc={r.returncode}: {r.stderr[-800:]}")
        return _load(outf)

    result["runs"] = run_section("runs", "classify_production_runs.py",
                                 ex_mc.get("runs", []), "runs",
                                 ["--shifts-json", str(shifts)])
    result["downtime"] = run_section("downtime", "classify_production_downtime.py",
                                     ex_mc.get("downtime", []), "downtime",
                                     ["--shifts-json", str(shifts)])
    result["waste"] = run_section("waste", "classify_production_waste.py",
                                  ex_ivy.get("waste", []), "waste",
                                  ["--shifts-json", str(shifts)])
    result["electricity"] = run_section("electricity", "classify_electricity.py",
                                        ex_mc.get("electricity", []), "electricity")
    result["trucks"] = run_section("trucks", "classify_trucks.py",
                                   ex_mc.get("trucks", []), "trucks")
    return result


def oracle_rc_movement_audit(case, fixture_dir, tmp) -> dict:
    """Read-only auditor: extract RC MOVEMENT + reconcile vs rc_out sums snapshot.
    Mirrors audit_rc_movement.py's synthetic-proposed-from-rc_out-sums trick."""
    wb = _wb(case, fixture_dir, "movement")
    dw = _db_window(case, fixture_dir)
    movement = tmp / "movement.json"
    r = run([PYTHON, _classifier("extract_rc_movement.py"), "--file", wb, "--all-sheets"])
    if r.returncode != 0:
        raise RuntimeError(f"rc_movement extract failed rc={r.returncode}: {r.stderr[-800:]}")
    movement.write_text(r.stdout)
    sums = dw.get("rc_out_sums", {})
    sums_f = _write_json(tmp, "rc_out_sums.json", sums)
    proposed = {"rows": [{"transaction_date": d, "weight_kg": v} for d, v in sums.items()]}
    proposed_f = _write_json(tmp, "proposed.json", proposed)
    report = tmp / "reconcile.json"
    r = run([PYTHON, _classifier("reconcile_rc_movement.py"),
             "--proposed-json", str(proposed_f), "--movement-json", str(movement),
             "--rc-out-sums-json", str(sums_f), "--output", str(report)])
    # reconciler exit code is the severity (0/1/2) — not a failure
    if not report.exists():
        raise RuntimeError(f"rc_movement reconcile produced no report: {r.stderr[-800:]}")
    rep = _load(report)
    return {"reconcile": rep, "severity": r.returncode, "ok": r.returncode < 2}


DRIVERS = {
    "flecon": oracle_flecon,
    "deliveries": oracle_deliveries,
    "rc_out": oracle_rc_out,
    "gsheet": oracle_gsheet,
    "production": oracle_production,
    "rc_movement_audit": oracle_rc_movement_audit,
}


def build_type(rt: str, verbose: bool) -> tuple[int, int]:
    manifest_path = FIXTURES / rt / "manifest.json"
    if not manifest_path.exists():
        return (0, 0)
    manifest = _load(manifest_path)
    fixture_dir = FIXTURES / rt
    oracle_dir = fixture_dir / "oracle"
    oracle_dir.mkdir(parents=True, exist_ok=True)
    driver = DRIVERS[rt]
    ok = 0
    fail = 0
    for case in manifest.get("cases", []):
        cid = case["id"]
        with tempfile.TemporaryDirectory(prefix=f"oracle-{rt}-") as td:
            tmp = Path(td)
            try:
                raw = driver(case, fixture_dir, tmp)
                (oracle_dir / f"{cid}.json").write_text(dump_canonical(raw))
                ok += 1
                if verbose:
                    print(f"  ✓ {rt}/{cid}")
            except Exception as e:  # noqa: BLE001
                fail += 1
                print(f"  ✗ {rt}/{cid}: {e}", file=sys.stderr)
    return (ok, fail)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--type")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    types = [args.type] if args.type else sorted(DRIVERS.keys())
    total_ok = total_fail = 0
    for rt in types:
        if rt not in DRIVERS:
            print(f"unknown type {rt}", file=sys.stderr)
            return 2
        ok, fail = build_type(rt, args.verbose)
        total_ok += ok
        total_fail += fail
        print(f"[{rt}] {ok} oracle(s) built, {fail} failed")
    print(f"\nTotal: {total_ok} built, {total_fail} failed")
    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())
