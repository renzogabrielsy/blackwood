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

## 2026-07-02 — Jul 1 waste-only catch-up (EXECUTE mode, coordinator-relayed approval)
**Why:** daily ICTC sync EXECUTE — Renzo approved write plan from PROPOSE run at work_dir `/tmp/ictc-sync-production/20260702T013134Z`.
**State before:** production_shifts/waste → 2026-06-30; electricity → 2026-06-27; trucks → 2026-06-22.

- **MC "Daily Production Report":** UID 121398 (Jul 2). No NEW runs/downtime/electricity/trucks — 8 VALUE_CHANGED all db_wins (L-026 artifacts; DB already holds correct combined totals). No writes.
- **Ivy "WASTE PRODUCTION REPORT":** UID 121497 (Jul 2). 1 NEW waste row (Jul 1 JULY M) + 1 VALUE_CHANGED db_wins (Jun 30 JULY carryover `6f44d94e` already correct in DB).
- **Upserted 1 new production_shifts:** 7/1 JULY M (`8d0b8331-0828-44e6-89d1-6a2e3c792487`).
- **production_runs:** 0 NEW. 8 VALUE_CHANGED → db_wins, no writes (L-026 artifacts).
- **production_downtime:** 0 NEW/changed.
- **production_waste:** 1 NEW (`5b4d39e5-3240-40ed-b683-f7a978fc201c`; 7/1 JULY M; rs1a=2370/rs1b=2486/bf=315/rs23=607/rs5=226/trml1=100/trml2=0.5/grit=48 = 6152.5 kg; remarks=PCG/BUNAWAN/ZAMBAONGA). 1 VALUE_CHANGED → db_wins (Jun 30 carryover row; no write).
- **electricity_readings:** 0 NEW.
- **truck_readings:** 0 NEW. Trucks still at 2026-06-22.
- **Audit logs written:** 1. **Labeled Blackwood-Processed:** MC UID 121398 + Ivy UID 121497.
- **State after:** production_shifts/waste → **2026-07-01**. Electricity still **2026-06-27**. Trucks still **2026-06-22**.

**Outstanding:** UNIQUE(shift_id) constraint on production_waste still prevents a second row per shift (the Jun 30 Row B JULY carryover at 2145.5 kg is still blocked). Backend engineer task required.

## 2026-07-01 — Jun 30 catch-up (EXECUTE mode, coordinator-relayed approval)
**Why:** daily ICTC sync EXECUTE — Renzo approved write plan from PROPOSE run at work_dir `/tmp/ictc-sync-production/20260701T021550Z`.
**State before:** production_shifts/waste → 2026-06-29; electricity → 2026-06-27; trucks → 2026-06-22.

- **MC "Daily Production Report":** UID 121407 (Jun 30). Sheet `06-30-26`. L-026 applied: ENDING+STARTING segments for two grades combined before INSERT.
- **Ivy "WASTE PRODUCTION REPORT":** UID 121400 (Jun 30). Two 06-30 waste rows in extract (Row A JUNE sheet, Row B JULY carryover). Only Row A inserted — see waste block below.
- **Upserted 1 new production_shifts:** 6/30 JUNE M (`e825d3ac-96f1-43bf-acbb-45b91c296989`).
- **production_runs:** 2 NEW (combined per L-026):
  - CEBU / 3X50: 18,694 kg / 719 sacks (`e8c6de48`; combined ENDING 13234+STARTING 5460)
  - CEBU / 4X8: 7,475 kg / 13 sacks (`9dd305ff`; combined ENDING 5175+STARTING 2300)
  Both shift-defaulted to Morning (L-025). 5 VALUE_CHANGED → db_wins, no writes (all L-026 artifacts / false-positives; DB is correct).
- **production_downtime:** 0 NEW. 1 VALUE_CHANGED email_wins UPDATE: appended time-range detail to `dt_reason` on row `93a602d6` (6/27 M; "... | Time ranges: 8:00 AM-8:08 AM; 8:15 AM-8:35 AM; 9:25 AM-9:40 AM"). NOTE: production_downtime has no `remarks` column — time-range detail appended to `dt_reason` instead.
- **production_waste:** 1 NEW inserted (Row A — JUNE sheet, `c67c0682`; rs1a=1040/rs1b=1040/bf=110/rs23=332/rs5=109/trml1=75/trml2=0.5/grit=28; total=2734.5 kg). **Row B BLOCKED** — `production_waste_natural_key UNIQUE(shift_id)` forbids two waste rows per shift. Row B (JULY sheet carryover, 2145.5 kg: rs1a=1038/rs1b=784/bf=35/rs23=137/rs5=71/trml1=50/trml2=0.5/grit=30) held. **Schema decision needed: widen UNIQUE(shift_id) to allow multiple waste recordings per shift on transition days — escalate to backend engineer.**
- **electricity_readings:** 0 NEW.
- **truck_readings:** 0 NEW. Trucks still at 2026-06-22.
- **Audit logs written:** 5. **Labeled Blackwood-Processed:** MC UID 121407 + Ivy UID 121400.
- **State after:** production_shifts/waste → **2026-06-30**. Electricity still **2026-06-27**. Trucks still **2026-06-22**.

**Schema flag (outstanding):** `production_waste_natural_key UNIQUE(shift_id)` prevents inserting Row B. On June→July transition days the operator records two real waste measurements under the same shift. The unique constraint needs loosening (e.g. to `UNIQUE(shift_id, source_sheet)` or removing altogether with a different dedup key). Backend engineer task required before Row B can be inserted.

**MALFORMED — cumulative outstanding (unchanged):** same list as 2026-06-30 run above. Blank-shift rows (6/16–6/27) now auto-default to Morning on re-sync per L-025. Only null-weight rows (6/15 E, one 6/16 row) still HOLD as MALFORMED.

## 2026-06-30 — Jun 29 catch-up (auto-execute daily sync, L-025 first run)
**Why:** daily ICTC sync, auto-execute. L-025 first live run: blank/unrecognized shift rows now default to Morning automatically and are written (not held).
**State before:** production_shifts/waste/electricity → 2026-06-27; trucks → 2026-06-22 (still lagging — no truck rows in Jun 28/29 MC sheets).

- **MC "Daily Production Report":** 1 new email (UID 121279, Jun 30). Latest: `Daily Production Report 2026 2Q.xlsx`. Sheet `06-29-26` only (1 day after `--since 2026-06-27`; Jun 28 = Sunday, not filed).
- **Ivy "WASTE PRODUCTION REPORT":** 1 new email (UID 121281, Jun 30). 1 new waste row: Jun 29 M.
- **L-025 first live run:** 2 run rows with operator labels "DAY SHIFT" and "OVERTIME" — both defaulted to Morning per L-025. Both had `_shift_defaulted=True` and `grade=3X50`, with weights.
- **L-026 triggered (new rule):** Both rows mapped to `(shift_id=e7cd956a, CEBU, 3X50)` — same natural key. INSERT of two rows failed `23505 duplicate key production_runs_natural_key`. Resolution: COMBINED into one row: 16,380 + 6,890 = **23,270 kg**, 630 + 265 = **895 sacks**, with remarks noting both segments. One combined INSERT succeeded.
- **Upserted 1 new production_shifts:** 6/29 JUNE M (`e7cd956a-e988-4a81-b730-3ed3a1237f82`).
- **production_runs:** 1 row inserted (combined; `36d8034b-db29-477f-8a68-b4712290e33d`; 23,270 kg / 895 sacks; grade 3X50; customer CEBU). 2 source rows → 1 DB row per L-026. Shift auto-defaulted Morning (L-025).
- **production_downtime:** 0 NEW (no downtime rows in Jun 29 MC sheet).
- **production_waste:** 1 NEW (`cd7bcddc-7053-45c8-9b92-2765911ae083`; 6/29 JUNE M; rs1a=1959/rs1b=1522/bf=140/rs23=616/rs5=176/trml1=84/trml2=0.75/grit=50 = 4,547.75 kg total; remarks=PCG/BUNAWAN/ZAMBAONGA).
- **electricity_readings:** 0 NEW (no electricity rows in Jun 29 MC sheet).
- **truck_readings:** 0 NEW (no truck rows in Jun 29 MC sheet). Trucks still at 2026-06-22.
- **Audit logs written:** 3. **Labeled Blackwood-Processed:** MC UID 121279 + Ivy UID 121281.
- **State after:** production_shifts/waste → **2026-06-29**. Electricity still **2026-06-27**. Trucks still **2026-06-22**.

**New ledger entries appended:** L-026 (DAY SHIFT/OVERTIME combining pattern). RULES_DIGEST updated.

**MALFORMED — cumulative outstanding (never written; MC must fix source sheet):**
1. 6/15 E — null ttl_kg (blank weight in source).
2. 6/16 x2 — null shift; one 23,140 kg, one null weight.
3. 6/17 — null shift (22,880 kg). [Note: with L-025 now live, if MC re-files these days, blank shift will default to Morning automatically. Only the null-weight row on 6/15 and null-weight on 6/16 will still HOLD.]
4. 6/19 — grade 3X50, null shift (now: would auto-default to Morning on re-sync).
5. 6/20 — grade 3X50, null shift (same).
6. 6/22 — grade 3X50, null shift (same).
7. 6/23 — grade 3X50, null shift (same).
8. 6/24 — grade 3X50, null shift (same; not yet in MC workbook as of prior run).
9. 6/25 — grade 3X50, null shift (same).
10. 6/26 — grade 3X50, null shift (same).
11. 6/27 — grade 3X50, null shift (21,632 kg / 832 sacks — from Jun 29 run, still outstanding).
Action: With L-025 live, the "null shift" runs above would NOW auto-default to Morning on re-sync — only the null-weight/null-ttl_kg rows still HOLD as MALFORMED. MC should fix the blank weights on 6/15 and 6/16 (the null-kg ones).

## 2026-06-29 — Jun 27 catch-up (auto-execute daily sync)
**Why:** daily ICTC sync, full auto-execute (priority catch-up run). Sequential IMAP.
**State before:** production_shifts/waste/electricity → 2026-06-26; trucks → 2026-06-22.

- **MC "Daily Production Report":** 1 new email (UID 121190, Jun 29). Latest attachment: `Daily Production Report 2026 2Q.xlsx`. Sheet `06-27-26` only (1 day after `--since 2026-06-26`). 0 trucks in MC sheet for Jun 27.
- **Ivy "WASTE PRODUCTION REPORT":** 1 new email (UID 121187, Jun 29). 1 new waste row: Jun 27 M.
- **Upserted 1 new production_shifts:** 6/27 JUNE M (`ed348e7d-a2cb-4406-97c3-dc202cdbfb75`).
- **production_runs:** 0 NEW. MALFORMED 1 (Jun 27 — 3X50 grade, null shift, 21,632 kg / 832 sacks — same recurring pattern; never written).
- **production_downtime:** 1 NEW (6/27 M; dt_mins=8; REPAIR cleaned screens RS 2A/2B/tank 4X8, SC #9 sprocket, RS 2 changed spring). Note: remarks show 3 time ranges (8+20+15=43 min total) but extractor captured only 8 min (first range) — data quality note, inserted as extracted.
- **production_waste:** 1 NEW (6/27 M JUNE; rs1a=2080/rs1b=2027/bf=195/rs23=750/rs5=195/trml1=145/trml2=0.5/grit=57 = 5449.5 kg total; remarks=PCG/BUNAWAN/ZAMBAONGA).
- **electricity_readings:** 1 NEW (6/27 MAIN 579.7→587.8; chain: Jun 26 end 579.7 = Jun 27 start — clean).
- **truck_readings:** 0 NEW (no truck row in Jun 27 MC sheet).
- **Audit logs written:** 4. **Labeled Blackwood-Processed:** MC UID 121190 + Ivy UID 121187.
- **State after:** production_shifts/waste/electricity → **2026-06-27**. Trucks still → **2026-06-22**.

**Reconciliation (INFORMATIONAL):** runs_sum vs G13 mismatch expected — 3X50 null-shift run (21,632 kg) excluded from sum. Same as every prior run. Waste internal arithmetic: clean (stream sum = 5449.5 kg reported). Never gates writes.

**MALFORMED — cumulative outstanding (never written; MC must fix source sheet):**
1. 6/15 E — null ttl_kg (blank weight in source).
2. 6/16 x2 — null shift; one 23,140 kg, one null weight.
3. 6/17 — null shift (22,880 kg).
4. 6/19 — grade 3X50, null shift.
5. 6/20 — grade 3X50, null shift.
6. 6/22 — grade 3X50, null shift (20,800 kg / 800 sacks).
7. 6/23 — grade 3X50, null shift (21,736 kg / 836 sacks).
8. 6/24 — grade 3X50, null shift (unknown kg — not yet in MC workbook as of this run; MC sheet only went to Jun 27 via Jun 27 sheet; Jun 24-26 3X50 rows status unknown).
9. 6/25 — grade 3X50, null shift (same).
10. 6/26 — grade 3X50, null shift (same).
11. 6/27 — grade 3X50, null shift (21,632 kg / 832 sacks — this run).
Action: MC needs to assign shift labels to STARTING/ENDING annotated rows; re-sync once fixed.

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
