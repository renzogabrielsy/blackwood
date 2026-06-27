---
name: production-run-log
description: Rolling log of Production Manager EXECUTE runs — current watermark + most recent run details. Check this first to know the live DB state before a sync.
metadata:
  type: project
---

# Production Manager — Run Log (most recent first)

Live DB watermark = `MAX(production_shifts.transaction_date)`. The DB watermark
(not the Gmail label) is the real idempotency guard — trust it over any stale
"already synced through X" note in a launch prompt.

## 2026-06-24 — full catch-up Jun 22–23 (auto-execute daily sync)
**Why:** one-click daily ICTC sync, full auto-execute. Running alone (sequential) to avoid IMAP connection limits.
**State before:** production_shifts/waste → 2026-06-22; electricity/trucks → 2026-06-20.

- **MC "Daily Production Report":** 2 new emails (UIDs 120605 Jun 23, 120703 Jun 24); latest 120703. Scanned Jun 22–23 (`--since 2026-06-20`). Sheets 06-22-26 + 06-23-26 processed.
- **Ivy "WASTE PRODUCTION REPORT":** 3 emails (UIDs 120105, 120188, 120699); latest 120699 (Jun 24). 2 waste rows after `--since 2026-06-20`: Jun 22 (NOOP — already in DB) + Jun 23 (NEW).
- **Upserted 1 new production_shifts:** 6/23 JUNE M (`a3af80ac-572f-4a15-b48d-0ccbcfaa01c1`). 6/22 M already existed.
- **production_runs:** 0 NEW. MALFORMED 2 (Jun 22 + Jun 23 — 3X50 grade, null shift — same STARTING/ENDING pattern as prior runs; never written).
- **production_downtime:** 2 NEW (6/22 M 25min — screens/frames/roller mill; 6/23 M 20min — screens). Both dt_mins<60, no normalization needed.
- **production_waste:** 1 NEW (6/23 M 5236.5 kg; rs1a=2033/rs1b=2237/bf=130/rs23=525/rs5=158/trml1=125/trml2=0.5/grit=28; remarks=PCG/BUNAWAN/ZAMBAONGA).
- **electricity_readings:** 2 NEW (6/22 MAIN 546.7→552.6; 6/23 MAIN 552.6→558.5). Meter chain clean — Jun 22 start = Jun 20 end (Jun 21 is weekend gap, normal).
- **truck_readings:** 1 NEW (6/22 KCA 378; 35175.4→35482.7 km; 160L fuel). Jun 23 had no truck row in MC sheet.
- **Audit logs written:** 7. **Labeled Blackwood-Processed:** MC UIDs 120605 + 120703; Ivy UID 120699.
- **State after:** production_shifts/waste/electricity → **2026-06-23**. Trucks → **2026-06-22**.

**Reconciliation (INFORMATIONAL — never gates):** runs_sum < sheet G13 by 3450 kg (Jun 22) and 4600 kg (Jun 23). Caused by null-shift 3X50 runs excluded from sum. Expected.

**MALFORMED — still outstanding (never written; same pattern since Jun 15):**
1. 6/15 E — null ttl_kg (blank weight in source).
2. 6/16 x2 — null shift, one 23,140 kg, one null weight.
3. 6/17 — null shift (22,880 kg).
4. 6/19 run: grade 3X50, null shift.
5. 6/20 run: grade 3X50, null shift.
6. 6/22 run: grade 3X50, null shift (20,800 kg / 800 sacks).
7. 6/23 run: grade 3X50, null shift (21,736 kg / 836 sacks).
Action: MC needs to assign shift labels to STARTING/ENDING annotated rows; re-sync once fixed.

## 2026-06-23 — waste-only Jun 22 (auto-execute daily sync)
**Why:** one-click daily ICTC sync, full auto-execute. Running alone (sequential) to avoid IMAP connection limits.
**State before:** ALL streams → 2026-06-20.

- **MC "Daily Production Report":** 2 emails (UIDs 120109, 120195); latest is 120195 (Jun 18). Workbook only goes through Jun 17 — MC has not filed a newer report. 0 new sheets after `--since 2026-06-20`. No runs/downtime/electricity/trucks written.
- **Ivy "WASTE PRODUCTION REPORT":** 3 emails (UIDs 120105, 120188, 120594); latest 120594 (Jun 23 — today). 1 new waste row after `--since 2026-06-20`: Jun 22 M.
- **Upserted 1 new production_shifts:** 6/22 JUNE M (`c4894cec-c83f-4942-bd15-db12d94de2aa`).
- **production_runs:** 0 (no MC data).
- **production_downtime:** 0 (no MC data).
- **production_waste:** 1 NEW (6/22 M JUNE 3319.5 kg; rs1a=1663/rs1b=1040/bf=120/rs23=297/rs5=94/trml1=75/trml2=0.5/grit=30; remarks=PCG/ZAMBAONGA).
- **electricity_readings:** 0 (no MC data).
- **truck_readings:** 0 (no MC data).
- **Audit logs written:** 1. **Labeled Blackwood-Processed:** MC UIDs 120109 + 120195; Ivy UID 120594.
- **State after:** production_shifts/waste → **2026-06-22**. Electricity/trucks still 2026-06-20.

**MALFORMED — still outstanding (unchanged from prior run; MC has not fixed source sheet):**
1. 6/15 E — null ttl_kg (blank weight in source).
2. 6/16 x2 — null shift, one has weight (23,140 kg), one has null weight.
3. 6/17 — null shift (22,880 kg available but shift label missing).
Action: MC needs to assign shift labels and fill blank weights; re-sync once fixed. Jun 18–23 not yet in MC workbook — MC has not filed an updated report.

## 2026-06-22 — full catch-up Jun 19–20 (auto-execute daily sync)
**Why:** one-click daily ICTC sync, full auto-execute. Running alone (sequential) to avoid IMAP connection limits.
**State before:** ALL streams → 2026-06-18.

- **MC "Daily Production Report":** 4 emails (UIDs 120109, 120195, 120360, 120476); picked latest 120476 (Jun 22). Scanned Jun 19–20 (`--since 2026-06-18`).
- **Ivy "WASTE PRODUCTION REPORT":** 4 emails (UIDs 120105, 120188, 120356, 120471); picked latest 120471 (Jun 22). Rows Jun 19–20 (`--since 2026-06-18`).
- **Upserted 2 new production_shifts:** 6/19 M, 6/20 M.
- **production_runs:** 0 NEW. MALFORMED 2 (Jun 19 + Jun 20 — 3X50 grade, null shift — same pattern as prior run; never written).
- **production_downtime:** 2 NEW (6/19 M 1h50m; 6/20 M 6m). Note: classifier emitted raw 110m for Jun 19 — normalized to dt_hrs=1/dt_mins=50 before insert (DB check constraint dt_mins<60).
- **production_waste:** 2 NEW (6/19 M 4591.5 kg; 6/20 M 3518.5 kg). 0 MALFORMED.
- **electricity_readings:** 2 NEW (6/19 MAIN 534.6→540.5; 6/20 MAIN 540.5→546.7).
- **truck_readings:** 2 NEW (6/19 KCA 378; 6/20 AAV 6111).
- **Audit logs written:** 10 total. **Labeled Blackwood-Processed:** MC UIDs 120360 + 120476; Ivy UIDs 120356 + 120471.
- **State after:** ALL streams → **2026-06-20**.

**MALFORMED — still outstanding (never written):**
- 6/19 run: grade 3X50, null shift (persists from prior run — MC has not yet fixed shift labels in the source sheet).
- 6/20 run: grade 3X50, null shift (same).
Action: MC needs to assign shift labels to those STARTING/ENDING row entries; re-sync once fixed.

**Classifier bug noted (L-new):** classify_production_downtime passes raw accumulated dt_mins (>60) without normalizing to dt_hrs+dt_mins. Jun 19 raw=110 violated DB check constraint; I normalized manually before insert. Should be fixed in the classifier script.

## 2026-06-19 — full catch-up Jun 12–18 (auto-execute daily sync)
**Why:** one-click daily ICTC sync, full auto-execute.
**State before:** shifts/waste 2026-06-15; electricity 2026-06-11; trucks 2026-06-10.

- **MC "Daily Production Report":** 3 emails (UIDs 120109, 120195, 120283); picked latest 120283 (Jun 19). Scanned Jun 11–18 (`--since 2026-06-10`).
- **Ivy "WASTE PRODUCTION REPORT":** 3 emails (UIDs 120105, 120188, 120279); picked latest 120279 (Jun 19). Rows Jun 16–18 (`--since 2026-06-15`).
- **Upserted 3 new production_shifts:** 6/16 M, 6/17 M, 6/18 M.
- **production_runs:** 3 NEW (6/12 M 24310 kg, 6/12 E 19890 kg, 6/15 M 26520 kg). MALFORMED 5 (Jun 15 E null ttl_kg + Jun 16–18 null-shift → never written, surfaced below).
- **production_downtime:** 5 NEW; 1 VALUE_CHANGED (6/11 M time-range detail appended). L-014 applied: 6/17 117m→1h57m; 6/18 240m→4h0m.
- **production_waste:** 3 NEW (6/16 M, 6/17 M, 6/18 M). 0 MALFORMED.
- **electricity_readings:** 5 NEW (6/12, 6/15, 6/16, 6/17, 6/18).
- **truck_readings:** 5 NEW (6/15 AAV, 6/16 KCA, 6/17 AAV, 6/18 AAV, 6/18 KCA).
- **Audit logs written:** 25 total. **Labeled Blackwood-Processed:** MC UID 120283 + Ivy UID 120279.
- **State after:** ALL streams → **2026-06-18**.

**MALFORMED — manual fix required (never written):**
1. 6/15 E — run row has null ttl_kg (possibly blank on that shift-row in the sheet).
2. 6/16 run(s) — 2 rows with null shift (one 23140 kg, one null kg).
3. 6/17 run — null shift (22880 kg).
4. 6/18 run — null shift (18850 kg).
Action: check the source sheet for those days' evening-shift and STARTING/ENDING annotations; reassign shift and re-sync.

## 2026-06-16 — waste-only catch-up (auto-execute daily sync)
**Why:** one-click daily ICTC sync, full auto-execute (no approval gate).
**State before:** watermark 2026-06-11 (shifts + electricity); trucks 2026-06-10.
(The launch prompt claimed "synced through 5/28" — that was stale; DB was already
6/11 from the 6/11 L-016 run.)

- **MC "Daily Production Report": ZERO new emails** (all labeled Blackwood-Processed)
  → no runs/downtime/electricity/trucks this run.
- **Ivy "WASTE PRODUCTION REPORT": 2 emails** (UID 119947 6/15, UID 120023 6/16);
  picked latest 120023. JUNE 2026 sheet, rows 17–19 (3 new waste rows after `--since 2026-06-11`).
- Wrote **3 production_shifts** + **3 production_waste** + **6 audit_logs**:
  - 6/12 M (ZAMBAONGA, 3521.5 kg), 6/12 E (PCG, 1541.5 kg), 6/15 M (PCG/BUNAWAN, 3310.5 kg).
  - All stream-sums == reported totals (recon ok). 0 MALFORMED, 0 VALUE_CHANGED.
- **Labeled Blackwood-Processed:** Ivy UIDs 119947 + 120023.
- **State after:** production_shifts/waste watermark → **2026-06-15**.
  Runs/downtime/electricity still 6/11, trucks still 6/10 (no MC email yet for 6/12+).

**Note (gap, not an error):** 6/13–6/14 absent from waste = weekend, normal.
**Note (L-016 cleared):** 6/12 is watermark+1; cross-checked waste streams vs the
6/11 day — rs23/rs5/trml1/grit all differ materially, so genuine new day, NOT a
date-relabel duplicate. (Couldn't use the electricity-meter tell — no MC email —
but the waste streams alone were clearly divergent.)
**Source (durable):** `/Users/renzosy/blackwood/.sync-flags/2026-06-16/120023_WASTE PRODUCTION REPORT 2026.xlsx`

## 2026-06-11 — JUNE catch-up (see ledger L-016/L-014)
Watermark advanced to 2026-06-10 (dropped a 6/6 date-relabel duplicate per L-016).

## 2026-05-29 — first EXECUTE
See [project_first_execute.md]. 5/25–5/28 catch-up; pipeline proven end-to-end.
