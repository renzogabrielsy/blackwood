# RC OUT Ingestion — Design Doc

## Two emails, two roles

The user (Renzo) maintains two parallel daily emails for raw charcoal consumption:

| Email | Source of truth for | Sheet structure | Granularity |
|---|---|---|---|
| **PROPOSED DAILY REPORT** | `rc_out` table writes | One sheet per day (e.g., `MAY 26`) | Per-block per-day |
| **RAW CHARCOAL MOVEMENT** | **Reconciliation only** — never writes | One sheet per month (e.g., `MAY 2026`) | Per-day daily aggregate |

The PROPOSED file is the **canonical** source. RC MOVEMENT is the **audit cross-check** — its daily totals should equal the sum of PROPOSED's block sections for that day, and any drift signals a problem.

## File: PROPOSED DAILY REPORT MAY 2026.xlsx

### Sheet structure

- Workbook has one sheet per day's report (e.g., `MAY 4`, `MAY 5`, ..., `MAY 26`)
- Each sheet = one day's feeding plan, organized into **block sections** (one section per actively-fed block)
- Each block section is ~6 rows of data + right-side stats columns

### Block section anatomy

A block section spans ~7 rows. Example (D-12B on MAY 26):

| Row | Col A | Col B (label value) | Col B-K pallets | Col L | Col M |
|---|---|---|---|---|---|
| R6 | `WHSE #` | `D-12B` (block_loc) | — | `STRT. BAL` | 14642 |
| R7 | `BLOCK DATE` | `2026-02-01` (when batch created) | — | `DAY TOTAL` | 8823 |
| R8 | `BLOCK NO.` | `# 2` (batch number) | — | `END BAL.` | 5819 |
| R9 | `Gross weight` | — | 1445, 1569, 1261, ... (per pallet) | `REMARKS` | `DONE` |
| R10 | `Pallet` | — | 123, 165, 121, ... (sack count) | — | — |
| R11 | `Net` | — | 1322, 1404, 1140, ... (per pallet net) | — | — |

Right-side columns also have:
- `STATUS` (col M, row of `WHSE #`): e.g., `DONE FEEDING`, `FOR FEEDING`, or empty
- `SUPPLIER` (col M, row of `BLOCK NO.`): e.g., `Llanto,Lacoto & Tanilon`

Each section is followed by a blank row before the next section begins.

### Section types observed

| WHSE # value | Section type | batch_code derivation |
|---|---|---|
| `D-12B`, `C-10A`, `A-11B`, `D-12A`, etc. | Standard block | `{PREFIX}-{YY}-BLK{N}` from BLOCK DATE + BLOCK NO. |
| `FEEDING AREA` | FEED batch | `{PREFIX}-{YY}-FEED{N}` from BLOCK DATE + BLOCK NO. |
| (potentially `SUNDRY...` or `TNK...`) | Sundry / tank batch | Unknown until observed; flag as unmapped |

Footer rows (e.g., "3X50 = NONE / RC = NONE") are noise; skip them.

### Batch_code resolution

The DB has **inconsistent month-prefix conventions** historically (full names for some months, 3-letter abbreviations for others). The verified 2026 conventions:

| Month | Prefix |
|---|---|
| January | JAN |
| February | FEB |
| March | MARCH |
| April | APRIL |
| May | MAY |
| June | JUNE |
| July | JULY |
| August | AUG |
| September | SEPT |
| October | OCT |
| November | NOV |
| December | DEC |

So `BLOCK DATE 2026-02-01` + `NO # 2` → `FEB-26-BLK2`.
`BLOCK DATE 2026-03-01` + `NO # 19` → `MARCH-26-BLK19`.
`BLOCK DATE 2026-05-01` + `NO # 6` (WHSE=FEEDING AREA) → `MAY-26-FEED6`.

**Fallback for unknown months:** try both primary prefix AND the alternate (full vs 3-letter). If neither exists in DB, surface as unmapped and route to manual review.

## Schema: `rc_out` table

```
id              uuid PK
transaction_date date NOT NULL
batch_id        uuid NOT NULL FK -> batches(id)   <-- UUID not text!
destination     text NOT NULL    -- empirically always 'MAIN' for May 2026
weight_kg       numeric NOT NULL
remarks         text
block_loc       text             -- typically EMPTY in DB; the join via batch supplies it
created_at      timestamptz
production_batch text             -- e.g., 'MAY' for May entries (month name 3-letter)
```

### Natural key for classification

`(transaction_date, batch_id, destination)` — one row per batch per day per destination.

Currently `destination` is always `MAIN` for May 2026 data, so effectively `(transaction_date, batch_id)`.

### Closing logic

If a block's STATUS is "DONE" or "DONE FEEDING" on a given day, set `remarks = 'CLOSED'` on the rc_out row. The DB trigger (or the `view_rc_movement` `closed_today` flag) propagates this to the batch status.

## File: RAW CHARCOAL MOVEMENT 2026.xlsx

### Sheet structure

One sheet per month (`JANUARY 2026`, ..., `MAY 2026`). Each sheet:

| Row | Content |
|---|---|
| R1 | Title only ("MAY 2025" — but sheet name is MAY 2026; title is a copy artifact) |
| R3-R5 | Multi-row header: DATE / RAW CHARCOAL FED (KLS.) / DERAMI / OVER columns / Re-Classified / Mixing / Blending / Production |
| R7+ | Data: one row per date, with `RAW CHARCOAL FED` total + breakdown across product categories |

Sparse rows between dates (similar to RC DELIVERIES).

### Daily total = sum of PROPOSED block sections

For each `transaction_date`:
- `RC MOVEMENT.RAW_CHARCOAL_FED` (col B) should ≈ `SUM(PROPOSED block section DAY TOTALs)` for that day
- Tolerance: ±50 kg (rounding); >50 kg drift = flag

If the totals match: confidence is high that the per-block PROPOSED data is correct.
If they don't: surface the discrepancy. Don't write to DB until reconciled.

## Reconciliation logic

Per ingestion run:

1. **Extract PROPOSED:** parse the day's sheet → list of `{batch_code, day_total, status, remarks}` per block section
2. **Extract RC MOVEMENT:** parse the latest month sheet → list of `{date, raw_charcoal_fed_kls}` per row
3. **For the date(s) covered by PROPOSED:**
   - Sum PROPOSED day_totals = `P`
   - Look up RC MOVEMENT `raw_charcoal_fed_kls` for that date = `M`
   - If `abs(P - M) > 50`: **flag discrepancy** with values + which side might be wrong
   - If `abs(P - M) <= 50`: green-light for write
4. **Classify against rc_out:**
   - For each PROPOSED block section: derive batch_code → look up batch_id → check `(transaction_date, batch_id, 'MAIN')` against rc_out
   - NEW / VALUE_CHANGED / DUPLICATE_NOOP per Deliveries Manager pattern
5. **Write only if reconciliation passes AND user approves**

## Corrections pattern (real-world observed 2026-05-26)

RC MOVEMENT had a same-day correction email: *"Please disregard the previous file as I made changes to the waste total. Instead of 12217, the correct value is 14217."*

Handling: always pick the **latest message in the thread** (sort by internalDate desc). The fetch_gmail.py already returns thread+message metadata so the agent picks the freshest attachment.

## Three new tools (parallel to RC IN pipeline)

```
.claude/skills/sync-ictc/scripts/
├── extract_proposed_daily.py    # PROPOSED.xlsx -> per-block rc_out rows JSON
├── extract_rc_movement.py        # RC MOVEMENT.xlsx -> per-day totals JSON (audit only)
├── classify_rc_out.py            # NEW/CHANGED/NOOP against existing rc_out
└── reconcile_rc_movement.py      # Check PROPOSED totals vs RC MOVEMENT daily fed
```

## Two new agents

```
.claude/agents/
├── rc-out-manager.md             # Owns PROPOSED -> rc_out pipeline (PROPOSE + EXECUTE modes)
└── rc-movement-auditor.md        # READ-ONLY auditor; verifies PROPOSED vs RC MOVEMENT vs rc_out
```

### rc-out-manager responsibilities

- Fetch latest PROPOSED DAILY REPORT thread (sender Ivy/Pretchel, subject "PROPOSED DAILY REPORT")
- Parse the latest sheet (one per day; pick today's or specified date)
- Extract per-block rc_out rows
- **Run reconciler** to compare with RC MOVEMENT for that date — if drift, halt and report
- Look up batch_id for each batch_code (try primary prefix → fallback prefix → unmapped)
- Classify NEW/CHANGED/NOOP against existing rc_out
- Return summary in PROPOSE mode
- Execute writes (rc_out INSERT/UPDATE + audit_logs) in EXECUTE mode
- Apply Blackwood-Processed Gmail label after successful writes

### rc-movement-auditor responsibilities

- READ-ONLY. Never inserts/updates anything.
- Fetch latest RAW CHARCOAL MOVEMENT thread
- For each date in the month sheet, query rc_out: `SELECT SUM(weight_kg) FROM rc_out WHERE transaction_date = X`
- Compare with `RAW_CHARCOAL_FED (KLS.)` column for the same date
- Surface discrepancies (>50 kg drift) in a report
- Also compare against `view_rc_movement` for batch-level cross-checks
- Output a human-readable audit report

## Out of scope (initially)

- The right-side product breakdown columns in RC MOVEMENT (Re-Classified, Mixing, Blending, Production output by category) — these feed `flecon_bag_movement` / production output tables that don't exist yet. Future scope.
- Block sundrying / tank batch types (SUNDRY*, TNK*) — present in DB but unclear how they appear in PROPOSED reports. Will surface as unmapped if encountered.
- Multi-destination splits (rows where rc_out has destination ≠ 'MAIN') — observed = 0 in recent data, so deferred.

## Open questions for first ingestion run

1. Does the operator's "DONE FEEDING" remark always equal status `closed_today=true`, or are there nuances (e.g., "DONE" alone vs "DONE FEEDING")? Treat both as triggering `remarks='CLOSED'`.
2. Should the agent process MULTIPLE day sheets in one run (catching up from a backlog), or strictly the latest? **Default: process from `MAX(rc_out.transaction_date) + 1` through the latest sheet** — fills any gap.
3. What's the right `production_batch` value? Observed: `MAY` (uppercase 3-letter month). Derive from `transaction_date.strftime('%b').upper()`.
