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
