# ICTC Sync — Workflow Learnings

Living log for the one-click `ictc-sync` workflow (`.claude/workflows/ictc-sync.js`).
Append a dated section per notable run. Newest first.

---

## 2026-05-30 — v1 PARALLEL validation (run `wf_96f6c7b6-4a6`)

**Orchestration:** deliveries + rc-out + production in **PARALLEL** auto-execute (no PROPOSE gate),
then `rc-movement-auditor` read-only after. First parallel run.

### ✅ Validated
- **Parallel is safe — the sequential caution was unnecessary across agents.** 3 concurrent agents on
  one Gmail mailbox → **ZERO `[Errno 60]` timeouts**; every fetch succeeded on attempt 1. Gmail's
  ~15 simultaneous-IMAP-connection ceiling holds easily. The `[Errno 60]` gotcha is **intra-agent
  only** (one process opening two logins at once — e.g. production fetching MC + Ivy, which still
  fetches sequentially *within itself*). Across separate agents it does not apply.
- **Idempotency proven on two independent axes.** deliveries + production both clean **noop**.
  deliveries even ran a control query (with vs without the `Blackwood-Processed` exclusion) to prove
  the dedup actually works rather than silently breaking. Watermark and label agree.
- **The kill-and-relaunch was clean — idempotency held under interruption.** The sequential run that
  was stopped mid-flight had already written 5/27; the parallel run resumed from watermark 5/27 and
  wrote 5/28 with **zero duplication**. Stopping a mid-write run is safe (natural-key dedup +
  label-applied-last).
- **The auditor earns its keep.** It independently caught that rc-out's writes were **incomplete** and
  quantified the exact shortfall — a discrepancy rc-out's own optimistic summary had masked.

### ✅ RESOLVED later same day (2026-05-30) — root cause was NOT what items 1–2 below first assumed
- **The held feed was NOT a stale NOV-24-BLK5 location.** The extractor mis-derived `NOV-24-BLK5`
  from a stray BLOCK DATE/NO on the `16B ANEAR PATHWAY` line. The real batch was **APRIL-26-SUNDRY1
  @ PCB-16A** — an *overflow sundry* block (extra premises allocation when the main warehouse is full).
  Renzo entered both days manually (5/27 +12,563, 5/28 +19,898); rc_out now reconciles to RC MOVEMENT
  **exactly** (64,686 and 56,393, drift 0). → Ledger **L-002**.
- **"514" (and "601") are NOT feeds.** They are mis-parsed **continuation pallets** of the block above
  (`16B ANEAR PATHWAY`); their weight is already in that block's balance total. Nothing to write.
  → Ledger **L-003**.
- **Root cause = two extractor issues**, both now captured as Rules in `LEARNING_LEDGER.md`:
  (a) over-segmentation splitting continuation rows into phantom blocks; (b) no PC-overflow/sundry awareness.
  Fixing (a) also subsumes the "reconciler --unmapped-aware" backlog item — the phantom weight disappears,
  so the false "serious drift" can't occur. Extractor patch proposed (deferred); the ledger makes the
  agent handle both correctly in the meantime.

### 🔴 Open DATA issues (need human/domain resolution — NOT workflow bugs)
1. **NOV-24-BLK5 stale location → 32,461 kg stranded.** Batch is `CLOSED@A-20B` in the DB, but A-20B
   is occupied by active MAY-26-BLK2 (STORED, 70,200). Operator fed NOV-24-BLK5 from
   "16B ANEAR PATHWAY". An rc_out INSERT would re-activate it at A-20B and trip
   `idx_unique_active_batch_per_location`. Held on **both** 5/27 (12,563 kg) and 5/28 (19,898 kg).
   **Fix: correct NOV-24-BLK5's `location_ref` (likely a 16B block), then re-run rc-out to land the
   stranded feed.**
2. **Block "514" UNMAPPED — 2,749 kg.** No derivable batch_code (block_no 514, no block_date). Same
   pattern as historical block 601. Needs a batch_code mapping decision.
3. **4 over-consumed batches (PRE-EXISTING, not from this run).** `view_rc_movement` negative
   balances: OCT-25-BLK9 (**-11,788 kg**, worst), JAN-26-SUNDRY7 (-2,536), APRIL-26-SUNDRY3 (-1,017),
   JAN-26-SUNDRY6 (-864). Fed more than ever delivered. Route to deliveries/rc_out owner.

### 🟡 Current rc_out state
- 5/27 and 5/28 are both **PARTIAL** in rc_out, each short by its NOV-24-BLK5 amount. PROPOSED thread
  (UID 118629) was deliberately **left UNLABELED** so the next run retries once NOV-24-BLK5 is fixed.
- 5/11: minor +270 kg (rc_out slightly higher; possible duplicate small feed). Low priority.

### 🔧 Workflow-hardening backlog (prioritized)
1. **[HIGH] Reconciler `--unmapped-aware`.** The HARD drift gate false-flags "serious" because
   UNMAPPED-block weight (514 today, 601 historically) inflates the PROPOSED daily sum even though
   those rows are never written. **2nd documented instance → systematic, not a fluke.** Fix:
   `reconcile_rc_movement.py` should subtract no-batch_code rows from PROPOSED before computing drift
   (or emit drift both with/without unmapped). Until fixed the agent must hand-prove
   `mapped-subtotal == RC MOVEMENT`.
2. **[HIGH] rc-out reconciliation should be WRITE-based, not MAP-based.** rc-out reported
   "5/28 MAPPED 3 rows = 56,393 = RC MOVEMENT, drift 0" but only **2 rows / 36,495 actually landed**
   (NOV-24-BLK5 held). Its "reconciles perfectly" counted a row it didn't write. Compute/report
   reconciliation on ACTUALLY-WRITTEN rows so the summary matches the DB and `status=halted` can't
   coexist with a "drift 0" narrative.
3. **[MED] Trigger INSERT-branch needs a replacement-location guard.** `fn_process_blackwood_usage`
   INSERT branch sets batch status from destination/remarks with NO weight/replacement-location guard
   (the UPDATE branch has both). That's what makes NOV-24-BLK5 trip. Schema/trigger change →
   supabase-backend-engineer.
4. **[MED] Standing-backlog pre-flight flag.** Auto-flag any batch held N consecutive runs
   (NOV-24-BLK5 held 2×) so it can't be missed across runs.
5. **[LOW] Production redundant-fetch.** ~9–13 sibling same-day report threads stay unlabeled, so every
   run re-fetches/re-extracts cumulative workbooks (up to ~727 KB MC). Cheap + watermark-safe but
   wasteful. Options: label fully-≤-watermark threads on noop; tighten the `after:` window; or label
   all fetched same-source threads in EXECUTE.
6. **[LOW] Reconciler `--watermark`/`--min-date` flag** to avoid hand-building the new-only extract.
7. **[LOW] deliveries dual-query idempotency proof** baked into the run so a zero is always provably
   "no new mail," not a silent IMAP/auth failure.

### Timing
- Whole parallel run ~10 min wall (vs ~15+ sequential). Noop agents finish ~10s each; rc-out (the only
  real worker) dominated.

### Agent-memory updated this run (by the agents themselves)
- `rc-out-manager`: corrected the trigger-collision condition (the old `current_weight - weight_kg > 0`
  guard was too narrow; real condition is status=CLOSED AND remarks NOT ILIKE '%CLOSED%' AND
  destination IN (MAIN,SUNDRY) AND location occupied).
- `rc-movement-auditor`: recorded that `SUM(view_rc_movement.fed_today) == SUM(rc_out.weight_kg)` always
  (the view is a pure projection of rc_out — only one real drift axis: RC MOVEMENT email vs rc_out) +
  the standing over-consumption cluster.
