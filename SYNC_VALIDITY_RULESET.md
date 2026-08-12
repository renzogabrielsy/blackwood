# Sync Validity Ruleset — what makes scraped data "trustworthy enough to auto-write"

_2026-07-07. Companion to `SYNC_RECONCILIATION_MODEL.md`. Two write policies govern the sync:_

- **Reconciled reports** (`RC IN`, `RC OUT`, `Blocking` — the three with a Google Sheet tab): a fact auto-writes only when ≥2 sources agree; disagreements go to a human. See the reconciliation model.
- **Single-source reports** (`Production`, `Flecon`): there is no second witness, so a fact auto-writes **as long as it passes the validity rules below**. A rule violation is the *only* thing that stops it for a human — as a `rule_violation` case naming the broken rule.

> **Governing principle (Renzo, 2026-07-07):** gate HARD only on things that corrupt inventory math — weights, balances, batch identity. Do NOT hold a row over things that don't affect the balance (cosmetic lab-quality values, or a negative balance that's usually just a delivery not entered yet). The ⚠️ items are now resolved — see **Decisions** at the bottom. Remaining rules are inferred from the L-rules + schema; flag any that are too strict or too loose.

## Universal rules (every report, every row)

| # | Rule | Source / why | On violation |
|---|---|---|---|
| U1 | Required natural-key fields present (date + the report's identity fields) | can't place a row without them | MALFORMED → held |
| U2 | Dates parse and are plausible (not future beyond today, not absurdly old) | catch OCR/format junk | held |
| U3 | Numbers parse; banker's rounding for parity | matches the Python oracle | held |
| U4 | A batch code resolves to **exactly one** existing `batch_id` (try primary + fallbacks) | `batch_code_conventions` (mixed JAN/MARCH prefixes) | UNMAPPED → held; **never auto-create a batch** |
| U5 | Never delete; never silently overwrite a human-corrected row | never-delete posture | held |
| U6 | Extraction is exact — no cross-record math in the scrape | L-037 root lesson | (extractor rule, not a row gate) |

## RC OUT — reconciled (RC OUT tab + proposed report + movement) + self-consistency

| # | Rule | Source | On violation |
|---|---|---|---|
| O1 | `weight_kg > 0`, present | sanity | held |
| O2 | **Balance integrity:** per block, `STRT − END == DAY TOTAL` (tol 1 kg) | L-037 | held (`balance_integrity`) |
| O3 | **Leg continuity:** a block's `STRT` == the immediately-prior same-`(whse, block)`, same-day block's `END` (tol 1 kg) | L-037 | held (the "previous vs latest" monitor you asked for) |
| O4 | `production_batch` label difference **alone** on a matched row = soft warning, not a change | L-034 (month-boundary run label) | soft warning, auto-NOOP |
| O5 | Compare-set window must cover the oldest extracted row | L-034 | (classify rule) |
| O6 | Day total reconciles to the movement sheet | cross-check | informational (the movement witness) |
| O7 | A feed that would drive a block **negative** = **soft warning, still writes** — usually a late RC IN (delivery not yet entered), not a bad feed; O2/O3 + reconciliation catch genuine RC OUT errors | Renzo 2026-07-07 | soft warning, no hold |

## RC IN / deliveries — reconciled (RC IN tab + deliveries email) + Czarina pricing (single-source)

| # | Rule | Source | On violation |
|---|---|---|---|
| I1 | `weight_kg > 0`; `sacks >= 0` | sanity | held |
| I2 | Lab results are **not validated** — display-only quality metrics, never affect inventory math; a wrong value is cosmetic (shows on the grid/digest, corrupts nothing) | Renzo 2026-07-07 | none |
| I3 | `cost_basis` is single-source (Czarina); missing → `0` placeholder | L-008 | placeholder, price-gated |
| I4 | `true_weight_kg` / `deduction_note` are display-only — never enter any balance/view/trigger | schema note | (enforced by not using them) |
| I5 | Upsert by `batch_code` (dedup) | schema | — |

## Blocking — DERIVED (RC IN − RC OUT) + cross-checked vs the Sheet Blocking tab

**Two-level balance check (both must hold):**

| # | Rule | Source | On violation |
|---|---|---|---|
| B1 | **Per-block:** each block's `ΣIN − ΣOUT` == the Sheet's block balance (tol) | the core cross-check | `block_diff` case |
| B2 | **Grand total:** `Σ all blocks` == the overall total | catches errors that net to zero between blocks | `block_diff` case |
| B3 | 1 `block_loc` = 1 active (non-CLOSED) batch | Blocking rules | `block_diff` case |
| B4 | Batch identity per block matches the Sheet's Blocking tab | mapping cross-check | `block_diff` case |
| B5 | `block_loc` format valid `{WHSE}-{COL}{ROW}` (A/B/C/D · 1–20 · row) | Blocking layout | held |

> **Why both B1 and B2:** if weight is mis-attributed between two blocks the errors cancel and the grand total still matches — only the per-block check catches it. "All blocks match AND the total matches" = genuinely balanced.

> **B2's RESIDUAL — the number that actually carries the information (2026-08-12, Renzo's ask).** The grand-total delta on its own says almost nothing, because in practice it is just the B1 blocks added up: measured across **all 11 stored runs** that ever produced a block diff, `Σ(signed per-block gaps)` equalled the grand-total delta **exactly, every time** (e.g. run `dc944b54`: 6,240 + 23,264 + 3,669 + 2,975 = 36,148). So B2 was firing `high` on essentially every run while re-reporting what B1 had already said. B2 now also states **`residual = delta − Σ(signed per-block gaps)`**:
> - **Residual zero** (same `100 kg` tolerance as B2 itself — not a second threshold) → every kilogram of the gap is accounted for by the blocks B1 already flagged. The finding says so explicitly and drops to **`attention`**, level with those block rows. It is reported as **consistent with** the Sheet's Blocking tab not yet reflecting recent feeding — **never asserted as the cause** ("LIKELY, not definitely").
> - **Residual non-zero** → kilograms are missing from the total that **no flagged block explains**. The finding names the unexplained amount and **stays `high`**. Zero blocks flagged + B2 firing is the extreme of this shape: the *whole* gap is unexplained, and it is the most alarming state the check can report.
>
> The gap a block contributes is **`(sheet_kg ?? 0) − (computed_kg ?? 0)`**, deliberately **not** its `delta` field: a *presence* diff (block on one side only) carries `delta: null` yet its whole balance is real gap — which is exactly how the grand total counts it. Two of run `dc944b54`'s four blocks are that shape, and summing `delta` would have fabricated a 26,239 kg residual out of nothing. Signs are preserved, so two blocks off in opposite directions **cancel**. Numbers are exposed as structured finding data (`accounted_block_kg`, `accounted_block_count`, `residual_kg`, `fully_accounted`), not only in prose. Nothing about which blocks get flagged, and no tolerance, changed.

**Sheet Blocking tab structure (RB, verified against the live workbook 2026-07-07):** tab name `"Blocking"` — a 2-D visual grid mirroring the warehouse (NOT a flat table), 11 bands (one per warehouse row A/B/C…), each band 6 stacked rows: `LABEL` (block_loc strings `A-1A`… at cols 8+, plus a PCA/PCB mini-grid at cols 31–33), `BLOCK` (batch_code), `BALANCE` (kg — a SUMIFS over the Sheet's OWN RC IN/RC OUT tabs), then `BD`/`ASH`/`MC` (lab, not reconciled). Grand total lives in col A ("INVENTORY TONS") in **tons** (×1000 = kg) and is the grid's own sum — so it's an extraction-completeness anchor, and the genuinely *independent* B2 check is **Σsheet-blocks vs Σcomputed** (not vs the stated total). Live snapshot when built: 167 occupied blocks, Σ = 10,289,082 kg (== the stated total exactly), no dups, no negatives. RB tolerances: per-block `1 kg`, grand-total `100 kg`.

## Production (production_shifts/runs/downtime/waste + electricity + trucks) — SINGLE-SOURCE, ruleset-gated auto-write

| # | Rule | Source | On violation |
|---|---|---|---|
| P1 | Grade ∈ `{3X50, 6X50, 8X50, 2X6, 4X8}` | L-027 (three-gate grade check) | MALFORMED → held |
| P2 | Upsert the parent shift `(transaction_date, production_batch, shift)` before its children | schema FK | held |
| P3 | Combine duplicate `(shift, customer, grade)` run rows before insert (sum kg + sacks) | L-026 | auto-combine, note in remarks |
| P4 | `dt_mins` ∈ [0, 60) — **DB-enforced** CHECK (verified live; real max is 57) | DB constraint `production_downtime_dt_mins_check` | DB rejects; extract splits hrs/mins |
| P5 | Month-boundary second same-date waste row = the NEW batch's shift, not the outgoing one | L-028 | file under new shift |
| P6 | Electricity natural key `(reading_date, meter)`; `consumption_kwh >= 0`; `diff_kwh` computed | schema | held |
| P7 | Trucks natural key `(reading_date, plate_no)`; `end_km >= start_km` | schema | held |
| P8 | RC IN vs production-OUT drift = **informational only, never a gate** | daily continuous-flow drift is expected | (no hold) |

## Flecon bags — SINGLE-SOURCE, ruleset-gated auto-write

| # | Rule | Source | On violation |
|---|---|---|---|
| F1 | Replace-by-date idempotency (delete + re-insert each in-scope date) | flecon design | — |
| F2 | `bag_type` code resolves to a known `flecon_bag_types` row (fixed column→code map) | schema | held |
| F3 | `qty_delta` sign convention: negative = OUT/consumed, positive = IN | schema | held if ambiguous |
| F4 | Balance cross-check is **informational, never a write gate** | flecon design | (no hold) |
| F5 | Bag counts are integers `>= 0` in magnitude | sanity | held |

## Decisions (2026-07-07, Renzo)
1. **Negative balance (O7):** soft-warning, still writes — never holds. It's usually a late delivery, not a bad feed; the real RC OUT errors are caught upstream by O2/O3 + reconciliation. (The Blocking cross-check B1 still surfaces a `block_diff` if the DB and Sheet disagree — that's a separate, useful signal, and a review case, not a sync-halt.)
2. **Lab results (I2):** not validated at all — display-only, never affect inventory. A garbled reading is cosmetic.
3. **dt_mins (P4):** already DB-enforced (`< 60`); real data maxes at 57. No new rule needed.
4. **Governing principle:** hard gate only on inventory-math corruption (weights, balances, batch identity); everything cosmetic or timing-related is soft-warn-and-write or ignored.

## Still open (lower priority — flag when you spot them)
- Anything in the **"stop and show me"** hold list that's too strict (would hold a row you'd want written) or too loose (would wave through something you'd want to see). React whenever a real run shows you one.
