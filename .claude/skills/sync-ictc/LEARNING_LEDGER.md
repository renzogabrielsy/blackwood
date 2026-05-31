# ICTC Sync — Learning Ledger

**Ever-growing. Append-only. This is the institutional memory of the ICTC sync employees.**
Every time an agent gets something wrong and Renzo corrects it, that correction becomes a
permanent entry here. Every agent **reads this file top-to-bottom before it classifies**, so a
mistake is made *at most once*.

> This is the heart of the self-learning loop: **mistake → correction → ledger entry → never again.**

---

## Protocol

1. **Read-before-run.** `deliveries-manager`, `rc-out-manager`, `production-manager`, and
   `rc-movement-auditor` each read this ledger at the start of every run and apply every **Rule** below.
2. **Flag, don't guess.** If a row matches a **Symptom** here but you still can't map it with
   confidence, **HOLD** it and emit an **actionable flag** (format below). Never write a guess.
3. **Append-on-correction.** Whenever Renzo corrects a classification, append a new entry (next
   `L-####` id) capturing *Symptom → Ground truth → Rule → Provenance*. **Never edit or delete a
   past entry** — if a rule changes, add a new entry that supersedes it and note the old id.

## Actionable-flag format (what every HOLD must surface in the run summary)

- **What** — the row: date, weight, the operator's raw label/text, your best-guess batch + why you're unsure.
- **Where** — `source_file` (absolute path), `sheet`, and `rows` (exact row numbers).
- **Open** — a ready command: `` open '<absolute path>' `` — so Renzo can eyeball the source in one click.
  Agents must **copy the flagged source file to `~/blackwood/.sync-flags/<YYYY-MM-DD>/`** (stable, survives /tmp cleanup) and point the open command there.
- **Ask** — the one specific question ("which batch is this feed?").

---

## Entries — newest first

<!-- APPEND NEW ENTRIES DIRECTLY BELOW THIS LINE (newest first). Bump the L-#### id. Never edit past entries. -->

### L-006 · 2026-05-31 · deliveries · CONFIRMED root cause of the `current_weight` double-count (supersedes the root-cause hypothesis in L-005) — deliveries-manager must NEVER do `current_weight += delta`
- **Confirmed (supabase-backend-engineer, read the live trigger defs + audit_logs):** The DB triggers are CORRECT and were not changed. `fn_update_blackwood_state` (BEFORE INSERT on `deliveries`) already does a single `current_weight = current_weight + NEW.weight_kg`; `fn_process_blackwood_usage` (INSERT on `rc_out`) already does a single `current_weight = current_weight - NEW.weight_kg`. So after a plain delivery/rc_out INSERT, `current_weight` is ALREADY maintained — the agent must add nothing.
- **Proof it was the agent, not the trigger:** Same trigger, same table — the 6 deliveries the deliveries-manager inserted on **2026-05-26** are NOT doubled, but the 3 it inserted on **2026-05-27 03:04:39** (thread 1866222694392448962, op UID 118420) are each doubled by *exactly their own weight* (MAY-26-BLK7 +16,135, MAY-26-BLK9 +18,725, MAY-26-FEED6 +19,330). The only thing that can produce "+= exactly the row's weight, but only on one run" is an extra imperative `UPDATE batches SET current_weight = current_weight + <weight>` that run issued on top of the trigger. MAY-26-FEED5's +13,330 came from the 2026-05-30 rc_out reassignment run leaving `current_weight` stale.
- **Rule (playbook, HARD):** In EXECUTE mode, after inserting a delivery (or an rc_out row), **do NOT issue any `UPDATE batches SET current_weight = ...`** — the trigger owns it. The current deliveries-manager playbook's only `current_weight` write is the `INSERT INTO batches (... current_weight) VALUES (..., 0) ON CONFLICT DO NOTHING` for *brand-new* batches, which is fine (the row is 0 before its first delivery's trigger fires). If a future step genuinely must reconcile `current_weight`, it MUST be the **idempotent absolute form** — `SET current_weight = COALESCE((SELECT SUM(weight_kg) FROM deliveries WHERE batch_code=b.batch_code),0) - COALESCE((SELECT SUM(weight_kg) FROM rc_out r WHERE r.batch_id=b.id),0)` — NEVER a `+= delta` form, which races/duplicates the trigger.
- **Also:** after an rc_out **reassignment** (changing `rc_out.batch_id`), the trigger recomputes via `+ OLD.weight_kg - NEW.weight_kg` on the new batch and `+ OLD.weight_kg` on the old batch — correct *if done as a single UPDATE of the existing row*. If the agent instead DELETEs+INSERTs or hand-moves weight, it can leave the old batch stale. Prefer a single `UPDATE rc_out SET batch_id=...`; if in doubt, reconcile both affected batches with the absolute form above and verify `current_weight == in − out`.
- **Provenance:** Live `pg_get_functiondef` of both triggers + `audit_logs` INSERT timestamps, 2026-05-31. View made self-correcting in migration `20260531041520`; 3 active batches re-synced in `20260531041615`. See AUDIT_FINDINGS AF-001 (RESOLVED).

### L-005 · 2026-05-31 · blocking/deliveries · `current_weight` drifts from transactions — balance must always = SUM(in) − SUM(out)
- **Symptom:** The Sheet-vs-DB blocking value-check flagged 2 slots; a full sweep found **3 active batches** where `batches.current_weight` exceeds the real `SUM(deliveries) − SUM(rc_out)`: MAY-26-FEED6 (+19,330), MAY-26-BLK9 (+18,725), MAY-26-BLK7 (+16,135) ≈ **54 t phantom**. For BLK9/BLK7 the drift equals *exactly the most-recent delivery* → the delivery-insert path double-counted `current_weight`; FEED6 shows a reassignment also failed to recompute it. `view_blocking_grid.balance` reads `current_weight` (not in−out), so the app displays the phantom while the Sheet held the correct value.
- **Ground truth (cross-check 2026-05-31):** The Sheet (= SUM deliveries) is correct; `current_weight` is the buggy field. Balance is **always** `SUM(in) − SUM(out)`.
- **Rule:** (1) After a delivery insert or an rc_out reassignment, NEVER imperatively touch `current_weight` — the trigger owns it; if you must, verify `current_weight == in − out` afterward and flag (same family as L-001). (2) Treat `current_weight` as untrusted for balance; the canonical balance is the transaction sum. (3) The Sheet-vs-computed-balance blocking check is a **standing audit step** (see AUDIT_FINDINGS AF-001).
- **Provenance:** `view_blocking_grid` + `batches` sweep, 2026-05-31. Fix delegated to supabase-backend-engineer (re-sync the 3 + make the view compute from transactions + stop the double-count).

### L-004 · 2026-05-30 · rc_in · "NEW" rows with matching date+batch+weight but different block_loc = block_loc correction, NOT a new delivery
- **Symptom:** The classifier reported 12 RC IN rows as NEW (key `(date, batch_code, block_loc, weight_kg)` absent from DB). On attempting INSERT, the DB rejected them with a NOT NULL constraint on `cost_basis`. Investigation revealed the DB already had rows for those exact date+batch+weight combinations — just with **different block_loc values** (e.g. Sheet `A-4C`, DB `A-3A`; Sheet `PCA-16A`, DB `A-4B`). Inserting would have created duplicate rows (same physical delivery, different location label).
- **Ground truth (gsheet-sync EXECUTE run 2026-05-30):** These are likely the same physical deliveries recorded at the actual block location in the DB, with the Sheet having a different (possibly corrected or overflow) block_loc. Specifically: JAN-26-SUNDRY4 @ A-4C (Sheet) vs A-3A (DB); JAN-26-SUNDRY6 @ PCA-16A (Sheet) vs A-4B (DB); JAN-26-SUNDRY7 @ PCA-16B (Sheet) vs A-4C (DB).
- **Rule:** Before inserting any RC IN "NEW" row, check if the DB already has a row with matching `(transaction_date, batch_code, weight_kg)` but a *different* `block_loc`. If so, HOLD and flag as a block_loc discrepancy — do NOT insert. The question for Renzo: which block_loc is correct? If the Sheet block_loc wins, UPDATE the DB row's `block_loc` (not INSERT a new row). If the DB block_loc is correct, it's a NOOP.
- **Provenance:** 12 JAN-26-SUNDRY4/6/7 layupan rows, Sheet tab RC IN rows 662–822. Source: `/Users/renzosy/blackwood/.sync-flags/2026-05-30/rc_gsheet_20260530T153429Z.xlsx`.

### L-003 · 2026-05-30 · rc-out · Bare-number sections (514, 601) are CONTINUATION pallets, not feeds
- **Symptom:** A block "section" whose WHSE# / BLOCK NO is a bare integer (e.g. `514`, `601`) with
  **no BLOCK DATE**, holding a few *light* pallet weights. The agent flagged it UNMAPPED, and its
  weight inflated the daily total → a **false "serious drift" halt**.
- **Ground truth (Renzo):** It is *not* a separate feed — it's a **continuation of the block directly
  above it** (more bags of that same feed). Its weight is already inside that block's balance-based
  DAY TOTAL (STRT.BAL − END.BAL).
- **Rule:** Treat a no-BLOCK-DATE, bare-integer section as a continuation of the preceding block.
  Do **not** emit it as its own `rc_out` row, do **not** add its weight to the daily feed total
  (already counted), and do **not** let it trip the reconciliation gate. *(Root cause:
  `extract_proposed_daily.py` over-segments; until patched, exclude these explicitly.)*
- **Provenance:** `118629_PROPOSED DAILY REPORT MAY 2026.xlsx` → sheet **MAY 28** → **rows 34–41**
  (the `514` block sits between the section ending R32 and `A-9C` at R43). Same pattern: `601`.

### L-002 · 2026-05-30 · rc-out · "ANEAR PATHWAY" / PC-zone feeds are OVERFLOW SUNDRY batches
- **Symptom:** A feed whose location text is a pathway/overflow note (e.g. `16B ANEAR PATHWAY`) with
  a BLOCK DATE/NO that derives to a regular **CLOSED** block (e.g. `NOV-24-BLK5 @ A-20B`), which then
  trips `idx_unique_active_batch_per_location` because that slot is occupied by an active batch → write held.
- **Ground truth (Renzo):** **PCA/PCB are overflow blocks** — extra allocation within the premises
  used when the main warehouse is full. They hold **SUNDRY** batches. `16B ANEAR PATHWAY` was
  **APRIL-26-SUNDRY1 @ PCB-16A**, *not* NOV-24-BLK5.
- **Rule (policy = flag-for-confirmation):** Do **not** auto-derive a regular BLK code for
  pathway / PC-zone feeds. **HOLD + flag** for Renzo to assign the correct SUNDRY batch. Reliable
  tell: the derived BLK is CLOSED **and** its `location_ref` is occupied by an active batch → it's
  almost certainly an overflow/sundry feed, not that BLK.
- **Provenance:** `118629_PROPOSED DAILY REPORT MAY 2026.xlsx` → sheet **MAY 28** → **row 26**
  (`16B ANEAR PATHWAY`, 19,898 kg, balance 35,186 → 15,288). Resolved by Renzo to APRIL-26-SUNDRY1 @ PCB-16A.

### L-001 · 2026-05-29 · deliveries · `audit_logs` is trigger-written — UPDATE, don't INSERT
- **Symptom:** Following the playbook's manual `INSERT INTO audit_logs` after a delivery insert created
  a **duplicate** audit row, because `deliveries_audit_trigger` already wrote one.
- **Ground truth:** The trigger auto-creates the audit row on insert.
- **Rule:** After inserting a delivery, **UPDATE** the trigger-created audit row's comment for
  provenance; never INSERT a second one. Keep batch-insert and delivery-insert as **separate**
  statements (CTE/trigger snapshot visibility).
- **Provenance:** deliveries-manager EXECUTE run 2026-05-29; detail in agent-memory
  `deliveries-manager/project_db_triggers_on_deliveries.md`.

---

*This ledger is the source of truth for hard-won corrections. When in doubt, it wins over the agent's heuristics.*
