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
