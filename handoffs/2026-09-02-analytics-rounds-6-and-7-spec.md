# 2026-09-02 — Analytics rounds 5-6 shipped, L-047 fed/sundry fix, and the ROUND 7 SPEC (not built)

> Continues `2026-09-01-analytics-program.md`. This session shipped owner-feedback rounds 5 and 6
> on `/analytics`, caught and fixed a correctness bug in every "fed" view (L-047), cleaned two
> duplicate feedings, and ends with Renzo's **round-7 list, which the NEXT session must build.**

## TL;DR for the next session
1. Read §"ROUND 7 SPEC" below and build it — one frontend pass (plus one small backend view
   change for the merged production table if needed). Everything is on `main` @ `faf7baf`.
2. Renzo answered the "why do RC OUT and Charcoal fed differ" question himself in the spec: the
   RC OUT row is yard outflow (all destinations) on the calendar; Charcoal fed is MAIN-only on
   the batch clock — measured Jan-Apr 2026 sundry 42.6/167.1/223.9/119.1t; May-Aug residuals
   are batch-vs-month alignment only. His fix = split the rows by MEANING (see spec item 1).

## Shipped this session (all on main, Vercel deployed; no worker changes)
- **Round 5** (`df0cf6a`): row dividers; drag/keyboard row reorder per section (localStorage);
  per-group consolidated landscape print; callouts strip + supplier prose REMOVED; grade
  expands; campaign checklist (`?bhide=`, chronological by batch NAME); Production + grades
  moved under the campaign panel; the panel's filter drove the production months.
- **L-047 fed ≠ sundry** (`39530d5`, migration `20260902071050`): 15 views re-pointed under the
  three-clock doctrine (FED = MAIN only · OUT = all · BALANCE = deliveries − OUT); every one of
  the 552,629 sundry kg accounted for; balances byte-identical (715 batches, 0.00 gap); three
  campaigns' yields corrected ~15 points (JAN 65.6→82.2%, MAR 69.8→84.5%, APR 71.6→83.5%);
  `actual_fed_php_kg` NULL-not-wrong on sundry-touched blocks. CLAUDE.md carries the doctrine.
- **Duplicate feedings cleaned** (DB only, audited with full snapshots in `audit_logs`; no code):
  two same-feeding-twice rows deleted — **Jan-27 `JAN-26-BLK8` 7,000 CLOSED** and **Feb-12
  `FEB-26-FEED3` 17,540** (the Feb-13-sync copies). NOTE THE DETOUR: the first deletion targeted
  the May-26 backfill copies instead; balance arithmetic proved those were the legitimate
  close-outs of real FEED truckloads (FEED8 17,020 = 10,020 + 7,000; FEED4 delivery exactly
  17,540), so they were RESTORED from their audit snapshots and the Feb-sync twins removed.
  Result: JANUARY campaign fed = **829,328 kg = Renzo's RC MONTHLY workbook to the kilo**;
  Jan-27 = 37,331, Feb-12 = 39,127; FEED8/FEED4/FEED3 balances 0/0/0; BLK8 +1,705 (was an
  impossible −5,295). **Lesson: when two rows claim one feeding, the pile balances decide which
  is real — a pile cannot feed what it never received.** Mar-24 `NOV-25-BLK16` 3,754 CLOSED has
  no twin and was left (Renzo's workbook just doesn't record it).
- **Round 6** (`faf7baf`, migration `20260902083625`): Production band + grade table on the
  BATCH clock via `view_analytics_production_by_batch` / `_grade_by_batch` (yield SELECTed from
  `view_rc_movement_campaign_yield` — byte-equal to the panel, verified on screen; changeover
  day kWh → incoming batch, half-open-span partition; 561,930 pre-campaign kWh disclosed);
  `?bhide=` drives panel + band + grades; **unit-on-left accounting cells everywhere** (₱/kg,
  T, %, h, kWh, d, sacks) via `unit-value.tsx`; R5's calendar projection helper deleted. The
  original UI agent stalled mid-verification; a second agent took ownership, verified all
  items, fixed docs, deleted the harness.

## Standing items (unchanged, Renzo to rule)
March 2026 mis-keyed meter reading (chip) · MC's August 22 reason-only zero-hour downtime
shifts · `open_value_php` follow-up · Aug-12 "FEED" remark panel click · graveyard deletion.

---

## ROUND 7 SPEC — Renzo, 2026-09-02, verbatim intent (BUILD THIS NEXT)

1. **RC Inventory table: remove "RC IN total" and "RC OUT total" rows.** Replace with
   **Purchase volume** (market deliveries only — already the existing row) and, directly
   BELOW it, **Usage** (= charcoal fed, MAIN destination only, calendar month —
   `view_analytics_cost_monthly.fed_kg` or the MAIN-only monthly fed the L-047 views expose).
   Renzo: "rc in and out currently encompasses everything regardless of destination. I much
   prefer if we specify it to just purchase volume and usage volume."
2. **Net flow row stays yard-flow** (all deliveries − all rc_out, `view_analytics_flow_monthly`)
   — NOT purchase − usage. Its EXPAND must show the **RC IN and RC OUT (all destinations)
   series** as the two lines beside the net bars — that is where the removed totals live now.
   Renzo: "It makes much more sense there to show the actual overall net flow by basing off of
   the rc in and out data."
3. **Remove from the campaign panel** (redundant with the merged production table): Produced,
   Yield, ₱ per produced kg (block-price basis), ₱ per produced kg (TRUE basis) — i.e. the
   rows in his third screenshot.
4. **Remove from RC Inventory**: Avg stock age and Stock over 120 days (fourth screenshot) —
   Renzo doesn't need them. (Keep the aging view/data; just drop the rows.)
5. **MERGE "By production batch" and the Production table into ONE campaign-column table.**
   Renzo: "It doesn't make sense for it to be separated and have redundant metrics… better to
   reference all of that in one table." Proposed row order for the merged table (campaign
   columns, `?bhide=` checklist, group print, dividers, reorder): Charcoal fed (T) · Block
   price (₱/kg) · True ₱/kg fed · Cost of storage time · Weight lost % · Blocks closed ·
   Produced (T) · Output per reported day · Yield % · Process loss % · ₱ per produced kg
   (block-price basis) · ₱ per produced kg (TRUE basis) · Downtime (h) · Power (kWh) · Power
   intensity (kWh/kg) · Bags counted — then the grade mix mini-table beneath. The
   "BLOCKS CLOSED / PRICED" footer line stays as the coverage footer. One dictionary per row.
   Data: `view_analytics_batch_cost` + `view_analytics_production_by_batch` already join on the
   same campaign spine (both UNION options+yield) — the merge is a frontend fold, no new SQL
   expected (verify `fed_kg` agrees between the two views: it does, 0/32 mismatches).
   Item 6 ("add charcoal fed to the production table") is subsumed by the merge.
6. Section order after the merge: RC Inventory matrix → the merged Campaign table (+ grade
   mix) → Suppliers. Nav anchors + CONTEXT + plan doc (§13) updated. Keep every established
   convention: unit-on-left cells, MoM primary + YoY/Δ chip toggle, smart year defaults,
   in-place expands with Print, definitions master switch, big-screen scale, print landscape.

Gates as always: tsc · lint ≤146/16 · build · verify-table-core 84 · e2e 57 · browser
harness (then delete) at 1512/2560/375 both themes · CONTEXT + plan doc updated.
