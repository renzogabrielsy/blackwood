# PC Blocking — Finished-Product (Flecon Bag) Inventory

**Status:** brainstorm / design thinking. No code, no schema, no migration. 2026-08-26.
**Question asked:** *"RC Blocking works because every delivery arrived with a location. Bagged
product doesn't. What mindset do I use to build this without an impossible backlog?"*

---

## 0. The short answer

**Stop trying to reconstruct where the bags have been. Start by stating where they are.**

You already solved this exact problem twice on the Cenapro side, and both times the answer was
the same shape: *nobody can rebuild seven months of history, so a human states the truth as of a
date, the system counts forward from there, and the old history stays visible as totals without
detail.* That is `cenapro.warehouse_opening_balance` (flec counts per warehouse) and
`cenapro.rc_supplier_opening_balance` (what we actually owe BRIX, stated, because back-entering
every historic cheque was never realistic). PC Blocking is the third instance of the same
pattern, and it is the *easiest* of the three — because unlike money, bags are physically
countable in an afternoon.

But there is a second half to the answer that I did not expect to find, and it changes the size
of the job considerably.

---

## 1. What the 6x50 file actually is (measured, not assumed)

I read `Bagged-6x50.xlsx` cell by cell. Here is what it really contains.

**Eight sheets, one per production month** — and the month naming already carries four different
conventions: `JANUARY'25 (PROD)`, `FEBRUARY'25 (PROD) (2)`, `" JUNE'25 (PROD)"` (leading space),
`AUGUST 2026`. This is the identical trap as Czarina's price tabs (L-039, `"Aug. 2026"` vs a
generated `"August 2026"`). If this file is ever synced, the tab is resolved by normalizing to
(month, year) — never by generating a name and matching it exactly.

**Every sheet is the same fixed template.** Five blocks of 44 bag rows, each block closed by a
`VAN #N / AVERAGE` row (rows 48, 95, 142, 189, 236). 220 bag slots per sheet, bag numbers
running 1…220 continuously down the sheet.

**One row = one bag, and it carries a full lab panel:**

| Col | Meaning |
|---|---|
| A | PRODUCTION DATE — **sparse, merged down a block of bags** (e.g. `A4:A18` = one date covering 15 bags) |
| B | BAG NUMBER — an ordinal, 1…220, **restarting every sheet** |
| C | Moisture content |
| D / E | Bulk density ASTM / JIS (JIS is a formula, `= ASTM + 0.02`) |
| F / G / H | Grit / Ash / Volatile matter |
| I | Fixed carbon (formula, `= 100 − (VM + Ash)`) |
| J–Q | Screen analysis — 8 sieve fractions |
| R | `SUM(K:P)` = % of the bag inside the 6X50 spec window |
| S | `SUM(J:Q)` = 100, an integrity check on the sieve split |
| T/U/V | **Unheadered free text** — `SUNDRIED`, `AYAG`, `MAGNET`, `AYAG-MAGNET`, `RESIKO`, `WEIGHT ADJUSTMENT`, `LOADED`, `Blended with #37`, and stray dates like `03.27.25` |

**What is missing, precisely:**

1. **No location of any kind.** Not a warehouse, not a block, not a zone, not a pile. Renzo is
   right — the file never says where a bag is. The nearest thing to a location is `VAN #N`,
   and a van is a *shipping container*, i.e. where the bag is **going**, not where it is **kept**.
2. **No durable bag identity.** "Bag #7" means bag 7 *of that sheet*. There is a bag #7 in
   January '25, in May '26 and in August '26. It is an ordinal within a month, not a serial number.
3. **No weight column anywhere in the file.**
4. **No production batch, no shift, no customer** — nothing that links a bag back to the
   production ledger by key.
5. **The date column is only partly filled and is sometimes typed ambiguously.** On the
   `DEC'25` and `FEBRUARY 2026` sheets the dates parse as `2025-01-12`…`2025-12-12` and
   `2026-07-02` — the operator typed day/month and Excel read month/day. `MAY 2026` and
   `AUGUST 2026` are clean.

So: **the file is a QC laboratory register, not an inventory register.** It answers "how good is
bag #7", never "where is bag #7". That is exactly the diagnosis Renzo made from memory, and it
holds up under inspection.

---

## 2. The thing I did not expect: the spine already exists in the database

Renzo's framing was *"we just know these bags exist mentally."* That turns out to be only
two-thirds true. **The count and the birth date of every bag are already in Blackwood.** Three
independent records agree, and I measured the agreement.

**Witness 1 — the QC file.** The merged date blocks in column A tell you how many bags carry
each production date.

**Witness 2 — `flecon_bag_movements`.** The empty-bag sheet already logs a row
`particular = 'BAGGED 6X50'` with a negative quantity every time bags are filled. Consuming
one empty 6x50 bag *is* the birth of one filled 6x50 bag. There are 26 such rows in 2026.

**Witness 3 — `production_runs`.** For 2026-08-24 the 6X50 run reads `sacks_bags = 15`,
`ttl_kg = 8550` (570 kg per bag).

Measured alignment:

| Date | QC file (merged block size) | `flecon_bag_movements` | `production_runs` |
|---|---|---|---|
| 2026-05-11 | 5 | −5 | — |
| 2026-05-12 | 12 | −12 | — |
| 2026-05-13 | 12 | −12 | — |
| 2026-05-14 | 9 | −9 | — |
| 2026-05-15 | 6 + 8 (split across the van boundary) = 14 | −14 | — |
| 2026-08-24 | 15 (`A4:A18`) | −15 | **15** bags / 8,550 kg |
| 2026-08-25 | 18 (`A19:A36`) | −18 | not yet reported |

**Seven for seven.** Two fully independent sources — a lab technician's clipboard and Ivy's
packaging-material sheet — already agree, to the bag, on how many product bags were born on
every day they both cover. On 2026-08-24 a third source agrees too.

Two consequences, and they are the whole reason this project is smaller than it looks:

- **The daily bag ledger does not need to be invented — it needs to be *joined*.** You already
  have "N bags of grade G were born on date D" going back to February 2026 in `flecon_bag_movements`,
  and per-bag lab results for those same days in the QC file.
- **The one and only fact that has never been recorded anywhere is *placement*.** Not the count,
  not the date, not the quality. Just the location. That is a much narrower hole than
  "we know these bags only mentally" suggests.

*(Caveat, stated honestly: `production_runs.sacks_bags` is filled on only 1 of 44 historical 6X50
runs — it is a reliable witness going forward, not backward. `flecon_bag_movements` is the
witness with actual history, and it starts 2026-02-06.)*

---

## 3. The backlog mindset — the argument, both ways

### Why RC Blocking's backfill worked, and why it cannot be repeated here

RC IN worked because **every delivery was born with a location.** The truck arrives, someone
writes `block_loc` on the same line as the weight, in the same moment, because you physically
cannot receive charcoal without putting it somewhere and the receiving document has a column for
it. Location was never a separate act. So backfilling RC Blocking was not really a backfill — it
was reading a column that had always been there.

Bagged product has the opposite geometry. **The bag is born on a production line, not at a
storage slot.** It is made, weighed, sampled, sewn shut — and only then, minutes or hours later,
carried somewhere by a forklift, by whoever is free, to whichever block has room. The paperwork
that exists (the QC sheet) is generated at the *sampling* step, which happens before placement.
There is no document in the entire chain that was ever present at the moment of placement. **The
column you would want to backfill was never blank — it never existed.**

### The case FOR backfilling anyway

Honest version, because it is not zero:

- You could reconstruct *some* placement history for recent months from memory + the van
  groupings, and for anything already shipped the question is moot.
- The QC file's `LOADED` / `VAN #N` markers do tell you which bags left, so a "produced minus
  shipped" figure is derivable, which would give you a rough count of what *should* be on the
  floor today.

### The case AGAINST, which I think wins decisively

1. **A reconstructed placement is a guess wearing the costume of a fact.** Once
   `bag #12 → block PC-B3` is a row in a table, nothing downstream can tell it apart from a
   scanned, verified placement. Every screen, every report, every future audit will treat it as
   true. This is the same failure the house has already written down three times: the
   `cost_basis = 0` unpriced placeholder read as a real ₱0 price (L-008/L-039), the audit-log
   *comment* that documented an intention and enforced nothing (the delivery latch, 2026-08-08),
   the alarm that read "nothing to report" because a read failed silently (L-044). **A wrong
   value that looks right is worse than a blank that says "unknown".**
2. **It is unfalsifiable.** If someone remembers wrong, there is no second witness anywhere in
   the system that could ever contradict them. Compare the bag *counts*, which have three
   witnesses that agree seven times out of seven. Placement has zero.
3. **The reconstruction is worth almost nothing operationally.** What does a warehouse lead
   actually do with "in March, bag #43 was probably in PC-A7"? The bag has shipped. Nobody will
   ever walk to that block. The value of a location is entirely in the present tense.
4. **It is the long pole.** Reconstructing months of placement from memory is weeks of
   interviews. A physical count of the PC area is one afternoon, and its output is *certain*.
   You would be trading a week of guessing for an afternoon of knowing, and getting the worse
   answer.

### The recommendation: a stocktake becomes the opening state

The pattern, in Renzo's own house style:

> **On day zero, walk the PC warehouse and count. Whatever you write down is true by
> definition — it is a physical observation, not a derivation. That count becomes the
> append-only opening state, one row per block. From that morning forward, the ONLY thing
> anyone logs is a movement: a bag placed, a bag moved, a bag shipped. The balance in any
> block is opening + movements. Nothing before the stocktake is ever rewritten.**

This is `rc_supplier_opening_balance` verbatim, and it should borrow its three hard-won
properties without modification:

- **Append-only, with two independent locks.** "Correcting" a stocktake means appending a new
  revision; the current value is the latest revision. No UPDATE grant to any client role, *and*
  RLS with SELECT + INSERT policies and no UPDATE/DELETE policy at all. A recount is a new
  fact, not an erasure of the old one — and you will want the trail when two counts disagree.
- **The as-of rule, stated once and never contradicted.** The opening stands for everything
  strictly before its `as_of_date`; every movement dated on or after it counts fresh on top.
  The boundary is `>=`, never `>`. (On the supplier balances this is the rule that stops a
  dateless row falling through both sides and vanishing.)
- **A later revision may carry an earlier as-of date.** Revising a stated figure downward or
  backward is the entire point.

### What this makes unanswerable — say it out loud, do not paper over it

Being explicit about the cost, because a plan that hides its cost gets rejected later:

- **You will never be able to ask "which block was bag #43 in, back in March?"** for any bag
  bagged before the stocktake. Per-block provenance simply does not exist for the pre-stocktake
  population, and no amount of clever schema will conjure it.
- **You will not be able to compute historical block turnover, dwell time, or "which blocks
  move fastest"** until you have a few months of movements. Those metrics start accruing on
  stocktake day and are meaningless before it.
- **A bag counted at stocktake has a location but no birth story** unless someone can tell you
  its production date. Its QC row exists in the spreadsheet; the link between the physical bag
  and that row may or may not be recoverable (see the tagging discussion — this is exactly what
  a physical tag fixes going forward).

### The `LEGACY` / `UNPLACED` pseudo-location — how the old bags stay countable

The pre-stocktake population must not simply disappear from the system, or the totals will lie.
Two named pseudo-locations, and their difference matters:

- **`LEGACY`** — bags known to exist historically whose block was never recorded and never will
  be. Produced-before-stocktake stock that the stocktake did not physically find (already
  shipped, already consumed). This is a *closed* bucket: nothing new ever enters it after
  stocktake day.
- **`UNPLACED`** — the live inbox. A bag that has been *born* (production reported it) but whose
  placement has not yet been entered. This is an *open* bucket that fills every day and should
  drain every day. **Its size is the health metric for the whole feature.** If `UNPLACED` grows
  without bound, the warehouse lead has stopped doing the one new thing you asked of them, and
  the screen should say so loudly rather than quietly under-reporting the floor.

Both are pseudo-locations in the same code space as real blocks, deliberately — because
**an exclusion can be forgotten by a UI, but a row cannot.** This is precisely the reasoning
behind the synthetic `is_unassigned` row in `view_rc_supplier_balance`: the receipt with no
supplier code is surfaced as a *row*, not hidden by a filter, so it can never be silently
dropped from a total. Same discipline, same reason.

---

## 4. The three structural differences from RC Blocking, and what each does to the model

Renzo named all three correctly. Each one forces a specific modelling decision, and getting any
of them wrong produces a system that fights the warehouse instead of describing it.

### (a) Placement is not born with the record → **placement is a separate EVENT**

In RC IN, `block_loc` is a *column on the delivery*. It is written at the same instant as the
weight, by the same person, on the same document. One row, one place, done.

Here, the bag is born on the production line with no location, and acquires one later — possibly
hours later, possibly the next morning, possibly (on a bad day) never. So:

> **A location cannot be a column on the bag record. It has to be its own event, with its own
> timestamp and its own author.**

Consequences that fall straight out of this:

- There is a legitimate, permanent state called **"born but not yet placed."** It is not an
  error. It is Tuesday afternoon. The system must have a first-class name for it (`UNPLACED`
  above) rather than treating an absent location as a data-quality failure.
- The gap between "born" and "placed" is a **queue with an age**, and age is the interesting
  signal. This is the same shape as the `awaiting_batch_assignment` finding from L-042, where
  MC books overnight weights early and assigns the pile later: severity escalates with age
  (`info` 0–1d → `attention` 2–3d → `high` 4+d, measured in Asia/Manila), and critically —
  *that is not called malformed input.* A bag waiting to be placed is a normal operational
  stage, and the same escalation ladder is the right treatment.
- **Nothing may block on placement.** Production reporting, QC, shipping — none of it waits for
  a location. Placement is additive information layered on top of a record that is already
  complete without it.

### (b) Blocks are MIXED → **the unit of stock is the LOT, not the block**

In RC Blocking, a block *is* a batch. `view_blocking_grid` returns one row per active batch, and
the block cell shows that batch's code, balance and lab panel, because the relationship is one to
one. That is why the RC Blocking detail panel can show a single set of lab numbers with a single
`batch_code` in its header.

Here, one block holds bags from several production days at once, and you can put more in
tomorrow. So the block is a **container**, not an identity.

> **The atomic unit of stock becomes a *placement*: N bags of one lot, sitting in one block.
> A block's contents is a LIST of placements, not a single batch.**

This has real teeth for the UI. A PC block cell cannot show "the batch code" — there isn't one.
It has to show a rollup: total bags, how many distinct lots, and a *balance-weighted* lab
average across whatever is actually in there. That weighting is the same discipline as the
Blend Proposal (`fn_blend_proposal`) and the RC Movement campaign price: **weighted by quantity,
never the plain mean of the per-lot figures.** (Measured precedent: for JULY 2026 the fed-weighted
actual price is ₱47.2747 and the naive mean of the per-block prices is ₱45.8374 — a materially
wrong number from the wrong average.)

And there is a happy consequence: the Blend Proposal feature already exists and already knows
how to answer *"if I combine the contents of these blocks, what lab panel do I get?"* For a
mixed-product warehouse, that question stops being a nice-to-have and becomes the daily one —
**"which blocks do I draw from to fill this van to spec?"** The 6x50 file already computes a
`VAN #N AVERAGE` by hand for exactly this reason. That is the same calculation, done in Excel,
after the fact.

### (c) Stock MOVES → **the location is a VIEW over a movement ledger, never a stored column**

RC blocking has no move concept at all. Charcoal arrives in a block and leaves the block by being
consumed. It does not get carried to a different block because someone needed the floor space.

Bags do. Constantly. So:

> **Never store "current block" as a mutable column. Store signed movements and derive the
> current location.** Current location is a `view`, computed the way `view_flecon_bag_balance`
> computes bag stock and the way `view_blocking_grid` computes balance — from the transactions,
> not from a cache.

The precedent here is unusually strong and worth citing to anyone who pushes back, because the
project has already been burned by exactly the alternative. `view_blocking_grid.balance` was
deliberately rewritten (migration `20260531041520`) to compute from the transaction tables
rather than read the `batches.current_weight` cache — because an ingestion path had double-counted
into the cache and rendered ~54 tonnes of phantom inventory (AF-001 / L-005). A mutable
"where is it now" column is that same bug waiting for a forklift.

Movements should be **signed and typed**, like `flecon_bag_movements.qty_delta`:

- `place` — from `UNPLACED` into a block (the birth-side event)
- `transfer` — block → block (this is the one RC Blocking has no analogue for, and it must be
  a single event naming *both* ends, not a delete plus an insert; a transfer that can be
  half-applied is a bug)
- `ship` — block → van / out (the terminal event; the QC file's `LOADED` marker)
- `adjust` — the recount. Not an error. It is `ACTUAL COUNTING …` in the flecon vocabulary and
  it happens in every real warehouse.

Two rules that will save pain later:

- **Absence is never deletion.** `fn_apply_schedule_upstream` has no DELETE at all, for exactly
  this reason. A block the day's report doesn't mention is untouched, not emptied.
- **A movement is never edited, only counter-moved or superseded.** Same append-only instinct as
  the audit trails — because "where was this bag last Tuesday" is a question someone will ask
  during a dispute, and it must have an answer.

---

## 5. Tagging at the source, going forward

The stocktake fixes yesterday. This section is about making sure you never need another one.
The question is: at what moment, by whom, on what device, does a location get recorded?

I looked at how ICTC actually reports today before proposing anything, because a channel the
plant will not use is worth nothing. Today's reality: **cumulative emailed workbooks, filled in
by MC and Ivy, arriving daily, ingested by the worker on a PROPOSE/EXECUTE cycle, with a
human-edit latch so an in-app correction is never reverted.** Nobody at the plant currently types
anything into Blackwood.

### Option A — add a BLOCK column to the daily production report

Ask MC to add one column to the workbook that already arrives every morning.

- **For:** zero new tools, zero new habits, rides the existing sync end to end, and the
  human-edit latch (`fn_stamp_human_edit`) already protects any correction made in-app.
- **Against, and it is fatal:** *the workbook is filled in at the end of the shift, and placement
  happens after that.* You would be asking someone to write down a location they have not
  chosen yet. In practice the column gets filled with whatever block was used most, or copied
  down from the row above — which produces **confident, wrong, unfalsifiable data**, the exact
  failure mode section 3 rejected the backfill for. Worse, it fails silently: nothing in the
  system can tell a real block from a copied-down one.
- **Also against:** it cannot express a transfer at all. A workbook column says where a bag
  started, never where it moved to, so within a week the recorded location is stale and the
  system is lying.

**Verdict: no.** This looks like the cheapest option and is actually the most expensive, because
it produces data you cannot trust and cannot audit.

### Option B — an in-app placement queue the warehouse lead clears from their phone

The screen shows the `UNPLACED` list: *"15 bags, 6X50, produced 24 Aug — where did these go?"*
The lead taps a block on the same PC grid everyone else reads, enters a count, done. Split across
two blocks if that is what happened.

- **For:** it records the location **at the moment the location is decided, by the person who
  decided it.** That is the only moment the fact exists, and this is the only option that
  captures it. It handles transfers natively (same screen, different verb). It handles splits.
  It produces a real author and a real timestamp on every event, which makes the whole thing
  auditable. And it fits the phone: the project already has a mobile card layer for exactly
  this kind of surface (`MobileCardList`, Archetype C — Daily, Electricity and the schedule all
  have one).
- **Against:** it is a genuinely new habit for someone at the plant, and it is the first time
  Blackwood asks a plant employee to *type* rather than to email a workbook. That is real
  organisational cost and should not be waved away.
- **Mitigation:** the ask is about 20 seconds a day, once a day, and — crucially — **the queue
  makes its own neglect visible.** If nobody clears it, `UNPLACED` grows and the screen says so.
  Compare option A, where neglect looks identical to compliance.

**Verdict: this is the recommendation.** Primary path.

### Option C — physical tags / QR on each bag

A printed serial on every bag; scan on place, scan on move, scan on ship.

- **For:** it is the only option that gives a bag a **durable identity**, which is what would let
  you answer "show me this specific bag's whole life" and would close the gap that today's
  per-sheet ordinal bag numbers leave open. It is where a mature version of this ends up.
- **Against:** hardware, printing, consumables, training, and a hard dependency on the tag
  surviving a dusty warehouse and a forklift. It is a project of its own.
- **And it is not needed yet** — see section 6. Per-bag identity is not required for the
  traceability Renzo actually described.

**Verdict: phase 3+, and only if per-bag questions start being asked. Do not gate anything on it.**

### Recommended primary path

**Option B, with an explicit door left open for C.**

One extra rule, borrowed straight from the delivery latch: **the placement queue must not be the
only writer.** Anyone who needs to correct a placement should be able to, in-app, and that
correction must claim the row so no future automated source can revert it. The pattern is already
built and already proven — `fn_stamp_human_edit` + a `human_edited_at IS NULL` guard *inside the
UPDATE's own WHERE*. The 2026-08-08 lesson is worth restating because this is a new module and it
would be easy to repeat: an instruction written as a comment in a table is prose that nothing
reads at write time. **The only form an operational rule can take and be obeyed is a predicate
in a WHERE clause.**

---

## 6. The traceability click-through — what "click a PC block, see QC stats" actually requires

The target experience, in Renzo's words, is RC Blocking's detail panel but for product. Worth
being precise about the minimum linkage, because it decides how much identity you need.

### The chain

    a physical bag
      belongs to a LOT           (grade + production date, e.g. "6X50, 2026-08-24")
        the lot has a QC panel   (the 6x50 file's rows for that date: MC / BD / ash / VM / FC /
                                  grit, plus the 8-fraction screen analysis)
        the lot has a birth      (production_runs: grade, ttl_kg, sacks_bags for that shift)
        the lot has a source     (production_shifts → production_batch → and via RC Movement,
                                  which raw-charcoal blocks fed that campaign)
      currently sits in a BLOCK  (opening + movements)

**The minimum viable lot identity is `(grade, production_date)`** — probably narrowed to
`(grade, production_date, shift)` if a day ever runs two shifts producing the same grade with
materially different quality. It is emphatically **not per-bag.**

That is the single most important scoping call in this document, so here is why it holds:

- The QC file records a lab panel **per bag**, but the bags of one date are made from the same
  feedstock on the same line within hours, and are already averaged together by the operator's
  own `VAN #N AVERAGE` row. The plant already reasons at lot granularity.
- `(grade, production_date)` is a key the system can **already produce from three independent
  sources** (section 2), and their counts agree seven times out of seven. A per-bag key can be
  produced by nothing — the sheet's bag number resets monthly and is not written on the bag.
- Everything Renzo described wanting — *"click a block, show QC stats and traceability"* — is
  answerable at lot granularity. "This block holds 40 bags: 22 from 24 Aug at 12.3% MC, 18 from
  25 Aug at 11.8%, blended average 12.1%" is the useful answer. "Bag #7 specifically is at
  12.27%" is not a question anyone in a warehouse asks.

**Design the lot key so a per-bag identity can be added later without a rewrite** — a placement
references a lot and a count; if bags ever get serials, a serial simply becomes an optional
child of the lot. Nothing above it changes.

### What the block detail panel would then show

Mirroring `BlockingDetailPanel` band for band, because the muscle memory is worth preserving:

- **Header** — block code, total bags, total kg (bags × the lot's per-bag weight, ~570 kg for
  6x50), how many distinct lots.
- **Lab strip** — the same 7-cell row RC Blocking uses, but **quantity-weighted across the lots
  actually in the block**, plus the screen-analysis figure (`% within 6X50 spec`) which is the
  number this product is actually sold on and has no RC-side equivalent.
- **Contents** — one row per lot: production date, grade, bags, that lot's own lab panel.
  Directly analogous to the delivery-history table.
- **Movement history** — placed / transferred in / transferred out / shipped, with dates and
  authors. Directly analogous to the usage-history table.
- **Traceability drill** — from a lot, jump to the production shift; from the shift, to the
  production batch; from the batch, to RC Movement's campaign view and therefore to which raw
  charcoal blocks fed it. **This link already exists end to end** —
  `view_rc_movement_campaign_production` and friends already tie a campaign to what it produced.
  Product traceability is the missing half of a chain whose other half is already built.

**One thing to get right at the server-action layer from day one:** if any ₱ ever reaches this
surface (a per-bag cost derived from the campaign's actual fed ₱/kg is the obvious temptation —
and `view_rc_movement_campaign_actual_price` exists and would make it easy), it is gated by
`canViewPrices()` and **nulled before the payload leaves the server**, never hidden client-side.
Today the product side carries no ₱ at all, which is the easiest possible starting position —
keep it that way for as long as you can.

---

## 7. Rollout — deliberately small first

The governing instinct: **Phase 1 should be shippable and useful before anything touches the
sync, the production report, or the QC file.** Every phase after it is optional and independently
valuable.

### Phase 1 — the floor, as it is today (the whole of the initial build)

1. **Block layout dimension.** One row per physical PC slot. A dimension, not an enum — the same
   reasoning as `cenapro.rc_bank` ("data, never an enum") and `production_setups` ("free text, no
   FK, so retiring one can never invalidate history"). Renzo will want to add, rename and retire
   slots without a migration.
2. **Stocktake → append-only opening state.** One revision per block per count, latest revision
   wins, resolved once in a view so nothing re-derives it. Two locks (no UPDATE/DELETE grant,
   RLS with no UPDATE/DELETE policy).
3. **The movement ledger.** Signed, typed, append-only. `place` / `transfer` / `ship` / `adjust`.
4. **Current contents as a VIEW.** `opening + movements`, per block, per lot. Never a stored
   column. Weighted lab rollup computed in SQL — *"never calculate weighted averages or inventory
   balances in TypeScript."*
5. **A read-only PC grid**, visually a sibling of RC Blocking, with the detail panel.
6. **`LEGACY` and `UNPLACED` as first-class pseudo-blocks**, surfaced as rows.

Deliberately **not** in Phase 1: any sync ingestion, any change to MC's or Ivy's workbooks, any
per-bag identity, any ₱.

### Phase 2 — the placement queue (the habit)

The `UNPLACED` inbox, phone-first, with the age-escalating nudge (L-042's ladder). Transfers and
shipments from the same surface. This is where the system stops being a snapshot and starts being
a live ledger.

### Phase 3 — lot enrichment from the sources you already have

Join `flecon_bag_movements` (`BAGGED <grade>` rows) and `production_runs` to auto-create lots, so
"born" arrives without anyone typing it and the queue populates itself. Then — and only then —
consider ingesting the 6x50 QC file for the lab panel, with the tab-name normalization from rule 1
of the price-enrichment spec and the day/month date ambiguity handled explicitly rather than
guessed. **A disagreement between the QC file's bag count and the flecon count is held for a
human, never auto-resolved** — they agree seven for seven today, which makes a future disagreement
genuinely informative and worth stopping on.

### Phase 4+ — per-bag identity, if the questions demand it

Tags/QR. Only if someone actually starts asking per-bag questions.

### What gets reused rather than rebuilt

| Existing piece | Reused for |
|---|---|
| Blocking grid UI idioms — CSS-grid cells, spotlight filter, `.blocking-grid-cols` (`minmax(104px,1fr)`, never `minmax(0,1fr)`), frozen row labels on mobile | The PC grid |
| `BlockingDetailPanel`'s shape, and its already-proven shell-agnostic prop contract (`blockData` supplied directly, host owns navigation) | The PC detail panel — it was *already* generalised once so RC Movement could reuse it |
| Blend Proposal + `fn_blend_proposal` | "Which blocks fill this van to spec" — the operator's `VAN #N AVERAGE`, done properly |
| Append-only opening idiom (`rc_supplier_opening_balance`, `warehouse_opening_balance`) | The stocktake |
| Signed-movement idiom (`flecon_bag_movements`) | The placement ledger |
| Blackwood Table + `PeriodPicker` | Any list/ledger view of movements |
| `fn_stamp_human_edit` + `human_edited_at IS NULL` in the UPDATE's own WHERE | Protecting hand corrections from any future sync |
| Trigger-written append-only audit (`rc_delivery_audit` / `rc_payment_audit` idiom) | The movement trail |
| Archetype C `MobileCardList` | The phone placement queue |

---

## 8. Open questions — only Renzo can answer these

**Layout and naming**
1. What is the physical PC-area layout? RC Blocking is 4 warehouses × 20 columns × up to 4 rows.
   Is the product area a grid, a set of named bays, numbered lanes, something else?
2. Is `PCA` / `PCB` (the existing prepared-charcoal sundrying subdivisions of A-15/16/17) the same
   physical space as this product warehouse, or a different building entirely? This matters — if
   they overlap, the two grids must not both claim the same floor.
3. Does a block have a **capacity** (max bags)? RC Blocking shows utilisation against
   `total_in`; the product equivalent needs a stated ceiling or there is no utilisation to show.

**Stocktake**
4. Who does the count, and how long does it take? One shift, or spread over days? (If spread,
   the as-of date needs care — a bag counted Monday and moved Tuesday must not be double-counted.)
5. Is it feasible to record, per block, not just *how many bags* but *which production dates* they
   came from — even approximately? This is the single highest-value question in the list.
   If the answer is yes, every pre-stocktake bag gets a lot and therefore a QC panel, and the
   `LEGACY` bucket shrinks to almost nothing. If no, the opening state is bag counts only and lab
   data starts accruing from stocktake day forward. **Both are fine — but the answer changes the
   opening-state design, so it needs deciding before anything is built.**

**Operations**
6. Who assigns placements day to day — one warehouse lead, or whoever is on shift? Does that
   person have a phone on the floor and would they use it?
7. How often does a block-to-block transfer actually happen — daily, weekly, rarely? If it is
   rare, the movement ledger can be simple; if it is constant, the transfer UI is the main screen
   rather than a secondary one.

**Scope**
8. **Is 6x50 the pilot, or all grades at once?** The evidence says 6x50 is the cleanest starting
   point (the QC file exists, the bag counts reconcile three ways, ~15 bags/day is a
   comprehensible volume). But 3X50 is by far the bigger stream — 242 production runs vs 44 for
   6X50 — so a 6x50-only pilot covers a small share of the actual floor. Pilot for correctness,
   or launch for coverage?
9. **Is bag count the unit, or does weight matter?** 6x50 looks like a fixed ~570 kg/bag
   (8,550 kg ÷ 15). If every bag of a grade is effectively identical, bag count is the unit and
   kg is derived — much simpler. If partial bags, re-bags, or weight adjustments are real (the
   QC file's `WEIGHT ADJUSTMENT` tag suggests they might be), weight has to be tracked per
   placement.
10. What do the `T`/`U`/`V` free-text tags mean operationally — `AYAG`, `MAGNET`, `RESIKO`,
    `WEIGHT ADJUSTMENT`, `LOADED`, `Blended with #37`? Some are clearly post-processing steps
    and at least one (`LOADED`) is a shipment event. If any of them are inventory-relevant, they
    belong in the movement vocabulary rather than as an unheadered note column.
11. Do bags get **blended or re-bagged** after production? `Blended with #37` appears on the
    FEBRUARY 2026 sheet. If a bag can be split or merged, the lot model needs a merge/split
    event, and that is much cheaper to design in now than to retrofit.

---

## 9. One-paragraph summary for the top of the next conversation

The 6x50 file is a **QC laboratory register**, not an inventory register: one row per bag with a
full lab panel and screen analysis, grouped into shipping vans, with **no location field of any
kind and no durable bag identity** (bag numbers are a per-sheet ordinal that restarts monthly).
But the *counts* are not missing — `flecon_bag_movements` (`BAGGED 6X50`) and, going forward,
`production_runs.sacks_bags` already record how many bags were born each day, and they agree with
the QC file's own date blocks **seven times out of seven** on measured data. So the only fact that
has never been recorded anywhere is **placement**. Do not backfill it: a remembered location is an
unfalsifiable guess that every downstream screen would treat as fact, and the house has already
written down three separate incidents of a plausible-looking wrong value doing more damage than a
blank. Instead, do what Cenapro did twice — **count the warehouse once, make that count the
append-only opening state, and log only movements from that day forward** — keeping the old
population countable under a `LEGACY` pseudo-location and the daily "born but not yet placed"
backlog visible under `UNPLACED`. Model placement as an **event** (it is not born with the bag),
make the unit of stock a **lot placement** rather than a block (blocks are mixed), and derive
current location from a **signed movement ledger** rather than storing it (bags move, and a
mutable "where is it now" column is the phantom-inventory bug with a forklift attached).
