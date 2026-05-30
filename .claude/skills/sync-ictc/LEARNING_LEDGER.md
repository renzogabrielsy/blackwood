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
