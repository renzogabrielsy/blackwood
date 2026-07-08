# Sync Validity Ruleset — what makes scraped data "trustworthy enough to auto-write"

_2026-07-07. Companion to `SYNC_RECONCILIATION_MODEL.md`. Two write policies govern the sync:_

- **Reconciled reports** (`RC IN`, `RC OUT`, `Blocking` — the three with a Google Sheet tab): a fact auto-writes only when ≥2 sources agree; disagreements go to a human. See the reconciliation model.
- **Single-source reports** (`Production`, `Flecon`): there is no second witness, so a fact auto-writes **as long as it passes the validity rules below**. A rule violation is the *only* thing that stops it for a human — as a `rule_violation` case naming the broken rule.

> **These rules are INFERRED from our sync history (the L-rules + schema constraints + the incidents we've lived through). Renzo: please confirm / correct each. Rules marked ⚠️ are my best guess and most need your eyes.** This file is the living ruleset — it grows the way the L-ledger does.

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
| O7 ⚠️ | A feed must not drive a block's balance **negative** | physical impossibility | held (ties to Blocking B1) |

## RC IN / deliveries — reconciled (RC IN tab + deliveries email) + Czarina pricing (single-source)

| # | Rule | Source | On violation |
|---|---|---|---|
| I1 | `weight_kg > 0`; `sacks >= 0` | sanity | held |
| I2 ⚠️ | Lab results, if present, within plausible ranges (mc/ash/bd/grit/vm/fc) | quality sanity | ⚠️ ranges TBD → soft warning |
| I3 | `cost_basis` is single-source (Czarina); missing → `0` placeholder | L-008 | placeholder, price-gated |
| I4 | `true_weight_kg` / `deduction_note` are display-only — never enter any balance/view/trigger | schema note | (enforced by not using them) |
| I5 | Upsert by `batch_code` (dedup) | schema | — |

## Blocking — DERIVED (RC IN − RC OUT) + cross-checked vs the Sheet Blocking tab

**Two-level balance check (both must hold):**

| # | Rule | Source | On violation |
|---|---|---|---|
| B1 | **Per-block:** each block's `ΣIN − ΣOUT` == the Sheet's block balance (tol) AND is `>= 0` | the core cross-check | `block_diff` case |
| B2 | **Grand total:** `Σ all blocks` == the overall total | catches errors that net to zero between blocks | `block_diff` case |
| B3 | 1 `block_loc` = 1 active (non-CLOSED) batch | Blocking rules | `block_diff` case |
| B4 | Batch identity per block matches the Sheet's Blocking tab | mapping cross-check | `block_diff` case |
| B5 | `block_loc` format valid `{WHSE}-{COL}{ROW}` (A/B/C/D · 1–20 · row) | Blocking layout | held |

> **Why both B1 and B2:** if weight is mis-attributed between two blocks the errors cancel and the grand total still matches — only the per-block check catches it. "All blocks match AND the total matches" = genuinely balanced.

## Production (production_shifts/runs/downtime/waste + electricity + trucks) — SINGLE-SOURCE, ruleset-gated auto-write

| # | Rule | Source | On violation |
|---|---|---|---|
| P1 | Grade ∈ `{3X50, 6X50, 8X50, 2X6, 4X8}` | L-027 (three-gate grade check) | MALFORMED → held |
| P2 | Upsert the parent shift `(transaction_date, production_batch, shift)` before its children | schema FK | held |
| P3 | Combine duplicate `(shift, customer, grade)` run rows before insert (sum kg + sacks) | L-026 | auto-combine, note in remarks |
| P4 ⚠️ | `dt_mins < 60` (hours carried in `dt_hrs`) | DB constraint | held / split |
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

## Open questions for Renzo (the ⚠️ rows + these)
1. **O7 / B1 negative-balance:** hard-block a feed that would drive a block negative, or flag-and-allow? (Physically impossible, but the *data* sometimes lags.)
2. **I2 lab ranges:** what are the real plausible min/max for mc/ash/bd_astm/bd_jis/grit/vm/fc?
3. **P4 dt_mins:** confirm the 60-minute cap and how an over-60 value should split.
4. Anything here that's **too strict** (would hold rows you'd want auto-written) or **too loose** (would auto-write something you'd want to see)?
