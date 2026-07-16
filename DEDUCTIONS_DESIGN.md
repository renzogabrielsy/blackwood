# Weight Deductions & True-Weight Representation — Design

**Status:** DRAFT for Renzo's review — 2026-06-25. Locked decisions marked ✅. Open questions marked ❓.

---

## The problem

Charcoal deliveries often carry quality deductions — **ASH** (impurity) and **MC / wet sacks** (moisture). The operator sheets and emails handle this by **deducting weight**: the load is recorded at a reduced weight, at full price, so "less weight = less paid." This keeps the **money** correct but **understates the physical weight** sitting in the block. When a block is later closed/emptied and physically weighed, the scale reads higher than the system.

Two visible symptoms found on 2026-06-25:
- **D-20D / JUNE-26-BLK6** is short 2,593 kg because two "net-wet recovery" sub-rows (960 kg + 1,633 kg) were **discarded** by the sync (flagged "malformed" — no truck/batch of their own).
- Any deducted load leaves the block weight lower than physical reality.

---

## Core principle (the decision that makes this safe) ✅

**Never overwrite the source number — annotate alongside it.**

- The Sheet/emails are the source of truth and will **always** use weight-deduction. Blackwood mirrors that as the **primary** weight, so the sync never conflicts.
- Blackwood **adds** the true (physical) weight as an **extra, tagged field**, computed only when a deduction exists.

**Rejected alternative:** overwrite `weight_kg` with the true weight and move the deduction into a reduced stored price. Rejected by Renzo's own observation — it would make every deducted delivery permanently differ from the Sheet, so the sync would flag or revert it forever. The "deduction in the price" effect is instead achieved as a **display** (effective ₱/kg = cost ÷ true weight), not a stored overwrite.

---

## Locked decisions ✅

1. **Trigger only on a deduction.** No deduction → business as usual, no extra field, no tag.
2. **`weight_kg` stays = the Sheet's DEDUCTED weight** (primary; the only value the sync compares → zero new conflicts).
3. **Add a true/physical weight field**, computed at ingestion from net + the stated deduction. NULL when no deduction.
4. **Price (`cost_basis`) stays full/unchanged.** Deducted weight × full price = correct money = matches the Sheet.
5. **Quality-adjusted ₱/kg is DISPLAYED, never stored** — effective ₱/kg = cost ÷ true weight (comes out lower for wet/ashy loads, which is the intent).
6. **A visible deduction tag** marks affected rows in the deliveries table, with a remark explaining the weight-vs-price correction.
7. **ASH and MC deductions are treated identically.**
8. **Wet recovery sacks = always their own separate delivery row** — inheriting the mother truck's truck #, block, supplier, batch, and price, but with **their own** weight / sacks / MC, plus their own true weight + tag.
9. **No view ever uses true weight in a balance or computation.** Every balance everywhere — grid, closing, blend proposal, batch totals — stays on the deducted `weight_kg`. Blackwood therefore matches the Sheet **everywhere, with zero divergence.** True weight is purely informational.
10. **True weight is surfaced only as a popover / hover** on relevant views (deliveries table, delivery detail, blocking panel) — never a computed value. At closing, the operator reads the physical weight from the popover and reconciles by eye; the system's balance number is untouched.

---

## Resolved decisions ✅ (locked by Renzo 2026-06-25)

- **A. "True weight" = gross before BOTH deductions** (ASH + wet). Consistent with treating ASH and MC the same.
- **B. No view uses true weight in any balance/computation.** Every balance stays on the deducted `weight_kg`. True weight is shown **only as a popover** on relevant views — it never feeds a calculation. (So there is no Sheet divergence anywhere, including the Blocking tab.)
- **C. Keep the tag simple:** store `true_weight_kg` + a short `deduction_note`; "tagged" = `true_weight_kg IS NOT NULL`. No structured deduction record for now.

## Rollout ✅ (locked by Renzo 2026-06-25)

- **Forward-only. No backfill.** This is a protocol that applies to deliveries ingested from now on. Existing/historical delivery rows are NOT re-tagged, and previously-dropped recovery rows are NOT inserted retroactively. The Σ marker simply appears on new deducted loads going forward.
- **Remaining to complete the forward protocol:** `extract_gsheet.py` (the PRIMARY RC IN source) must get the same deduction-tagging + recovery handling as the email path, so deductions arriving via the Google Sheet are also tagged at write time. Until then only the email deliveries path tags deductions.

---

## Proposed schema (deliveries)

- `true_weight_kg numeric NULL` — physical/gross weight; NULL means no deduction (= ordinary load).
- `deduction_note text NULL` — human-readable, e.g. `"−5.86% ASH; −1,009 wet → recovery"`.
- Tag is **derived**: a row "has a deduction" when `true_weight_kg IS NOT NULL`.
- Migration + regenerate `types/supabase.ts`. No change to `weight_kg` or `cost_basis` semantics.

## Sync changes

- **Extractor:** detect deductions in sheet/email remarks; compute `true_weight_kg` and `deduction_note`. Detect **recovery sub-rows** (a continuation row carrying weight + MC but no truck/batch) and emit them as **separate** delivery rows that inherit the mother's truck/block/supplier/batch/price, each with its own true weight.
- **Classifier / compare:** unchanged matching — still keys on the Sheet-matching `weight_kg`, so no new conflicts. The true-weight + note are additive, written on insert/update.
- **Stop discarding recovery rows** (today's D-20D leak).

## UI changes

- **Deliveries table:** on tagged rows, a small marker; a **popover/hover** shows `True weight: X kg (recorded Y after deduction) · effective ₱/kg Z`.
- **Delivery detail / Blocking panel:** the same true-weight + effective-₱/kg popover. **No balance/closing number changes** — popover is reference-only.
- **Price gating** still applies to every ₱ value shown (effective ₱/kg included).

## The math (for reference)

- `net` (deducted, = `weight_kg`) = `gross × (1 − d)`
- `true_weight_kg` = `gross`
- money paid = `net × full_price` (unchanged, matches Sheet)
- effective ₱/kg (displayed) = money ÷ true_weight = `full_price × (1 − d)`

---

## Why this answers "is it worth it?"

The naive version (overwrite weight, store reduced price) is **not** worth it — it fights the Sheet forever. This version keeps Blackwood matching the Sheet on **every** column and **every** balance, while **adding** the physical weight on top as a look-but-don't-touch popover. You can *see* the real weight at closing and a quality-adjusted price, with **zero** divergence from the Sheet anywhere. The deduction tag is the bridge that makes it legible to you without ever confusing the sync.
