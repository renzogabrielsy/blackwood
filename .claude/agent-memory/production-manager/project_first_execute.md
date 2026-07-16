---
name: production-first-execute-done
description: Production Manager completed its first real EXECUTE on 2026-05-29 — DB advanced from 5/23 to 5/28
metadata:
  type: project
---

The Production Manager ran its first successful EXECUTE on **2026-05-29**, advancing the production watermark from **2026-05-23 → 2026-05-28**.

Catch-up window 5/25–5/28 (MC UID 118639 + Ivy UID 118635). Wrote 8 production_shifts, 8 runs, 4 downtime, 8 waste, 4 electricity, 1 truck = 25 data rows + 8 shifts, plus 33 audit_logs. Both Gmail threads labeled Blackwood-Processed. Zero VALUE_CHANGED, zero MALFORMED — textbook clean catch-up.

**Why:** The auto-memory MEMORY.md (user scope) still says "First EXECUTE not yet run (DB through 5/23; catch-up 5/25–5/28 pending)" — that note is now stale. The employee's PROPOSE→EXECUTE flow is proven end-to-end against the live DB.

**How to apply:** The pipeline (extract --since exclusive, classify with shift upsert, informational reconcile, audit-logged writes, label) works as designed. The natural-key tables' generated columns (diff_kwh, consumption_kwh, ttl_km) compute correctly when raw readings + meter_multiplier are inserted. Related operating context lives in the agent definition at .claude/agents/production-manager.md.

## Second EXECUTE — 2026-06-02 (watermark 5/28 → 6/01)
Catch-up window 5/29 + 6/01 (no 5/30–5/31 sheets — weekend). MC UID 118914 + Ivy UID 118900. Wrote **3 shifts + 3 runs + 2 downtime + 2 waste + 2 electricity = 12 rows + 12 audit_logs**; both threads labeled. 39,156 kg new output (05-29 = 18,096 across MAY+JUNE batches; 06-01 = 21,060). No audit triggers exist on any of the 6 production tables — audit_logs are written MANUALLY (unlike deliveries, which auto-audits; see L-001).

**Three gotchas hit + resolved (now codified as L-007 in LEARNING_LEDGER.md):**
1. The 3 runs first classified MALFORMED (null-shift) — actually MC's `STARTING`/`ENDING` text in column H = **batch-boundary markers**, not shift labels. ENDING=closing run of old batch, STARTING=opening run of new batch → same date, different production_batch. Shift inferred from the day's M downtime/waste.
2. `production_downtime.dt_mins` has `CHECK (dt_mins < 60)` — extractor emits TOTAL minutes; must split ≥60 into dt_hrs+remainder (243→4h3m).
3. `production_waste` has `UNIQUE (shift_id)` = one waste row per shift. A 05-29 carryover row (323.5 kg, sat in JUNE sheet) collided with the base 05-29 MAY/M waste row → **HELD, not auto-merged** (awaiting Renzo: sum into the per-shift row, or different shift?).

Next sync starts from watermark **2026-06-01** (since_date = 5/29 in Gmail). One open item: the held 05-29 carryover waste row.

## Third EXECUTE — 2026-06-03 (watermark 6/01 → 6/02)
Single new day **06-02**. MC UID 119046 + Ivy UID 119047 (latest cumulative workbooks; older UIDs 118818/118783 also labeled). Wrote **1 shift + 1 run + 1 downtime + 1 waste + 1 electricity = 5 rows + 5 audit_logs**; all 4 threads labeled. shift_id `75d6e914-d451-4fb5-8ba8-797e0295ab62`. Output: run 26,520 kg / 1,020 sacks (CEBU 3X50), waste 3,372.5 kg, downtime 0h6m, electricity 448→453.6 ×120 (consumption 672 kWh). Trucks: MC sent none (truck watermark still stuck at 5/26). Reconcile all-green (G13 26520 = run; waste sum = reported).

**L-007 applied cleanly:** run R8 had a BLANK shift cell (not STARTING/ENDING — single-batch JUNE day, verified in raw sheet). Inferred M from the day's downtime+electricity per L-007 rule 2; Renzo confirmed M. No batch-boundary, no dt_mins split (6<60), no waste collision. Zero VALUE_CHANGED, zero MALFORMED. Textbook.

Next sync starts from watermark **2026-06-02** (since_date = 5/30 in Gmail).

## Fourth EXECUTE — 2026-06-05 (watermark 6/02 → 6/04)
MC UID **119148** (1 thread) + Ivy UID **119257** (latest of 2; 119147 superseded). MC carried one new day **06-03**; Ivy waste led a day ahead with **06-03 + 06-04**. Wrote **2 shifts + 1 run + 1 downtime + 2 waste + 1 electricity + 2 trucks = 7 rows + 2 shifts + 9 audit_logs**; both threads labeled. Shift ids: 06-03 `2862666d-5b44-4725-aba4-7682d723dd6d`, 06-04 `41174092-e120-4913-925e-74e02e2be43e`. Output: run 31,200 kg / 1,200 sacks (CEBU 3X50, batch JUNE), electricity 453.6→459.7 ×120, downtime 0h6m. Waste 06-03 = 3,745.5 kg, 06-04 = 3,971.5 kg. Reconcile all-green.

**Truck watermark stall CLEARED:** MC finally sent 2 truck rows for 06-03 (AAV 6111, KCA 378) — truck_readings advanced **2026-05-26 → 2026-06-03** after being stuck operator-side for ~8 days. electricity → 06-03; production_shifts → **06-04** (Ivy waste leads MC by a day, so the shifts watermark runs ahead of runs/downtime/electricity which sit at 06-03).

**L-007 applied cleanly again (same blank-shift sub-case as 3rd EXECUTE):** run R8 blank shift cell → inferred M from same-day downtime+electricity+Ivy-waste, single-batch JUNE, no STARTING/ENDING boundary. No dt_mins split (6<60), no waste collision (06-03 and 06-04 are distinct shift parents). Zero VALUE_CHANGED, zero MALFORMED.

Next sync starts from watermark **2026-06-04** (since_date = 6/01 in Gmail). Note the split watermark: runs/downtime/electricity at 06-03, shifts/waste at 06-04 — MC's 06-04 sheet will arrive in a later email.

## Sixth EXECUTE — 2026-06-11 (watermark 6/05 → 6/10) + new failure mode L-016
(5th EXECUTE was 2026-06-08, the L-014 6/05 catch-up that left the DB at 6/05.) This run caught up **6/6–6/10**. MC UID **119723** + Ivy UID **119724** (latest cumulative workbooks; older MC 119470/119520/119632 + Ivy 119147/119620 also labeled — 7 threads total). 6/7 absent (Sunday). Wrote **5 shifts + 4 runs + 3 downtime + 4 waste + 3 electricity + 3 trucks = 22 rows + 22 audit_logs**; all 6 production tables now current through **2026-06-10**.

**NEW failure mode → L-016 (date-relabel duplicate).** MC's 06-06 day-sheet was **byte-identical to the 6/05 day already in the DB** (run 20,904/804; elec 465.4→472.1; truck AAV6111 12,983.7→13,299.1; downtime 12h/130min same REPAIR text). The watermark (`MAX(transaction_date)`=6/05, `--since` exclusive) does NOT catch this — 6/6 is "after" 6/5 so it survives the filter, and all 5 classifiers called it NEW (natural keys differ only by the date label). The cumulative electricity meter is the tell: 6/5 ended 472.1 and the next *genuine* reading (6/8) STARTS 472.1 → no separate 6/6 reading; **6/6 IS 6/5 relabeled.** Renzo: DROP 6/6 entirely. Held it (no shift parent created); verified post-write 6/6 shift=0 & elec=0.

**6/8 = no-production maintenance day.** Blank-shift run was **0 kg / 0 sacks** → per Renzo, SKIP the 0-kg run but DO write the day's downtime (REPAIR, 0 min) + electricity (472.1→473.2) + truck (KCA 378). L-007/L-014 blank-shift→M still applied to the *parent shift* (2026-06-08, JUNE, M). 6/9 + 6/10 each ran M+E (genuine two-shift days). No dt_mins split (15, 13, both <60). Reconcile all-green.

Next sync starts from watermark **2026-06-10** (since_date = 6/07 in Gmail). All three watermarks (shifts/electricity/trucks) now aligned at 6/10.

**Standing PROPOSE check now owed (L-016):** for any day-sheet dated exactly watermark+1, cross-check it against the immediately-preceding ingested day (run/elec-meter/truck/downtime) before trusting NEW — a byte-identical day is a date-relabel DUPLICATE, HOLD it.

## Seventh EXECUTE — 2026-06-12 (watermark 6/10 → 6/11) — clean single-day, L-016 check PASSED
Single new day **06-11**. MC UID **119807** + Ivy UID **119804** (both sent 6/12 morning, reporting the prior production day). Wrote **2 shifts + 2 runs + 1 downtime + 2 waste + 1 electricity = 6 rows + 2 shifts + 8 audit_logs**; both threads labeled. Shift ids: M `4e377b45-eece-4f93-9242-d9d2a8b69dbb`, E `d155641f-9fe3-41a3-b1b3-0c19a2a3d952`. Two genuine shifts: M run 25,090 kg/965 sacks, E run 23,712 kg/912 sacks (CEBU 3X50, batch JUNE; day total 48,802). Downtime M only (12 min REPAIR, <60 no split). Waste M 3,639.5 (ZAMBAONGA) + E 3,171.5 (PCG/BUNAWAN). Electricity MAIN 491.2→500.1 ×120 (consumption 1068). No trucks on the 6/11 sheet → truck watermark stays 6/10 (expected). Reconcile all-green.

**L-016 check applied and PASSED (first clean pass of the new standing check):** 6/11 = watermark+1, so cross-checked vs the 6/10 DB day. Electricity meter is the tell: DB 6/10 ended **491.2**, MC 6/11 STARTS **491.2** → genuine continuation, NOT a relabel (a duplicate would repeat 482.2→491.2). Production values also differ materially (6/11 M 25,090 vs 6/10 M 27,066). Confirmed NEW, wrote it. Zero VALUE_CHANGED, zero MALFORMED, no holds. No new ledger entry (append-on-correction only; nothing was corrected).

Next sync starts from watermark **2026-06-11** (since_date = 6/08 in Gmail). shifts + electricity at 6/11; trucks at 6/10 (awaiting a truck row from a later MC sheet).
