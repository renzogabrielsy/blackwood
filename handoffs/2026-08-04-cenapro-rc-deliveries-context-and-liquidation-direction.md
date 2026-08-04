# 2026-08-04 — Cenapro RC Deliveries: what landed, what it does, where it goes next

> **Companion handoff.** The same calendar day also shipped the ICTC sync-correction fix,
> the batch-trigger repair and the QC spreadsheet entry rows — see
> `2026-08-04-sync-corrections-batch-trigger-and-qc-spreadsheet-entry.md`. That work was a
> different session running concurrently in this repo. **This file is about RC Deliveries**
> and is the one to read if you are picking up Cenapro.

---

## TL;DR

Cenapro got its **raw-charcoal receipt ledger** — the Cebu analogue of ICTC's RC IN. Three
commits took it from nothing to a live, fully-verified screen: a formula parser, then the
schema + import + money model, then the grid.

**991 receipts and 244 moisture sub-samples are loaded and reconciled to the centavo against
the source workbook.** ₱743,850,724 across 17,867,328 net kg, 2026-01-02 → 2026-08-04.

**Cenapro carried no money at all before this.** `cenapro.rc_delivery` is the tenant's first
money table, which is why price gating now applies to Cenapro for the first time.

**The feature this exists to support is LIQUIDATION — assigning cheques and payments to
receipts. None of it is built.** There is no cheque table, no payment table, no allocation
model. Everything below is the foundation it will sit on.

---

## What shipped

| Commit | What |
|---|---|
| `cf32462` | `lib/cenapro/rc-formula.ts` — the formula-cell parser + `scripts/verify-rc-formula.ts` |
| `c761ad0` | Schema, importer, money model, read model, write RPCs |
| `12fb533` | `/cenapro/deliveries` — the ledger screen |

All on `main`. Route is wired into the navbar breadcrumb, the nav list and the Cenapro
landing page. `npm run build` exit 0.

---

## The schema — a deliberately SEPARATE island

`rc_`-prefixed, and it **shares zero dimensions with production**. A raw-charcoal yard and a
finished-goods FLEC warehouse are different places with different code spaces, so **never FK
an `rc_*` table to `warehouse` / `source_location` / `plant`.**

| Object | Rows | Role |
|---|---|---|
| `cenapro.rc_supplier` | 12 | The **cheque-payee** dimension. Exists so a trader can be split or re-pointed (PALAWAN → RANDY / BROOKE'S) without a migration. |
| `cenapro.rc_destination` | 16 | Yards. `warehouse` \| `plant_feed` \| `dryer`, with `has_sides`. |
| `cenapro.rc_delivery` | 991 | One truck receipt, in the workbook's own column order. |
| `cenapro.rc_delivery_sample` | 244 | 1–6 moisture sub-samples per receipt, CASCADE child. |

**Read model:** `public.cenapro_rc_delivery_rows` (over `cenapro.view_rc_delivery`) — joined
to names, carrying `sample_count`, `sample_avg_moisture_pct` and the data-quality flags.
**Write path:** `cenapro_save_rc_delivery` / `cenapro_save_rc_delivery_samples` /
`cenapro_delete_rc_delivery`, all compare-and-set on `row_version`, all `authenticated` +
`service_role`, `anon` revoked.

### The money model — decomposed and DB-computed

`net_weight_kg`, `price_php_kg` and `total_price_php` are **STORED GENERATED** over
`gross_weight_kg` / `deduction_pct` / `base_price_php_kg` / `price_adjustment_php_kg`.
Unwritable by anyone, exact decimal, never rounded.

- `total_price_php` **repeats the full arithmetic over the base columns** because a generated
  column may not reference another; `cenapro_rc_delivery_total_consistent` CHECKs the two
  forms agree.
- `COALESCE(…,0)` on both factors, so a receipt with no weight or no price reads **₱0
  payable, not NULL** — which is what the workbook says and what a SUM needs.
- Chosen over a view column because **liquidation will SUM and index the payable total**, and
  a STORED generated column is the only form that is *impossible* to overwrite.

### The second witness

`sheet_total_php` holds what the workbook itself printed in TTL PRICE — **an independent
witness, never used in a calculation**. `sheet_total_matches` exposes the agreement as a
COLUMN on the read model (PostgREST cannot filter one column against another, so without it
every consumer would pull 991 rows and redo decimal arithmetic in JavaScript).

**All 991 rows agree today — 0 mismatches.** The point is to notice the day they stop.

---

## The screen (`/cenapro/deliveries`)

Built to the QC Ledger's interaction standard on the Blackwood Table primitives. Its own
`app/(app)/cenapro/deliveries/CONTEXT.md` is thorough — read it before touching the grid.
The parts worth knowing up front:

- **17 columns in the sheet's own order**, explicit pixel widths, frozen
  `# · DATE · TRK# · SUPPLIER`, horizontal scroll ("never crush, always scroll").
- **SUPPLIER and WAREHOUSE are ONE Excel cell over several DB fields.** Solved with a single
  canonical parse/format pair in `types.ts`, used by both inline edit and paste, so the split
  cannot be expressed twice and drift. **A value that does not resolve is REFUSED** — at
  commit and again at save. (The *import* was allowed to leave them NULL because it was
  transcribing a workbook nobody can go back and ask about; a human typing today can be asked.)
- **WT and PHP/KG are FORMULA cells.** On focus you see `=27045*88%`; on blur, the value.
  Recursive-descent parser, **no `eval`**. For imported rows with no stored formula the
  formula is REBUILT from the stored parts, so an imported row and one typed this morning are
  indistinguishable.
- **TTL PRICE is never computed in the browser.** While a row is dirty it shows the STALE
  stored figure, italic and dimmed, with a title saying so. Reproducing exact decimal money in
  floating-point JS is precisely how a payment ledger goes wrong.
- **Its own per-cell `NavResolver`** — sample sub-rows occupy different columns from receipts,
  which `createCoordinateNavResolver`'s per-COLUMN map cannot express. ArrowDown in the WT lane
  walks receipt-to-receipt; in the MOIST lane it walks through every draw.
- **Two scopes:** `endless` (virtuoso keyset pager, NULL dates handled explicitly in both
  directions) and `focus` (month, day-grouped, `Σ DAY TOTAL`, sticky month footer).
- **Price gating** — seven money fields, `stripPrices()` server-side before the payload
  returns, and when gated `buildColumns()` **omits** the ₱ columns entirely rather than
  blanking them, so the keyboard space has no unreachable holes. A gated viewer's patch
  carrying a ₱ key is refused per receipt, never silently dropped.

**Verification:** `scripts/verify-rc-formula.ts` (22 assertions) +
`scripts/verify-rc-deliveries-cells.ts` (20 assertions, ending in a replay over all 991 real
receipts). **Both green as of this handoff — re-run them after any change to the cell pairs
or the column geometry.**

---

## Data-quality state — flagged, never fixed

The import deliberately kept bad rows visible. Each is a shareable URL lens (`?issue=…`).

| State | Count | Notes |
|---|---|---|
| `is_suspected_duplicate` | **22** | **₱17,185,939 across THREE consecutive days**, not one — Apr 6 (9 rows, ₱6.94M), Apr 7 (7 rows, ₱5.32M), Apr 8 (6 rows, ₱4.93M). |
| `has_import_flags` | 34 | Popover with each flag's `kind` / `detail` / original `raw`. |
| `destination_unresolved` | 5 | Amber rail + `MAP?`; a save is refused until resolved. |
| `supplier_unresolved` | 1 | Same treatment. |
| unparseable date | 0 undated rows | `delivery_date_raw` retained where the sheet was odd. |

> ⚠️ **The module's own CONTEXT.md says the duplicates are "the 2026-04-06 block, roughly ₱7M".
> That is only the largest of three.** The real exposure is ₱17.2M over Apr 6–8. Day totals and
> the month footer already carry an explicit "includes … from suspected duplicates" line, so
> nothing is silently double-counted — but **the human decision has not been made.**

---

## ⚠️ The single most important state fact

**All 991 rows are `provenance = 'sheet_import'`. Not one row has been created or edited in
the app.**

The entire write path — inline editing, the formula round-trip on commit, the batch save, the
version-conflict handling, the sample block replace, delete — is **type-checked, lint-clean,
verified by 42 framework-free assertions, and has never been exercised by a real user.** The
verify scripts replay stored data through the pure functions; they do not drive the RPCs.

Treat the first real editing session as the actual test.

---

## Next concrete actions

1. **Renzo drives the grid on real work** — edit a weight formula, resolve one of the 5
   unmapped destinations, add a moisture draw, save. This is the first exercise of the write
   path. Watch for `version_conflict` handling and the sequenced field-then-samples save.
2. **Decide the 22 suspected duplicates.** ₱17.2M over Apr 6–8. They are visible and
   annotated but still counted in every total. This is a human arbitration, exactly like the
   ICTC settlement decisions — do not let an agent resolve it.
3. **Resolve the 6 unmapped rows** (5 destinations, 1 supplier). Until then those receipts
   cannot be saved from the app at all.
4. **LIQUIDATION — the actual goal, entirely unbuilt.** Nothing exists yet: no cheque table,
   no payment table, no allocation model. The foundation deliberately laid for it:
   `rc_supplier` is the *cheque-payee* dimension (re-pointable without a migration),
   `total_price_php` is a STORED generated column precisely so it can be SUMmed and indexed,
   and the money is decomposed rather than opaque. Design starts here.
5. **Fix two stale lines in `app/(app)/cenapro/CONTEXT.md`** — line 10 still ends "the grid is
   not built" and line 242 still says "DATA LAYER ONLY — no route yet". Both predate `12fb533`.
   Small, but they are the first thing a new agent reads.

---

## Traps worth carrying forward

1. **Never FK an `rc_*` table to a production dimension.** The two islands share a tenant, not
   a code space.
2. **Never compute money in TypeScript here.** Three generated columns and a CHECK exist to
   make that unnecessary; the stale-italic TTL PRICE is the deliberate cost of honouring it.
3. **`cenapro.rc_delivery` is a money table.** Older notes in the Cenapro CONTEXT saying
   "Cenapro has nothing to gate" are now true only of the production and flec screens.
4. **The import's tolerance is not the app's tolerance.** Imported rows may carry NULL
   supplier/destination; app writes may not. Do not "helpfully" relax the write-side refusal
   to match the import.
5. **Two sessions in one repo will collide.** This day's concurrent sessions crossed twice —
   once sweeping in-flight files onto `main` via `git add .`, once with both editing
   `app/(app)/cenapro/CONTEXT.md`. If another session may be active, stage paths explicitly
   and check `git status` before committing.
