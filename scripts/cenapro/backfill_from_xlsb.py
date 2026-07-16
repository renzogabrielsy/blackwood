#!/usr/bin/env python3
"""
Cenapro one-shot backfill — parse the LIVE `2025 CI PRODUCTION V2.xlsb` and emit
idempotent SQL for the `cenapro` schema (production_event + warehouse_opening_balance),
routing every exclusion to cenapro.drift_log.

This is a PURE PARSER + SQL GENERATOR. It never connects to the DB and never modifies
the source workbook. Run it, review the emitted SQL, then apply via the Supabase MCP.

Pipeline (CENAPRO_SCHEMA.md §9.1, codo schema-extraction §7):
  - Skip header (r0) + legend (r1-8) + blank separators; real data = rows with a UNIQUE TAG.
  - Canonicalize each categorical (trim+upper); unmappable -> drift_log, NEVER auto-create a lookup.
  - DVO rows (SRC=DVO / WHSE 3 / DVO-batch-coded side) -> drift_log 'dvo_row_deferred' (DEFERRED v1).
  - NULL-SRC rows -> drift_log 'legacy_missing_src' (also NULL weight -> un-loadable).
  - Validity matrix (§8.1) forbidden combos -> drift_log 'validity_violation'.
  - Cosmetic WHSE=W6/W7 -> NULL + (informational) drift_log 'whse_w6_w7_cosmetic'.
  - Plant derived from SRC (§8.2), overwriting workbook PLANT for non-FLEC; NULL for FLEC.
  - Duplicate unique_tag -> first inserted, rest -> drift_log 'unique_tag_collision'.
  - Let the DB trigger compute unique_tag + batch_year; we pass `batch` raw month text.
    (We also pass an explicit unique_tag for ON CONFLICT idempotency — the trigger
     recomputes/overwrites it identically from the canonical fields.)
  - PC WHSE 1/2/5/7 STARTING blocks -> warehouse_opening_balance (period_start_date = sheet START).

Usage:
  python3 backfill_from_xlsb.py            # writes backfill_cenapro.sql + prints summary
"""
import datetime
import sys
from collections import Counter, defaultdict

import pandas as pd

XLSB = "/Users/renzosy/Documents/1A WORK FILES/PRODUCTION/2025 CI PRODUCTION V2.xlsb"
OUT_SQL = "/Users/renzosy/blackwood/scripts/cenapro/backfill_cenapro.sql"

EXCEL_EPOCH = datetime.date(1899, 12, 30)  # 1900 date system w/ the Lotus leap-year quirk

# --- canonical lookups (must match the seeded cenapro.* lookup `code` values) ---
SRC_KIND = {
    "TNK 1": "tank", "TNK 2": "tank", "TNK 3": "tank", "TNK 4": "tank",
    "W7": "tank", "W6": "plant_direct", "FLEC": "warehouse_flec", "DVO": "dvo_container",
}
SRC_PLANT = {  # §8.2 forced plant for non-FLEC sources
    "TNK 1": "W6", "TNK 2": "W6", "TNK 3": "W6", "TNK 4": "W6",
    "W7": "W7", "W6": "W6", "DVO": "DVO", "FLEC": None,
}
VALID_GRADES = {"3X50", "2X6", "3.5", "4X8"}
MONTHS = {"JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY",
          "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"}

# column indices in the raw Production frame
C_RECV, C_PROD, C_BATCH, C_SHIFT, C_GRADE, C_PLANT, C_WHSE = 0, 1, 2, 3, 4, 5, 6
C_SRC, C_WT, C_CCC, C_FLECAMT, C_SIDE, C_FLECSTAT, C_DVOSIDE, C_TAG = 7, 8, 9, 10, 11, 12, 13, 14


def serial_to_iso(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    try:
        return (EXCEL_EPOCH + datetime.timedelta(days=int(round(float(v))))).isoformat()
    except (ValueError, TypeError):
        return None


def s(v):
    """str-or-None, trimmed."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    return str(v).strip()


def sql_str(v):
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def sql_num(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return "NULL"
    return repr(float(v))


def sql_int(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return "NULL"
    try:
        return str(int(round(float(v))))
    except (ValueError, TypeError):
        return "NULL"


def canon_grade(v):
    """3.5 numeric -> '3.5' text; else trim+upper."""
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None, None
    if isinstance(v, (int, float)):
        # 3.5 stored numeric
        g = ("%g" % float(v))
    else:
        g = str(v).strip().upper()
    if g in VALID_GRADES:
        return g, None
    return None, ("grade_non_canonical", g)


def canon_shift(v):
    raw = s(v)
    if raw is None:
        return None, None
    up = raw.strip().upper().rstrip(",").strip()  # 'M,' / ' M' -> 'M'
    if up in ("M", "E", "N"):
        return up, (("shift_non_canonical", raw) if raw != up else None)
    return None, ("shift_non_canonical", raw)


def canon_whse(v):
    """Cosmetic W6/W7 -> NULL (+drift). 'WHSE n' canonical."""
    raw = s(v)
    if raw is None:
        return None, None
    up = raw.upper()
    if up in ("W6", "W7"):
        return None, ("whse_w6_w7_cosmetic", raw)
    if up.startswith("WHSE"):
        return "WHSE " + up.replace("WHSE", "").strip(), None
    return None, ("whse_non_canonical", raw)


def canon_src(v):
    raw = s(v)
    if raw is None:
        return None, None
    up = raw.upper()
    if up in SRC_KIND:
        return up, None
    return None, ("src_non_canonical", raw)


def split_ccc(v):
    """CCC/FLEC -> (disposition_kind, partner_equipment_code, drift?)."""
    raw = s(v)
    if raw is None:
        return None, None, ("disposition_non_canonical", "")
    up = raw.upper().strip()  # 'FLEC ' -> 'FLEC'
    drift = ("disposition_non_canonical", raw) if raw != up else None
    if up == "FLEC":
        return "flec_bagging", None, drift
    if up.startswith("RK") and up in ("RK1", "RK2", "RK3", "RK4"):
        return "partner_kiln", up, drift
    if up.startswith("C") and up in ("C1", "C2", "C3", "C4"):
        return "partner_crusher", up, drift
    return None, None, ("disposition_non_canonical", raw)


def is_dvo_side(v):
    raw = s(v)
    if raw is None:
        return False
    up = raw.upper()
    return ("RIGHT" in up or "LEFT" in up) and any(m in up for m in MONTHS)


def validity(dk, src_kind, whse):
    """§8.1 matrix. Returns (ok: bool, reason: str|None, unplaced: bool).

    `unplaced=True` means the row IS valid production but has no canonical
    warehouse (older rows recorded the plant code in WHSE). It is inserted with
    warehouse_code=NULL / whse_side=NULL and gets an INFORMATIONAL drift entry —
    it is NOT a hard exclusion. Such rows simply never appear in flec_ledger
    (which joins on warehouse_code), which is correct: produced but unplaced.
    """
    if dk == "flec_bagging":
        if src_kind in ("tank", "plant_direct") and whse and whse != "WHSE 3":
            return True, None, False
        if src_kind in ("tank", "plant_direct") and not whse:
            # produced but unplaced — keep the production event, null the warehouse
            return True, "bagging_warehouse_unknown", True
        if whse == "WHSE 3":
            return False, "bagging_into_whse3", False
        if src_kind == "warehouse_flec":
            return False, "bagging_from_flec", False
        return False, "bagging_other", False
    if dk in ("partner_crusher", "partner_kiln"):
        if src_kind in ("tank", "plant_direct") and not whse:
            return True, None, False
        if src_kind in ("tank", "plant_direct") and whse:
            return False, "partner_tank_with_warehouse", False
        if src_kind == "warehouse_flec" and whse and whse != "WHSE 3":
            return True, None, False
        if src_kind == "warehouse_flec" and (not whse or whse == "WHSE 3"):
            return False, "partner_flec_bad_warehouse", False
        return False, "partner_other", False
    return False, "unknown_disposition", False


def main():
    df = pd.read_excel(XLSB, sheet_name="Production", engine="pyxlsb", header=None, dtype=object)
    data = df.iloc[11:].copy()
    # 1-based Excel row number: 0-based frame row 11 == Excel row 12
    xlrows = list(range(12, 12 + len(data)))
    rows = data.values.tolist()

    inserts = []          # production_event INSERT tuples
    drift = []            # (kind, source_row, expected, actual, message)
    info_drift = []       # informational drift for INSERTED rows (cosmetic/canon)
    seen_tags = {}        # unique_tag -> first xlrow (collision detection)
    counts = Counter()
    grade35_4x8 = []      # rows using grade 3.5 or 4X8 (for Renzo's eyeball list)

    for xlrow, r in zip(xlrows, rows):
        tag_raw = s(r[C_TAG])
        if tag_raw is None:
            counts["skipped_no_tag"] += 1
            continue
        counts["real_rows"] += 1

        src_raw = s(r[C_SRC])
        whse_raw = s(r[C_WHSE])
        plant_raw = s(r[C_PLANT])
        side_raw = s(r[C_SIDE])

        # ---- DVO detection (exclude entirely) ----
        if (s(r[C_SRC]) and s(r[C_SRC]).upper() == "DVO") or \
           (plant_raw and plant_raw.upper() == "DVO") or \
           (whse_raw and whse_raw.upper() == "WHSE 3") or \
           is_dvo_side(side_raw):
            counts["dvo_deferred"] += 1
            drift.append(("dvo_row_deferred", xlrow,
                          "non-DVO production row",
                          f"SRC={src_raw} PLANT={plant_raw} WHSE={whse_raw} SIDE={side_raw}",
                          f"DVO deferred in v1; tag={tag_raw}"))
            continue

        # ---- NULL SRC (un-loadable: source_location_code NOT NULL; these also have NULL weight) ----
        if src_raw is None:
            counts["legacy_missing_src"] += 1
            drift.append(("legacy_missing_src", xlrow,
                          "SRC present", "SRC=NULL",
                          f"WT={s(r[C_WT])} CCC={s(r[C_CCC])} tag={tag_raw}"))
            continue

        # ---- canonicalize ----
        grade, gdrift = canon_grade(r[C_GRADE])
        shift, shdrift = canon_shift(r[C_SHIFT])
        whse, whdrift = canon_whse(r[C_WHSE])
        src, srcdrift = canon_src(r[C_SRC])
        dk, pe_code, ccdrift = split_ccc(r[C_CCC])

        # hard-unmappable categoricals -> drift, do not insert
        hard_fail = None
        if grade is None:
            hard_fail = gdrift
        elif src is None:
            hard_fail = srcdrift
        elif dk is None:
            hard_fail = ccdrift
        if hard_fail:
            counts["uncanonicalizable"] += 1
            drift.append((hard_fail[0], xlrow, "canonical value",
                          hard_fail[1], f"unmappable categorical; tag={tag_raw}"))
            continue

        src_kind = SRC_KIND[src]
        plant = SRC_PLANT[src]  # derived (§8.2): NULL for FLEC, forced otherwise

        # ---- validity matrix ----
        ok, reason, unplaced = validity(dk, src_kind, whse)
        if not ok:
            counts["validity_violation"] += 1
            counts[f"viol::{reason}"] += 1
            drift.append(("validity_violation", xlrow,
                          "valid (disposition,source,warehouse)",
                          f"{dk} / {src_kind}({src}) / whse={whse}",
                          f"{reason}; tag={tag_raw}"))
            continue
        # effective stored side (NULL for unplaced rows — no warehouse, no side).
        # Computed BEFORE unique_tag so the tag matches what the DB trigger renders
        # from the stored (possibly-nulled) whse_side column, and so collision dedup
        # among the new null-warehouse rows keys on the same nulled value.
        side = side_raw if side_raw in ("LS", "RS") else None
        if unplaced:
            # valid production but no canonical warehouse: keep the event, null the
            # warehouse + side, record an INFORMATIONAL drift entry (auditable, not excluded).
            counts["bagging_warehouse_unknown"] += 1
            info_drift.append(("bagging_warehouse_unknown", xlrow,
                               "canonical warehouse",
                               f"WHSE={whse_raw}",
                               f"produced but unplaced; warehouse nulled; inserted tag={tag_raw}"))
            whse = None
            side = None

        # ---- weight guard (CHECK weight_kg > 0) ----
        wt = r[C_WT]
        if wt is None or (isinstance(wt, float) and pd.isna(wt)) or float(wt) <= 0:
            counts["nonpositive_weight"] += 1
            drift.append(("nonpositive_weight", xlrow, "weight_kg > 0",
                          f"WT={s(wt)}", f"tag={tag_raw}"))
            continue

        # ---- compute unique_tag from CANONICAL fields (byte-parity w/ the DB trigger) ----
        recv_iso = serial_to_iso(r[C_RECV])
        prod_iso = serial_to_iso(r[C_PROD])
        if recv_iso is None:
            counts["bad_recv_date"] += 1
            drift.append(("bad_recv_date", xlrow, "recv date serial",
                          f"RECV={s(r[C_RECV])}", f"tag={tag_raw}"))
            continue
        recv_serial = (datetime.date.fromisoformat(recv_iso) - EXCEL_EPOCH).days
        prod_serial = ((datetime.date.fromisoformat(prod_iso) - EXCEL_EPOCH).days
                       if prod_iso else "")
        tag_disp = "FLEC" if dk == "flec_bagging" else pe_code
        utag = "-".join([
            str(recv_serial),
            str(prod_serial),
            (s(r[C_BATCH]) or ""),
            (shift or ""),
            grade,
            (plant or ""),
            (whse or ""),
            (side or ""),
            src,
            tag_disp,
        ])

        # ---- duplicate unique_tag -> first wins, rest to drift ----
        if utag in seen_tags:
            counts["unique_tag_collision"] += 1
            drift.append(("unique_tag_collision", xlrow,
                          f"unique tag (first at xlrow {seen_tags[utag]})",
                          utag, f"duplicate; first imported, this dropped"))
            continue
        seen_tags[utag] = xlrow

        # ---- informational drift for inserted rows ----
        # For `unplaced` rows the bagging_warehouse_unknown entry (above) already
        # captures the raw WHSE, so skip the generic whse drift to avoid a duplicate.
        if whdrift and not unplaced:
            info_drift.append((whdrift[0], xlrow, "physical warehouse",
                               whdrift[1], f"cosmetic WHSE nulled; inserted tag={utag}"))
        if shdrift:
            info_drift.append((shdrift[0], xlrow, "M", shdrift[1],
                               f"shift canonicalized; inserted tag={utag}"))
        if ccdrift:
            info_drift.append((ccdrift[0], xlrow, "FLEC", ccdrift[1],
                               f"disposition canonicalized; inserted tag={utag}"))
        # plant typo on a FLEC row is moot (plant->NULL) but record it for the audit trail
        if plant_raw and plant_raw.upper() not in ("W6", "W7", "W6/W7", "W6 / W7", "DVO"):
            info_drift.append(("plant_non_canonical", xlrow, "canonical/derived plant",
                               plant_raw, f"workbook PLANT overwritten by derived={plant}; tag={utag}"))

        flec_amt = r[C_FLECAMT]
        flec_stat = s(r[C_FLECSTAT])

        if grade in ("3.5", "4X8"):
            grade35_4x8.append((xlrow, recv_iso, s(r[C_BATCH]), grade, dk,
                                src, whse, side, float(wt),
                                (int(round(float(flec_amt))) if (flec_amt is not None and not (isinstance(flec_amt, float) and pd.isna(flec_amt))) else None)))

        inserts.append({
            "recv": recv_iso, "prod": prod_iso, "batch": s(r[C_BATCH]),
            "shift": shift, "grade": grade, "plant": plant, "whse": whse,
            "src": src, "wt": float(wt), "dk": dk, "pe": pe_code,
            "flec_amt": flec_amt, "side": side, "flec_stat": flec_stat,
            "utag": utag, "xlrow": xlrow,
        })

    # ---------- PC WHSE STARTING blocks -> warehouse_opening_balance ----------
    openings = []
    for sheet, whse_code in [("PC WHSE 7", "WHSE 7"), ("PC WHSE 1", "WHSE 1"),
                             ("PC WHSE 2", "WHSE 2"), ("PC WHSE 5", "WHSE 5")]:
        pc = pd.read_excel(XLSB, sheet_name=sheet, engine="pyxlsb", header=None, dtype=object)
        start_iso = serial_to_iso(pc.iat[0, 2])  # B0='START:' C0=serial
        # GRADE col B(1), STARTING RS col E(4), STARTING LS col F(5); grade rows 5..11
        for ri in range(5, 12):
            graw = pc.iat[ri, 1] if pc.shape[1] > 1 else None
            g, _ = canon_grade(graw)
            if g is None:
                continue
            for side, ci in (("RS", 4), ("LS", 5)):
                if pc.shape[1] <= ci:
                    continue
                val = pc.iat[ri, ci]
                if val is None or (isinstance(val, float) and pd.isna(val)):
                    continue  # blank STARTING = no operator-set opening (do NOT seed from FLECON)
                openings.append((whse_code, g, side, start_iso, int(round(float(val)))))

    # ---------- emit SQL ----------
    lines = []
    lines.append("-- Cenapro backfill — generated by scripts/cenapro/backfill_from_xlsb.py")
    lines.append("-- Source: 2025 CI PRODUCTION V2.xlsb (live). Idempotent (UPSERT by unique_tag / natural key).")
    lines.append("-- The BEFORE-INSERT trigger recomputes unique_tag + batch_year from canonical fields.")
    lines.append("BEGIN;")
    lines.append("")

    # production_event (batched multi-row INSERT ... ON CONFLICT)
    lines.append(f"-- production_event: {len(inserts)} rows")
    COLS = ("recv_date,prod_date,batch,shift_code,grade_code,plant_code,warehouse_code,"
            "source_location_code,weight_kg,disposition_kind,partner_equipment_code,"
            "flec_count,whse_side,flec_stat,unique_tag,source_row,provenance,dirty")
    B = 100
    for i in range(0, len(inserts), B):
        chunk = inserts[i:i + B]
        lines.append(f"INSERT INTO cenapro.production_event ({COLS}) VALUES")
        vals = []
        for e in chunk:
            vals.append("(" + ",".join([
                sql_str(e["recv"]), sql_str(e["prod"]), sql_str(e["batch"]),
                sql_str(e["shift"]), sql_str(e["grade"]), sql_str(e["plant"]),
                sql_str(e["whse"]), sql_str(e["src"]), sql_num(e["wt"]),
                sql_str(e["dk"]), sql_str(e["pe"]), sql_int(e["flec_amt"]),
                sql_str(e["side"]), sql_str(e["flec_stat"]), sql_str(e["utag"]),
                str(e["xlrow"]), "'cenapro_xlsb'", "true",
            ]) + ")")
        lines.append(",\n".join(vals))
        lines.append("ON CONFLICT (unique_tag) DO UPDATE SET")
        lines.append("  recv_date=EXCLUDED.recv_date, prod_date=EXCLUDED.prod_date, batch=EXCLUDED.batch,")
        lines.append("  shift_code=EXCLUDED.shift_code, grade_code=EXCLUDED.grade_code,")
        lines.append("  plant_code=EXCLUDED.plant_code, warehouse_code=EXCLUDED.warehouse_code,")
        lines.append("  source_location_code=EXCLUDED.source_location_code, weight_kg=EXCLUDED.weight_kg,")
        lines.append("  disposition_kind=EXCLUDED.disposition_kind,")
        lines.append("  partner_equipment_code=EXCLUDED.partner_equipment_code,")
        lines.append("  flec_count=EXCLUDED.flec_count, whse_side=EXCLUDED.whse_side,")
        lines.append("  flec_stat=EXCLUDED.flec_stat, source_row=EXCLUDED.source_row;")
        lines.append("")

    # warehouse_opening_balance
    lines.append(f"-- warehouse_opening_balance: {len(openings)} rows")
    if openings:
        lines.append("INSERT INTO cenapro.warehouse_opening_balance "
                     "(warehouse_code,grade_code,side,period_start_date,opening_flec_count) VALUES")
        vals = []
        for (w, g, side, d, n) in openings:
            vals.append(f"({sql_str(w)},{sql_str(g)},{sql_str(side)},{sql_str(d)},{n})")
        lines.append(",\n".join(vals))
        lines.append("ON CONFLICT (warehouse_code,grade_code,side,period_start_date) "
                     "DO UPDATE SET opening_flec_count=EXCLUDED.opening_flec_count;")
        lines.append("")

    # drift_log (exclusions + informational). Truncate cenapro drift first for a clean idempotent reload.
    lines.append(f"-- drift_log: {len(drift)} exclusions + {len(info_drift)} informational")
    lines.append("DELETE FROM cenapro.drift_log WHERE resolved_at IS NULL;  -- idempotent reload of telemetry")
    all_drift = drift + info_drift
    for i in range(0, len(all_drift), B):
        chunk = all_drift[i:i + B]
        lines.append("INSERT INTO cenapro.drift_log (kind,source_row,expected,actual,message) VALUES")
        vals = []
        for (kind, srow, exp, act, msg) in chunk:
            vals.append("(" + ",".join([
                sql_str(kind), str(srow), sql_str(exp), sql_str(act), sql_str(msg),
            ]) + ")")
        lines.append(",\n".join(vals) + ";")
        lines.append("")

    lines.append("COMMIT;")

    with open(OUT_SQL, "w") as f:
        f.write("\n".join(lines))

    # ---------- summary to stdout ----------
    print("=" * 64)
    print("CENAPRO BACKFILL — PARSE SUMMARY")
    print("=" * 64)
    print(f"Real data rows:            {counts['real_rows']}")
    print(f"  -> production_event:     {len(inserts)}")
    print(f"  -> opening_balance:      {len(openings)}")
    print("-" * 40)
    print("DRIFT (excluded, not inserted):")
    for k in ["dvo_deferred", "legacy_missing_src", "validity_violation",
              "unique_tag_collision", "uncanonicalizable", "nonpositive_weight", "bad_recv_date"]:
        if counts[k]:
            print(f"  {counts[k]:>4}  {k}")
    print("  validity_violation breakdown:")
    for k, n in sorted(counts.items()):
        if k.startswith("viol::"):
            print(f"        {n:>4}  {k[6:]}")
    parked = (counts["dvo_deferred"] + counts["legacy_missing_src"] + counts["validity_violation"]
              + counts["unique_tag_collision"] + counts["uncanonicalizable"]
              + counts["nonpositive_weight"] + counts["bad_recv_date"])
    print("-" * 40)
    print(f"RECONCILE: inserts {len(inserts)} + parked {parked} = {len(inserts)+parked}  (real rows {counts['real_rows']})")
    print(f"  (of inserts, warehouse-unknown bagging kept: {counts['bagging_warehouse_unknown']})")
    print(f"Informational drift (on inserted rows): {len(info_drift)}")
    print("-" * 40)
    print("OPENING BALANCES (from STARTING blocks):")
    for (w, g, side, d, n) in openings:
        print(f"  {w} {g} {side} @ {d} = {n}")
    print("-" * 40)
    print(f"GRADE 3.5 / 4X8 rows (inserted): {len(grade35_4x8)}")
    for (xlrow, recv, batch, g, dk, src, whse, side, wt, fa) in grade35_4x8:
        print(f"  xlrow={xlrow} {recv} batch={batch} grade={g} disp={dk} src={src} "
              f"whse={whse} side={side} wt={wt:.0f} flec_amt={fa}")
    print("-" * 40)
    print(f"SQL written -> {OUT_SQL}")


if __name__ == "__main__":
    main()
