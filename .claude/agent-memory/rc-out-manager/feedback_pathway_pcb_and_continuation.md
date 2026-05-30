---
name: feedback-pathway-pcb-and-continuation
description: Two rc_out classification corrections now canonical in the Learning Ledger — pathway/PC-zone feeds are overflow SUNDRY batches (HOLD, don't derive a BLK), and bare-number no-BLOCK-DATE sections are continuation pallets (never a separate row, never counted toward the daily total or the reconciliation gate)
metadata:
  type: feedback
---

These two corrections are **canonical in the Learning Ledger** at `.claude/skills/sync-ictc/LEARNING_LEDGER.md` (entries **L-002** and **L-003**). Read that ledger top-to-bottom before classifying every run — it OVERRIDES the agent's heuristics. This file is the rc-out-specific summary; the ledger is the source of truth.

## L-002 — "ANEAR PATHWAY" / PC-zone feeds are OVERFLOW SUNDRY batches

**Symptom:** A feed whose location text is a pathway / overflow note (e.g. `16B ANEAR PATHWAY`) carries a BLOCK DATE/NO that *derives* to a regular **CLOSED** block (e.g. `NOV-24-BLK5 @ A-20B`). Writing it trips `idx_unique_active_batch_per_location` because that slot is already occupied by an active batch → the whole atomic INSERT rolls back.

**Ground truth (Renzo):** **PCA / PCB are overflow blocks** — extra allocation *within the premises* used when the main warehouse is full. They hold **SUNDRY** batches. The real mapping for `16B ANEAR PATHWAY` was **APRIL-26-SUNDRY1 @ PCB-16A**, NOT NOV-24-BLK5.

**Rule (policy = flag-for-confirmation):** Do **NOT** auto-derive a regular BLK code for pathway / PC-zone feeds. **HOLD + flag** for Renzo to assign the correct SUNDRY batch. Reliable tell: the derived BLK is **CLOSED** AND its `location_ref` is occupied by a *different* active batch → it is almost certainly an overflow/sundry feed, not that BLK. Never write the guess.

**Provenance:** `118629_PROPOSED DAILY REPORT MAY 2026.xlsx` → sheet **MAY 28** → **row 26** (`16B ANEAR PATHWAY`, 19,898 kg, balance 35,186 → 15,288). Resolved by Renzo to APRIL-26-SUNDRY1 @ PCB-16A.

> Mechanical cross-ref: the DB-trigger angle of this same collision is documented in [[feedback-trigger-active-batch-location-collision]] (why the INSERT rolls back). This file is the *classification-policy* angle (what the row actually is, and that you must HOLD + flag rather than derive a BLK).

## L-003 — Bare-number sections (514, 601) are CONTINUATION pallets, not feeds

**Symptom:** A block "section" whose WHSE# / BLOCK NO is a **bare integer** (e.g. `514`, `601`) with **no BLOCK DATE**, holding a few *light* pallet weights. The agent flagged it UNMAPPED and its weight inflated the daily total → a **false "serious drift" halt** of the reconciliation gate.

**Ground truth (Renzo):** It is *not* a separate feed — it is a **continuation of the block directly above it** (more bags of that same feed). Its weight is already inside that block's balance-based DAY TOTAL (STRT.BAL − END.BAL).

**Rule:** Treat a no-BLOCK-DATE, bare-integer section as a **continuation of the preceding block**. Do **NOT** emit it as its own `rc_out` row, do **NOT** add its weight to the daily feed total (already counted), and do **NOT** let it trip the reconciliation gate. (Root cause: `extract_proposed_daily.py` over-segments; until that script is patched, exclude these explicitly.)

**Provenance:** `118629_PROPOSED DAILY REPORT MAY 2026.xlsx` → sheet **MAY 28** → **rows 34–41** (the `514` block sits between the section ending R32 and `A-9C` at R43). Same pattern applies to `601`.

## Standing behavior

- **Read the ledger first, every run.** Apply L-002 and L-003 (and any newer entries) before NEW/CHANGED/UNMAPPED classification.
- **Flag, don't guess.** HOLD any pathway/PC-zone or bare-number-continuation row you can't map with confidence, and surface an actionable flag (what / where / `open '<path>'` / the one question). Copy the flagged source file to `~/blackwood/.sync-flags/<YYYY-MM-DD>/` first so the Open command survives /tmp cleanup.
- **Append-on-correction.** When Renzo corrects a classification, append a new `L-####` entry to the canonical ledger (Symptom / Ground truth / Rule / Provenance). Never edit or delete past entries.

**Related:** [[feedback-trigger-active-batch-location-collision]], [[feedback-reconciliation-scope]], [[feedback-no-label-on-partial-write]]
