# Production Domain — Ingestion Design Scaffold

> **Status:** Production Manager agent BUILT (2026-05-29) — `.claude/agents/production-manager.md`. Phase 0.5 complete (live source emails deep-read + verified 2026-05-29), all structural decisions LOCKED, schema + UI + MASTER backfill + all 8 Python tools (2 extractors, 5 classifiers, 1 reconciler) + the orchestration agent all built. **Ready for first end-to-end email-driven sync.** See **Section 15** for the canonical scrape maps and verified mappings (the extractor build reference) and **Section 16** for the agent pointer.
>
> **Source of truth examined:** `/Users/renzosy/Documents/1A WORK FILES/ICTC/MASTER - ICTC INPUT FILE V1.xlsx` (sheet **PROD**, backfill source) **plus the two live daily emails** (deep-read 2026-05-29): MC's `Daily Production Report 2026 2Q.xlsx` (one sheet per day) and Ivy's `WASTE PRODUCTION REPORT 2026.xlsx` (one sheet per month).
>
> **Companion design docs:** `RC_OUT_DESIGN.md` (already implemented).

---

## 1. What's in MASTER's PROD sheet

The PROD sheet has **three side-by-side sub-tables**, each tracking a different aspect of the daily production line. They share `(transaction_date, shift, batch)` as a logical grouping key but each row is independent in the sheet.

### Sub-table 1: PRODUCTION OUTPUT (cols A-F)

| Col | Header | Type | Example | Notes |
|---|---|---|---|---|
| A | DATE | date | 2026-05-23 | |
| B | BATCH | text | MAY | Month name UPPERCASE, used as `production_batch` |
| C | GRADE | text | 3X50 / 6X50 / 8X50 / 2X6 / 4X8 | One of 5 mesh sizes (4X8 added 2026-06-30 — see §14 / L-027) |
| D | SHIFT | text | M | M = Morning, E = Evening, N = Night (confirmed shift codes) |
| E | TTL KG | numeric | 19266 | Total kg produced of this grade this shift |
| F | REMARKS | text/null | (often null) | |

**Granularity:** One row per `(date, grade, shift)`. Typical day has 1-2 rows (3X50 + 6X50). Some days produce a row per grade (up to 5: 3X50 / 6X50 / 8X50 / 2X6 / 4X8).

**Latest row in MASTER:** R248 = 5/23, MAY, 6X50, M, 8800 kg.

### Sub-table 2: DOWNTIME (cols H-O)

| Col | Header | Type | Example | Notes |
|---|---|---|---|---|
| H | DATE | date | 2026-05-23 | |
| I | BATCH | text | MAY | |
| J | SHIFT | text | M | |
| K | SHIFT HRS | numeric | 9 | Scheduled shift duration |
| L | DT HRS | numeric | (often null) | Downtime full hours |
| M | DT MINS | numeric | 10 | Downtime minutes |
| N | DT TTL | numeric | 0.166666... | DT_HRS + (DT_MINS / 60) — computed |
| O | TTL HRS | numeric | 8.833333... | SHIFT_HRS - DT_TTL — computed |

**Granularity:** One row per `(date, shift)`. Sparse — blank rows between dates.

### Sub-table 3: WASTE SUMMARY (cols Q-AK)

| Col | Header | Type | Notes |
|---|---|---|---|
| Q | DATE | date | |
| R | BATCH | text | |
| S | SHIFT | text | |
| T | RS1A | numeric (kg) | Re-classified stream 1A |
| U | SKS1 | mixed | Sacks of RS1A. **Mixed types:** sometimes integer (8), sometimes string ("3 bags") |
| V | RS1B | numeric | |
| W | SKS2 | integer | |
| X | BF | numeric | "BF" possibly = Bag Fines |
| Y | SKS3 | integer | |
| Z | RS2/3 | numeric | |
| AA | SKS4 | integer | |
| AB | RS5 | numeric | |
| AC | SKS5 | integer | |
| AD | TRML 1 | numeric | Trommel 1 (grading sieve) waste |
| AE | SKS6 | integer | |
| AF | TRML 2 | numeric | Trommel 2 waste |
| AG | SKS7 | integer | |
| AH | GRIT | numeric | Grit (rocks, debris) |
| AI | (skipped) | — | One col gap |
| AJ | TTL WASTE | numeric | Computed sum of all _kg cols |
| AK | PROD LOSS | numeric (0-1) | TTL_WASTE / (TTL_OUTPUT + TTL_WASTE) — computed % as decimal |

**Granularity:** One row per `(date, shift)`. Independent from output (some days have output but no waste row, though rare).

**Latest row example:** R247 = 5/23 MAY M → 2507 + 1814 + 175 + 526 + 95 + 125 + 0.5 + 27 = 5269.5 kg total waste, 18.78% prod loss.

---

## 2. Source emails (per AI_INGESTION_AGENT.md design)

The PROD sheet in MASTER is **a consolidation** Renzo maintains by hand. The actual daily-source emails are:

| Email subject | Sender | Frequency | Sub-tables covered |
|---|---|---|---|
| **Daily Production Report** | mccontinedo.ictc@gmail.com (MC) | Daily | PRODUCTION OUTPUT + DOWNTIME |
| **WASTE PRODUCTION REPORT** | edilloivymae306ictc@gmail.com (Ivy) | Daily | WASTE SUMMARY |

So **two separate emails feed the three sub-tables**:
- MC's email → production_runs + production_downtime
- Ivy's email → production_waste

Need to verify by examining actual emails — formats may differ from MASTER's consolidated layout. Recommend doing that in Phase 0 before committing.

---

## 3. Current schema (as of 2026-05-28 parent-child restructure)

Four tables. `production_shifts` is the parent; the three sub-tables are FK-children. All applied via migrations — see §12 for the full migration timeline.

### `production_shifts` (NEW — parent table, 2026-05-28)

```sql
CREATE TABLE production_shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_date date NOT NULL,
  production_batch text NOT NULL,       -- 'MAY', 'JUNE', etc.
  shift            text NOT NULL,       -- 'M' | 'E' | 'N'
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_date, production_batch, shift),
  CHECK (shift IN ('M', 'E', 'N'))
);
CREATE INDEX idx_production_shifts_date ON production_shifts(transaction_date DESC);
```

### `production_runs` (restructured 2026-05-28)

```sql
CREATE TABLE production_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id   uuid NOT NULL REFERENCES production_shifts(id),
  customer   text NOT NULL DEFAULT 'CEBU',   -- 'CEBU' | 'KURARAY' | ...
  grade      text NOT NULL,                  -- '3X50' | '6X50' | '8X50' | '2X6' | '4X8'
  ttl_kg     numeric NOT NULL CHECK (ttl_kg >= 0),
  sacks_bags integer,
  remarks    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, customer, grade),
  CHECK (grade IN ('3X50', '6X50', '8X50', '2X6', '4X8'))   -- '4X8' added 2026-06-30 (migration 20260630000000; L-027)
);
CREATE INDEX idx_production_runs_shift_id ON production_runs(shift_id);
CREATE INDEX idx_production_runs_customer ON production_runs(customer);
```

**Key design notes:**
- `transaction_date`, `production_batch`, `shift` columns dropped — these now live exclusively in `production_shifts`.
- Natural key is `(shift_id, customer, grade)` — accommodates same-day batch/customer crossover events without losing fidelity.
- `customer` column added 2026-05-27 (default `CEBU`) after KURARAY event surfaced in MASTER backfill (2026-04-16 row).

### Extractor logic for MC's email "PREFIX GRADE" cells

MC writes the grade column with a prefix. The extractor uses a strict allowlist — only CEBU-prefixed finished-grade rows go into `production_runs`. Everything else (waste sales, ad-hoc notes) is silently dropped from the production pipeline.

| MC's text | Where it goes | How we route it |
|---|---|---|
| `CEBU 3X50` / `CEBU 6X50` / `CEBU 8X50` / `CEBU 2X6` / `CEBU 4X8` | `production_runs` | Strip `CEBU ` prefix → grade column |
| Bare `3X50` / `6X50` / `4X8` / etc. (from MASTER backfill) | `production_runs` | Use as-is |
| `KOREA POWDER` / `LOCAL POWDER` / `ZAMBOANGA <anything>` | **IGNORED** | Out of Production Manager scope per Renzo (2026-05-27). Future Bagging / Waste Sales Manager owns these. |
| Anything else not matching the allowlist | **IGNORED** with a warning in the extractor summary | Surface for manual review; do NOT auto-write |

**Backfill from MASTER:** all PROD rows go straight to `production_runs` with bare grade — MASTER doesn't have a prefix to strip.

### `production_downtime` (restructured 2026-05-28)

```sql
CREATE TABLE production_downtime (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id  uuid NOT NULL REFERENCES production_shifts(id),
  shift_hrs numeric NOT NULL CHECK (shift_hrs > 0),
  dt_hrs    numeric NOT NULL DEFAULT 0 CHECK (dt_hrs >= 0),
  dt_mins   numeric NOT NULL DEFAULT 0 CHECK (dt_mins >= 0 AND dt_mins < 60),
  dt_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id)   -- exactly 1 downtime row per shift
);
CREATE INDEX idx_production_downtime_shift_id ON production_downtime(shift_id);
```

`transaction_date`, `production_batch`, `shift` columns dropped — now in parent.
`dt_ttl_hrs` and `productive_hrs` are computed in `view_production_daily`, NOT stored.

### `production_waste` (restructured 2026-05-28; SKS columns dropped)

**Source confirmed (2026-05-27):** Ivy's WASTE PRODUCTION REPORT email contains the same waste data pasted into MASTER's WASTE SUMMARY section.

**SKS columns decision (2026-05-28):** The 7 `*_sacks` columns (`rs1a_sacks` through `trml2_sacks`) were originally captured for completeness but were mixed-type text blobs (integers, strings like "3 bags") not used in any aggregation or view. Dropped in the 2026-05-28 restructure. Raw values were preserved during the MASTER backfill but are not recoverable from the DB going forward.

```sql
CREATE TABLE production_waste (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id  uuid NOT NULL REFERENCES production_shifts(id),
  -- 8 waste streams (kg only — sacks columns dropped 2026-05-28)
  rs1a_kg   numeric NOT NULL DEFAULT 0 CHECK (rs1a_kg >= 0),
  rs1b_kg   numeric NOT NULL DEFAULT 0 CHECK (rs1b_kg >= 0),
  bf_kg     numeric NOT NULL DEFAULT 0 CHECK (bf_kg >= 0),
  rs23_kg   numeric NOT NULL DEFAULT 0 CHECK (rs23_kg >= 0),
  rs5_kg    numeric NOT NULL DEFAULT 0 CHECK (rs5_kg >= 0),
  trml1_kg  numeric NOT NULL DEFAULT 0 CHECK (trml1_kg >= 0),
  trml2_kg  numeric NOT NULL DEFAULT 0 CHECK (trml2_kg >= 0),
  grit_kg   numeric NOT NULL DEFAULT 0 CHECK (grit_kg >= 0),
  remarks   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id)   -- exactly 1 waste row per shift
);
CREATE INDEX idx_production_waste_shift_id ON production_waste(shift_id);
```

`ttl_waste_kg` and `prod_loss_pct` are computed in `view_production_daily`, NOT stored.

**Source emails for `production_waste`:**
- Backfill: MASTER's PROD sheet, WASTE SUMMARY section (cols Q-AK)
- Going forward: Ivy's WASTE PRODUCTION REPORT email (`edilloivymae306ictc@gmail.com`)

**Out of scope (intentionally dropped):** KOREA POWDER / LOCAL POWDER rows in MC's email. Future Bagging Manager or a dedicated Waste Sales Manager can pick them up if/when needed.

### Suggested view: `view_production_daily`

A reconciliation-friendly view combining all 3 tables:

```sql
CREATE VIEW view_production_daily AS
SELECT
  COALESCE(pr.transaction_date, pd.transaction_date, pw.transaction_date) AS date,
  COALESCE(pr.shift, pd.shift, pw.shift) AS shift,
  pr.production_batch,
  -- Output by grade
  SUM(pr.ttl_kg) FILTER (WHERE pr.grade = '3X50') AS kg_3x50,
  SUM(pr.ttl_kg) FILTER (WHERE pr.grade = '6X50') AS kg_6x50,
  SUM(pr.ttl_kg) FILTER (WHERE pr.grade = '8X50') AS kg_8x50,
  SUM(pr.ttl_kg) FILTER (WHERE pr.grade = '2X6')  AS kg_2x6,
  SUM(pr.ttl_kg) AS total_output_kg,
  -- Downtime
  pd.shift_hrs, pd.dt_hrs, pd.dt_mins,
  (pd.dt_hrs + pd.dt_mins/60.0) AS dt_total_hrs,
  (pd.shift_hrs - pd.dt_hrs - pd.dt_mins/60.0) AS productive_hrs,
  -- Waste
  COALESCE(pw.rs1a_kg, 0) + COALESCE(pw.rs1b_kg, 0) + COALESCE(pw.bf_kg, 0)
    + COALESCE(pw.rs23_kg, 0) + COALESCE(pw.rs5_kg, 0)
    + COALESCE(pw.trml1_kg, 0) + COALESCE(pw.trml2_kg, 0) + COALESCE(pw.grit_kg, 0)
    AS total_waste_kg,
  -- Production loss
  CASE WHEN (SUM(pr.ttl_kg) + COALESCE(pw_total_waste, 0)) > 0
       THEN COALESCE(pw_total_waste, 0) / NULLIF(SUM(pr.ttl_kg) + COALESCE(pw_total_waste, 0), 0)
       ELSE NULL END AS prod_loss_pct
FROM production_runs pr
FULL OUTER JOIN production_downtime pd USING (transaction_date, shift)
FULL OUTER JOIN production_waste pw    USING (transaction_date, shift)
GROUP BY transaction_date, shift, production_batch, pd.shift_hrs, pd.dt_hrs, pd.dt_mins, pw.*;
```

---

## 4. Agent architecture — one or three?

Two viable approaches:

### Option A — One **Production Manager** (recommended for v1)

Owns all three tables. Pulls both source emails (MC's Daily Production + Ivy's Waste), extracts each, classifies, presents a unified summary, writes.

**Pros:**
- Single mental model — "production" is one domain
- Easier reconciliation (one agent owns the total_output + total_waste cross-check)
- Matches MASTER's structure (all in one PROD sheet)

**Cons:**
- Two source emails means two different fetch/extract paths inside one agent
- Bigger system prompt, more responsibility

### Option B — Two specialists

- **Production Output Manager** — MC's email → production_runs + production_downtime
- **Waste Manager** — Ivy's email → production_waste

**Pros:**
- Matches source-email split
- Smaller, more focused agents
- Each can be tested independently

**Cons:**
- Cross-reconciliation (output vs waste) requires a third coordinator
- Two Gmail labels, two label-management cycles

**Recommendation: A (one Production Manager) for v1.** Can split later if the agent grows unwieldy.

---

## 5. Python tools needed (mirrors existing pattern)

```
.claude/skills/sync-ictc/scripts/
├── extract_daily_production.py    # MC's email -> production_runs + downtime + electricity + truck rows
├── extract_waste_production.py    # Ivy's email -> production_waste rows
├── extract_master_prod.py         # MASTER PROD sheet -> production runs/downtime/waste (bulk backfill)
├── extract_master_electricity.py  # MASTER ELECTRICITY sheet -> monthly aggregates (bulk backfill)
├── extract_master_trucks.py       # MASTER TRUCKS sheet -> monthly aggregates (bulk backfill)
├── classify_production_runs.py    # NEW/CHANGED/NOOP vs production_runs
├── classify_production_downtime.py
├── classify_production_waste.py
├── classify_electricity.py
├── classify_trucks.py
└── reconcile_production.py        # Daily informational drift report + monthly hard reconcile
```

Same Python-tools-as-deterministic-muscle pattern as deliveries-manager / rc-out-manager.

`extract_daily_production.py` is the most complex — handles 4 different sub-sections in MC's email (output / downtime / electricity / trucks). If MC's email actually splits these into separate attachments, each gets its own extractor (TBD in Phase 0).

---

## 6. Natural keys

Updated 2026-05-28 — parent-child restructure moved date/batch/shift to `production_shifts`.

| Table | Natural key | Notes |
|---|---|---|
| `production_shifts` | `(transaction_date, production_batch, shift)` | The normalized triplet. One row per unique (date, batch, shift) combination. |
| `production_runs` | `(shift_id, customer, grade)` | N:1 with shifts. Allows same-day customer crossover (e.g., 2026-04-16 KURARAY → CEBU intra-shift switch). |
| `production_downtime` | `(shift_id)` | Exactly 1 downtime row per shift — enforced via UNIQUE(shift_id). |
| `production_waste` | `(shift_id)` | Exactly 1 waste row per shift — enforced via UNIQUE(shift_id). |

**Ingestion pattern (after restructure):** Before inserting child rows, upsert `production_shifts` by `(transaction_date, production_batch, shift)` to obtain the `shift_id`. Then insert child rows with that `shift_id`.

**Migration history:**
- `20260527010000` — created production_runs/downtime/waste with date/grade/shift keys
- `20260527020000` — added `production_batch` to all three keys
- `20260527030000` — added `customer` to production_runs; updated its key
- `20260527040000` — created `production_shifts`; backfilled shift_id on all children; dropped redundant columns; dropped SKS columns from waste
- `20260527040001` — rewrote `view_production_daily` to join via shift_id

---

## 7. Data quality observations from MASTER

1. **Mixed type in SKS1 column** — sometimes integer (`8`), sometimes string (`"3 bags"`). Schema treats sacks columns as `text`. Extractor should keep raw value; classifier normalizes whitespace + case for comparison.

2. **Sparse rows in DOWNTIME** — many blank rows between dated rows. Extractor must skip blanks (same pattern as RC IN's forward-fill, but here no forward-fill needed — blank means no downtime row for that combination).

3. **`#VALUE!` errors in trailing rows** — rows 632-638 have formula errors. Extractor should treat `#VALUE!` as null and skip the row.

4. **PROD LOSS as decimal** — stored as `0.18775...` (= 18.78%). The agent should NOT store this; instead the view computes it. Source-of-truth is the per-stream weights.

5. **Production output sometimes split across grades** — 5/23 has both 3X50 (19,266 kg) and 6X50 (8,800 kg). Both inserted as separate rows.

6. **Only Morning shift (M) observed in recent data** — possible the operation is single-shift right now. Schema allows 'A' / 'N' for future.

---

## 8. Reconciliation logic — monitoring, not gating

**Important correction from Renzo (2026-05-27):** The flow RC IN → RC OUT → (Production OUT + Waste) **does not balance on a per-day basis**. Production is a continuous process — raw charcoal sits in the feed tank for days before being fully processed. So daily kg-in vs kg-out always shows drift.

The real alignment happens at **end-of-month** when the feed tank gets emptied. Until then, daily drift is **expected** and is **not a data quality signal**.

### What the Production Manager SHOULD do for reconciliation

| Cadence | What to compute | What to do with it |
|---|---|---|
| **Daily** | Show `total_rc_out_kg` vs `total_production_kg + total_waste_kg` as a trend metric | Surface as informational on the daily summary; **never block writes** on it |
| **Month-end** (after feed tank is empty) | Sum across the whole month and compare | If drift > 5% → real anomaly worth investigating |
| **Per-batch (lifetime)** | Sum of `rc_out` consumption for a batch vs sum of `production_runs` ttl_kg attributable to that batch's processing window | More precise but harder; defer to v2 |

### Don't gate writes on this

In rc-out-manager, the PROPOSED vs RC MOVEMENT reconciliation is a HARD gate (serious drift halts writes) because those two files SHOULD match on a per-day basis — they're two operators recording the same day's events.

In Production Manager, the daily drift number is INFORMATIONAL — operator inputs are correct, the apparent "imbalance" is just inventory in transit. Showing it helps Renzo monitor the feed-tank fill level over time. Don't refuse to write when it's nonzero.

### What's reconcilable inside Production Manager itself

These ARE worth checking and can be gates:

| Check | Why |
|---|---|
| `production_runs.ttl_kg` per (date, grade) sum across shifts | Should match any "daily summary" cell in MC's email if one exists |
| `production_waste.total_waste_kg` matches sum of per-stream cols | Internal arithmetic check |
| `production_downtime.shift_hrs - dt_hrs - dt_mins/60 = ttl_hrs` | Matches operator's TTL HRS formula |
| Each `(date, shift)` should have at most ONE production_downtime + ONE production_waste row | Schema enforces, but flag if the email contains multiple |

---

## 9. Open questions before building

1. **Email format vs MASTER format** — does MC's Daily Production Report email match the MASTER layout exactly, or is it a different structure? Need to fetch a recent email and compare. If different, the email extractor will be different from the MASTER backfill extractor.

2. **Waste email format** — Same question for Ivy's WASTE PRODUCTION REPORT. The 8 waste streams in MASTER (RS1A, RS1B, BF, RS2/3, RS5, TRML1, TRML2, GRIT) — does the email use the same names?

3. **Batch/production_batch field meaning** — In MASTER it's a month name like "MAY". Is that the month the production happened in, or the campaign/batch identifier? Need to confirm with Renzo before using as a natural-key component.

4. **Backfill scope** — should the first run ingest ALL 638 PROD rows (going back to Nov 2025), or only fill from today onward? Recommend ingesting MASTER first (backfill), then email-driven updates from that point forward.

5. **Are there other shift values besides 'M'?** — Verify by querying all distinct shift values once a column exists, or check older PROD rows.

6. **Should sundrying analysis (SUNDRY ANALYSIS sheet) be folded into Production Manager?** — Probably no; it's more QC than production. Separate Sundry Manager later.

---

## 9b. Expanded scope: ELECTRICITY + TRUCKS (also from MC's emails)

**Locked decision (2026-05-27):** Production Manager also owns these two domains because the values come from MC's Daily Production Report email (per Renzo). One agent, one source email, multiple target tables.

### MASTER's ELECTRICITY sheet (631 rows × 23 cols)

Granularity: **monthly** in MASTER, but the source readings are daily (MC's email likely has daily readings). MASTER summarizes monthly.

Structure (verified): TWO side-by-side meter sections.

- **TOTAL meter (cols A-H):** MONTH | TTL | START KWH | END KWH | DIFF | RATE | TTL KHW | AVGS
- **BUNKHOUSE meter (cols J-O):** START KWH | END KWH | DIFF | RATE | TTL KHW | AVGS
- (Possibly more meters in cols 17+ — to verify when extractor is built)

Rate is consistently 120 (PHP/kWh). DIFF = END - START. TTL KHW = DIFF × RATE. AVGS = daily average.

### MASTER's TRUCKS sheet (385 rows × 29 cols)

Granularity: **monthly** in MASTER (one row per month per truck).

Structure (verified): per-truck column groups, side-by-side. Each truck:
- PLATE NO. (e.g., AAV 6111, KCA 378, more in further columns)
- START KM | END KM | TTL KM | TTL FUEL | REMARKS

29 cols suggests ~4-5 trucks tracked. Need full column scan to enumerate when building.

### Proposed tables

> ⚠️ **SUPERSEDED 2026-05-29 (see Section 15) — DONE, applied as `20260529000000_rework_electricity_to_meter_multiplier`:** the `rate_php_per_kwh` column below is a misnomer. The live MC email labels the `120` a **METER MULTIPLIER** and computes `CONSUMPTION (KWH) = diff × 120` — there is **no peso cost** in the source. The migration renamed `rate_php_per_kwh → meter_multiplier` and added a generated `consumption_kwh = (end_kwh − start_kwh) × meter_multiplier` (against BASE columns, NOT the generated `diff_kwh` — Postgres forbids generated-on-generated). `view_electricity_monthly` (with its `month_ttl_php` peso math) was DROPPED. The `CREATE TABLE electricity_readings` snippet below reflects the OLD shape — see Section 14 for the live schema.

```sql
CREATE TABLE electricity_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_date date NOT NULL,
  meter text NOT NULL,                -- 'TOTAL' | 'BUNKHOUSE' | (others observed)
  start_kwh numeric NOT NULL,
  end_kwh numeric NOT NULL,
  diff_kwh numeric GENERATED ALWAYS AS (end_kwh - start_kwh) STORED,
  rate_php_per_kwh numeric NOT NULL DEFAULT 120,
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reading_date, meter)
);

CREATE TABLE truck_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reading_date date NOT NULL,
  plate_no text NOT NULL,             -- 'AAV 6111', 'KCA 378', etc.
  start_km numeric NOT NULL,
  end_km numeric NOT NULL,
  ttl_km numeric GENERATED ALWAYS AS (end_km - start_km) STORED,
  fuel_liters numeric,                -- TTL FUEL in MASTER (units to verify)
  remarks text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reading_date, plate_no)
);

-- Monthly aggregate views for the Excel-parity display
CREATE VIEW view_electricity_monthly AS
SELECT DATE_TRUNC('month', reading_date)::date AS month, meter,
       MIN(start_kwh) AS month_start, MAX(end_kwh) AS month_end,
       (MAX(end_kwh) - MIN(start_kwh)) AS month_diff,
       AVG(rate_php_per_kwh) AS rate,
       (MAX(end_kwh) - MIN(start_kwh)) * AVG(rate_php_per_kwh) AS month_ttl_php
FROM electricity_readings GROUP BY 1, 2;

CREATE VIEW view_trucks_monthly AS
SELECT DATE_TRUNC('month', reading_date)::date AS month, plate_no,
       MIN(start_km) AS month_start_km, MAX(end_km) AS month_end_km,
       SUM(ttl_km) AS month_km, SUM(fuel_liters) AS month_fuel
FROM truck_readings GROUP BY 1, 2;
```

### Open question for these two

**Does MC's daily email contain DAILY meter readings, or just monthly totals?**

If daily: store daily, derive monthly. Best.
If monthly only: store monthly directly, lose granularity. Acceptable but limits future analysis.

This needs to be answered in Phase 0 (email inspection). Schema above assumes daily readings.

---

## 10. What's NOT in this design (deferred to other agents)

| Sheet | Future agent | Domain |
|---|---|---|
| FB (Flecon Bagged) | **Bagging Manager** | Bag-type inventory + bagging events |
| 3X50 KC / 8X50 / 6X50 / 2X6 | **QC Manager** (or Per-Grade Manager) | Per-grade QC results, AYAG/MAGNET/FINAL stages |
| SUNDRY ANALYSIS | **Sundry Analysis Manager** | Sundrying MC%/weight delta tracking |
| ~~TRUCKS~~ | ~~Bagging Manager~~ | **MOVED IN — now Production Manager's** |
| ~~ELECTRICITY~~ | ~~Utilities Manager~~ | **MOVED IN — now Production Manager's** |

Each of the remaining warrants its own design doc when the time comes.

---

## 11. Phased build plan (when you give the go-ahead)

| Phase | Work | Estimated effort |
|---|---|---|
| **0** | Fetch + inspect MC's Daily Production email + Ivy's WASTE email. Verify daily-vs-monthly granularity for electricity/trucks. Verify meter list + truck plate list. Update this doc with findings. | 45 min |
| **1** | Migration: create 5 tables (production_runs, production_downtime, production_waste, electricity_readings, truck_readings) + 2 monthly views + view_production_daily. Apply to live Supabase. Regenerate types. | 1 hr |
| **2** | Build `extract_master_prod.py` (all 3 PROD sub-tables) + `extract_master_electricity.py` + `extract_master_trucks.py`. | 3 hr |
| **3** | Bulk backfill: extract MASTER → classify (all NEW since DB empty) → insert with audit logs. ~250 PROD rows + ~12 monthly electricity + ~12-50 monthly truck rows. | 45 min |
| **4** | Build `extract_daily_production.py` + `extract_waste_production.py` (for emails). | 2.5 hr |
| **5** | Build `classify_*` scripts (5 files). | 1.5 hr |
| **6** | Build `reconcile_production.py` (daily informational drift + month-end hard reconcile). | 1 hr |
| **7** | Write `production-manager.md` agent. | 1 hr |
| **8** | First end-to-end test with real email data. | 45 min |

**Total estimated effort: ~12 hr** spread across 2 working sessions.

The Production Manager would slot in alongside the Deliveries Manager + RC Out Manager as the third employee — but with the broadest scope of any (5 target tables vs 1 for the others).

---

## 13. Phase 0 Findings — MC's Daily Production Report email (verified 2026-05-27)

Inspected: `118474_Daily Production Report 2026 2Q.xlsx`, sheet `05-26-26` (covering 5/26 production, sent 5/27 by MC).

**Critical observation:** MC's email is **far richer than the MASTER PROD sheet**. MASTER captures ~3 sub-sections (PRODUCTION / DOWNTIME / WASTE SUMMARY). MC's actual email has ~20 sections covering virtually the entire production operation. Renzo manually distills these into MASTER's 3 sections.

### What MC's email contains

| Section | Rows | Maps to | Daily/Monthly | Already in scope? |
|---|---|---|---|---|
| 1. Production output (per shift, per grade-with-destination) | R7-R15 | `production_runs` | Daily | ✅ Yes |
| 2. Charcoal Fed (sacks per shift) | R21-R26 | `production_charcoal_fed` (NEW) | Daily | ❌ NEW scope |
| 3. Downtime (per shift, with reason) | R24-R27 | `production_downtime` | Daily | ✅ Yes (+confirms DT_REASON) |
| 4. RC Tank Level (estimated remaining) | R37-R38 | `rc_tank_level` (NEW) | Daily | ❌ NEW scope — answers Renzo's "feed tank empties end of month" |
| 5. Daily PC Stock per block | R30-R34 | `production_pc_stock` (NEW) | Daily | 🟡 Possibly defer |
| 6. Dump Truck refuse (ABOG/SOIL/TUBIG/BASURA) | R41-R45 | `production_refuse` (NEW) | Daily | 🟡 Defer |
| 7. **Truck deliveries (per plate, daily KM + fuel)** | R46-R51 | `truck_readings` | Daily | ✅ Yes — confirms daily granularity |
| 8. **Electricity MAIN (Previous/Present/Diff/Cost)** | R53-R60 | `electricity_readings` (MAIN meter) | Daily | ✅ Yes — confirms daily granularity |
| 9. **Electricity BUNKHOUSE** | R63-R67 | `electricity_readings` (BUNKHOUSE meter) | Daily | ✅ Yes |
| 10. PUMP meter | R67 | `electricity_readings` (PUMP meter) | Daily | ✅ Yes — third meter confirmed |
| 11. Sundry (Completely Dried RC sacks/bags) | R71-R74 | `production_sundry` (NEW) | Daily | 🟡 Defer to Sundry Manager |
| 12. Magnet waste (per shift per magnet for 6X50) | R78-R86 | `production_waste_detail` (NEW) | Daily | 🟡 Defer to Bagging/QC Manager |
| 13. Magnet waste for second grade | R88-R95 | Same | Daily | 🟡 Defer |
| 14. AYAG waste (per shift, under/over) for 6X50 | R99-R107 | Same | Daily | 🟡 Defer |
| 15. AYAG waste for 2X6 | R110-R114 | Same | Daily | 🟡 Defer |
| 16. Re-Classify (grade conversions) | R118-R121 | `bagging_reclassify` (NEW) | Daily | 🟡 Defer to Bagging Manager |
| 17. Blending operations | R123-R125 | `bagging_blend` (NEW) | Daily | 🟡 Defer |
| 18. Re-Bagging / Re-Sacking | R125-R134 | Same | Daily | 🟡 Defer |
| 19. Bags contaminated/blowered/waste | R128-R132 | Same | Daily | 🟡 Defer |
| 20. Weight Adjustments | R134-R136 | Same | Daily | 🟡 Defer |

### Specific answers to the 5 open questions

1. **Daily vs monthly granularity for electricity/trucks?** → **DAILY.** MC's email has per-day readings. Schema's daily-granularity design is correct.
2. **One consolidated attachment or multiple?** → **ONE consolidated XLSX.** "Daily Production Report 2026 2Q.xlsx" with one sheet per production day (42 sheets so far for Q2 2026).
3. **Exact subject + sender?** → Subject **"Daily Production Report"** (exact). Sender `mccontinedo.ictc@gmail.com`.
4. **Full meter list?** → **At least 3 meters confirmed**: MAIN (total) + BUNKHOUSE + PUMP. May be others; verify with full column scan during build.
5. **Full truck plate list?** → **AAV 6111 + KCA 378** confirmed daily-active. MASTER's TRUCKS sheet has space for ~5 trucks total; verify by enumerating all column groups when building.

### NEW questions to address

A. **Shifts in MC's email show MORNING SHIFT + NIGHT SHIFT only** on 5/26. EVENING shift wasn't visible that day. **CONFIRMED 2026-05-27:** Renzo keeps M/E/N to prepare for a future 3rd shift; currently only M/N are in active use. Schema unchanged.

B. **MC email has "CEBU 3X50" and "KOREA POWDER"** — what looked like a destination prefix is actually customer routing. **RESOLVED 2026-05-27:**
   - `CEBU` is implicit (production destination; all finished production currently goes to Cebu sister plant)
   - `KOREA`, `ZAMBOANGA`, `LOCAL` are **WASTE BUYERS**, not production destinations
   - Extractor strips `CEBU ` prefix when seen → routes to `production_runs` with bare grade
   - Extractor sees `KOREA / ZAMBOANGA / LOCAL <anything>` → routes to `production_waste_sales` (or similar) with `customer` field — NOT to `production_runs`
   - `production_runs` schema reverted to no destination/customer column (just grade)

C. **MC's email and Ivy's WASTE email overlap question RESOLVED 2026-05-27:**
   - Ivy's WASTE PRODUCTION REPORT is the source-of-truth for `production_waste`. Its data is what Renzo copies into MASTER's WASTE SUMMARY section.
   - So `production_waste` schema mirrors MASTER's WASTE SUMMARY exactly (8 streams: RS1A/RS1B/BF/RS2_3/RS5/TRML1/TRML2/GRIT).
   - MC's email Magnet/Ayag/Re-Classify/Blending/Re-Bagging sections are **NOT** ingested by Production Manager (out of v1 scope; future Bagging/QC Managers).
   - MC's KOREA POWDER / LOCAL POWDER entries are **NOT** ingested (out of v1 scope).
   - This means Phase 0.5 (inspect Ivy's email) is now optional — we already know the structure (it matches MASTER). Still worth a quick verification when we get there, but not blocking.

### Recommended v1 scope (after Phase 0)

Given how much MC's email contains, I recommend **keeping the Production Manager v1 focused** — don't try to ingest all 20 sections at once.

**v1 IN scope (ingested by Production Manager):**
- production_runs (sections 1)
- production_downtime (section 3)
- production_waste (high-level only; from MASTER or Ivy email)
- electricity_readings (sections 8, 9, 10)
- truck_readings (section 7)
- **rc_tank_level (NEW: section 4)** — small but high-value: answers the daily-drift question directly

**v1 DEFERRED (placeholders only):**
- charcoal_fed sacks (section 2) — could be useful for rc_out reconciliation but rc_out already has weight totals
- pc_stock, sundry, refuse, magnet/ayag detail, blending, re-bagging — these go to future Bagging Manager + Sundry Manager + QC Manager

**Why this scope:**
- Matches what's already in MASTER (the user's curated view)
- Plus the daily granularity wins (electricity, trucks, tank level)
- Avoids 6+ new tables in one migration
- Other 14 sections can be tackled later by specialized agents

### Updated effort estimate after Phase 0

The base 12-hour estimate from Section 11 still holds — adding `rc_tank_level` is +1 hr (small table, daily insert). Other sections deferred = no additional v1 effort.

---

## 12. Decisions LOCKED (2026-05-27 confirmation from Renzo)

- ✅ **ONE Production Manager** — owns production runs / downtime / waste / electricity / trucks
- ✅ **Shifts: M / E / N** (Morning / Evening / Night) — preparing for future 3rd shift; currently M/N in active use
- ✅ **Full backfill from MASTER** on first run (PROD ~250 rows + ELECTRICITY monthly + TRUCKS monthly)
- ✅ **Grade enum: 3X50 / 6X50 / 8X50 / 2X6 / 4X8** (`4X8` added 2026-06-30 — was silently dropped before; see §14 migration `20260630000000` + L-027)
- ✅ **DT_REASON included** — scraped from MC's daily emails (not in MASTER but present in source emails)
- ✅ **Daily kg-in/kg-out drift is INFORMATIONAL, not a write gate** — feed tank empties at month-end; daily drift is expected from work-in-process inventory
- ✅ **Electricity + Trucks join the Production Manager's scope** (instead of separate Utilities agent) — same source email
- ⚠️ **REVISED 2026-05-27 (during MASTER backfill):** `customer` column ADDED to production_runs (default `CEBU`). The earlier "CEBU is implicit" decision was reversed when MASTER's 2026-04-16 row revealed a real KURARAY customer event that couldn't be represented without an explicit customer field. Backfilled data: 205 CEBU rows + 2 KURARAY rows. Migration: `20260527030000_add_customer_to_production_runs.sql`.
- ✅ **`rc_tank_level` table NOT in v1** — deferred per Renzo (not needed)
- ✅ **Daily granularity confirmed for electricity + trucks** (per Phase 0 inspection of MC's email)
- ✅ **NO `production_waste_sales` table.** KOREA / LOCAL / ZAMBOANGA waste-buyer rows in MC's email are SILENTLY DROPPED — out of Production Manager scope entirely. Future Bagging Manager or dedicated Waste Sales Manager can pick them up later.
- ✅ **`production_waste` matches MASTER's WASTE SUMMARY structure** (8 streams: RS1A/RS1B/BF/RS2_3/RS5/TRML1/TRML2/GRIT). Source: Ivy's WASTE PRODUCTION REPORT email — confirmed by Renzo to be the canonical waste source (her email content is directly pasted into MASTER's WASTE SUMMARY).
- ✅ **Parent-child shift model applied (2026-05-28).** `production_shifts` introduced as parent table. All three child tables joined via `shift_id` FK. `transaction_date`, `production_batch`, `shift` columns dropped from child tables. SKS columns (`rs*_sacks`) dropped from `production_waste` — mixed-type text blobs with no aggregation value. 158 production_shifts rows inferred from 207 runs + 158 downtime + 158 waste backfilled rows. All data preserved. Migrations: `20260527040000` + `20260527040001`.
- ✅ **Ingestion agents must upsert `production_shifts` first** (by natural key `(transaction_date, production_batch, shift)`) to obtain `shift_id`, then insert child rows with that FK. Never write transaction_date/production_batch/shift directly to child tables — those columns no longer exist.

### Phase 0 resolved (2026-05-27)

All previously-open questions have been answered by Phase 0 inspection — see Section 13 for full findings. Recap:

- ✅ Electricity + truck readings are **daily** in MC's email
- ✅ MC's email contains **one consolidated XLSX** with one sheet per production day
- ✅ Subject is exactly **"Daily Production Report"** from `mccontinedo.ictc@gmail.com`
- ✅ At least **3 electricity meters confirmed: MAIN + BUNKHOUSE + PUMP** (verify others during build)
- ✅ Trucks **AAV 6111 + KCA 378** confirmed daily-active (verify full list during build)

**No remaining blockers.** Phase 1 (migration) can begin whenever you give the go-ahead.

### Decisions LOCKED — 2026-05-29 (from Renzo, after live email deep-read; full evidence in Section 15)

- ✅ **2nd shift canonical code = `E`.** MC's email labels it "NIGHT SHIFT", Ivy's labels it "EVENING SHIFT" — they are the **same physical 2nd shift**. Both extractors must emit `E`. **No data migration needed** — the MASTER backfill already wrote M(140)/E(18), zero `N` rows. `N` stays reserved for a true future 3rd shift.
- ✅ **Waste stream mapping = positional, names unchanged.** Keep schema columns `bf_kg/trml1_kg/trml2_kg`; Ivy's `FILTER/UNCOOKED-SHELL/STONES` map into them. **Verified 8/8 value-for-value** against MASTER on 2026-05-22 and 2026-05-23 (Renzo's MASTER literally is Ivy's email with renamed headers). Full mapping table in Section 15.
- ✅ **Electricity rework (Phase 1 migration).** `rate_php_per_kwh → meter_multiplier`; add generated `consumption_kwh = diff_kwh × meter_multiplier`; rewrite `view_electricity_monthly` (drop `month_ttl_php` peso math). DB stores **raw** readings + the 120 factor, so MAIN auto-recomputes — no row rewrite. BUNKHOUSE/PUMP keep multiplier=120 (idle since 2025-12-12; confirm if direct-read later).
- ✅ **Downtime → aggregate to M shift.** MC's email gives per-DAY downtime with multiple time-windowed events in single cells. Sum all event minutes, concatenate reasons into `dt_reason`, write ONE downtime row on the day's **M** shift. Renzo will ask MC to split downtime by shift in the future. `shift_hrs` defaulted (proposed 12) until the email provides it cleanly.
- ✅ **transaction_date = the day-sheet name**, NOT the in-sheet `D4` date header. Verified: sheet `05-27-26` has `D4="MAY 28, 2026"` (the next-morning write date). Use the `MM-DD-YY` sheet title.

---

## 14. Schema Evolution Timeline

| Migration | Date | Description |
|---|---|---|
| `20260527010000_create_production_tables` | 2026-05-27 | Created 5 tables: production_runs, production_downtime, production_waste, electricity_readings, truck_readings. Initial natural keys: `(date, grade, shift)` / `(date, shift)`. |
| `20260527010001_create_production_views` | 2026-05-27 | Created view_production_daily (joining on transaction_date+shift), view_electricity_monthly, view_trucks_monthly. Grants to authenticated. |
| `20260527020000_add_batch_to_production_natural_keys` | 2026-05-27 | Added `production_batch` to all 3 child table natural keys after MASTER backfill revealed same-day batch crossover events (e.g., JANUARY→FEBRUARY morning on 2026-02-02). |
| `20260527030000_add_customer_to_production_runs` | 2026-05-27 | Added `customer` column (default `CEBU`) to production_runs and included in natural key. Triggered by MASTER's 2026-04-16 KURARAY event. Backfilled: 205 CEBU + 2 KURARAY rows. |
| `20260527040000_restructure_production_to_shifts_model` | 2026-05-28 | **Major restructure.** Created `production_shifts` parent table. Backfilled 158 shift rows from child UNION. Added `shift_id` FK to all 3 child tables. Swapped natural keys to shift_id-based. Dropped `transaction_date`, `production_batch`, `shift` from child tables. Dropped 7 SKS columns from production_waste. Dropped old date-based indexes, added FK indexes. |
| `20260527040001_rewrite_view_production_daily` | 2026-05-28 | Rewrote view_production_daily. Now drives from production_shifts (LEFT JOIN to children via shift_id). Exposes `shift_id` as row identifier. SKS columns removed. FULL OUTER JOIN replaced by LEFT JOIN from parent. |
| `20260630000000_add_4x8_to_production_runs_grade_check` | 2026-06-30 | **4X8 grade enabled.** Dropped + re-added `production_runs_grade_check` to allow `'4X8'` (now a 5-element array `['3X50','6X50','8X50','2X6','4X8']`). `grade` stays `text` — no type change, no data rewrite, no type regen. Forward-only: lets future syncs capture 4X8; historical 4X8 below the watermark is NOT backfilled (separate decision). Root cause: 4X8 is a real finished grade (MC writes it verbatim as `4X8`) that was silently dropped from `production_runs` on every sync because it was missing from BOTH the extractor `VALID_GRADES` allowlist AND this DB CHECK — a value must pass both gates. The extractor side was fixed separately (`extract_daily_production.py`). Verified live: constraint def includes `4X8`; `4X8` + `3X50` both pass a rolled-back probe insert; bogus grade still rejected. See L-027. |
| `20260529000000_rework_electricity_to_meter_multiplier` | 2026-05-29 | **Electricity semantics fix.** Renamed `electricity_readings.rate_php_per_kwh → meter_multiplier` (kept NOT NULL DEFAULT 120 + values; renamed the dependent CHECK constraint to match). Added generated stored column `consumption_kwh = (end_kwh - start_kwh) × meter_multiplier` (defined against BASE columns — Postgres forbids referencing the generated `diff_kwh`). Dropped `view_electricity_monthly` (referenced the old column + computed bogus `month_ttl_php` peso math; UI removed May 2026, unqueried). DB stores raw readings + the 120 factor, so MAIN's 331 rows recompute automatically — no row rewrite. Row counts unchanged (MAIN 331 / BUNKHOUSE 205 / PUMP 205). MAIN 2026-05-23 verified: 7.0 × 120 = 840 kWh. Data layer (`electricity/actions.ts`, `types/supabase.ts`) updated; `electricity-grid.tsx` UI refs left for the frontend engineer. `view_trucks_monthly` left intact (different table, unused but out of electricity scope). |

### Addendum — extractor-level behavior change (NO DB migration)

> **2026-06-29 · run-shift DEFAULT rule (ledger L-025).** This is a change to the **MC production_runs extractor + classifier only** — there is **NO schema/DB migration** (no new column, no constraint change; the `production_shifts.shift` `CHECK (shift IN ('M','E','N'))` and the `production_runs` natural key are untouched). Behavior: `extract_daily_production.py` now DEFAULTS a run row whose column-H shift is blank/absent/unrecognized (incl. the `STARTING`/`ENDING` batch-boundary markers of L-007) to **Morning (`M`)** instead of emitting `shift=null` (which the classifier marked MALFORMED). Evening (`E`) is set only when column H indicates it; an explicit `MORNING` label is not flagged. A defaulted row carries `_shift_defaulted=true` + a strippable `remarks` note (sentinel `SHIFT_DEFAULT_NOTE`, additive/write-only and stripped from the email side in `classify_production_runs.py::field_diff`, so already-written Morning rows stay `DUPLICATE_NOOP`). The **WEIGHT guard is preserved** — a run still missing `ttl_kg` still HOLDs/MALFORMED, as does a bad grade. Files: `extract_daily_production.py`, `classify_production_runs.py`. Supersedes the manual blank-shift recovery workflow of L-007/L-014 for the blank-shift sub-case only (those entries remain valid for batch-boundary `production_batch` derivation and `dt_mins≥60` splitting).

---

## 15. Phase 0.5 — Live source-email deep-read + verification (2026-05-29)

> **This section is the canonical build reference for the email extractors.** Everything below was read from the *actual* daily emails (not MASTER) and cross-checked against the live DB. Coordinates verified on the `05-27-26` and `05-28-26` MC sheets and the `MAY 2026` Ivy sheet.

### 15.1 The two source emails

| Email | Sender | Subject (exact) | Attachment | Workbook structure |
|---|---|---|---|---|
| Daily Production Report | `mccontinedo.ictc@gmail.com` | `Daily Production Report` | `Daily Production Report 2026 2Q.xlsx` (~744 KB) | **One sheet per production DAY**, title `MM-DD-YY` (often with trailing whitespace — strip it). 44 sheets for Q2. |
| WASTE PRODUCTION REPORT | `edilloivymae306ictc@gmail.com` | `WASTE PRODUCTION REPORT` | `WASTE PRODUCTION REPORT 2026.xlsx` (~38 KB) | **One sheet per MONTH**, title `MONTHNAME YYYY` (note leading space on some, e.g. `" APRIL 2026"`). Rows = days within the month. |

Fetch queries (Gmail X-GM-RAW, via `fetch_gmail.py`):
- MC: `from:mccontinedo.ictc@gmail.com subject:"Daily Production Report" after:{since} -label:"Blackwood-Processed"`
- Ivy: `from:edilloivymae306ictc@gmail.com subject:"WASTE PRODUCTION REPORT" after:{since} -label:"Blackwood-Processed"`

Both files are **consolidated/cumulative** (the latest email carries the whole 2026 file), so — like RC OUT — pick the LATEST attachment and process sheets/rows newer than the watermark.

### 15.2 MC email — scrape map (per day-sheet)

`transaction_date` = the **sheet title** (`MM-DD-YY`). Do NOT use cell `D4` (that's the next-morning write date).

**Section A — Production output → `production_runs`** (header row 7; data rows ~8–12):

| Cell | Meaning |
|---|---|
| `D{r}` | Grade with customer prefix, e.g. `CEBU 3X50` |
| `E{r}` | #sacks/bags |
| `F{r}` | #kilos per sack |
| `G{r}` | **TOTAL kg** (= E×F) → `ttl_kg` |
| `H{r}` | Shift label: `MORNING SHIFT` / `NIGHT SHIFT` (often blank, or a `STARTING`/`ENDING` batch-boundary marker — see run-shift default below) |
| `C13`,`G13` | `TOTAL` row, day total (CEBU only) — reconciliation check |

Routing: strip `CEBU ` → `grade`, `customer='CEBU'`. Bare grade (no prefix) → as-is. Allowlist (`VALID_GRADES`) = `3X50 / 6X50 / 8X50 / 2X6 / 4X8`. **DROP** `KOREA POWDER`, `LOCAL POWDER`, `ZAMBOANGA …` and any non-allowlist grade (out of v1 scope). Shift `NIGHT SHIFT → E`.

**Run-shift DEFAULT rule (extractor-level, added 2026-06-29 — ledger L-025).** Column `H{r}` is frequently blank/absent, or carries a `STARTING`/`ENDING` batch-boundary marker (L-007) rather than a shift word. `extract_daily_production.py::resolve_run_shift()` now resolves a run's shift deterministically:
- `H{r}` explicitly indicates **Evening** (maps to `E` via `SHIFT_LABEL_TO_CODE`: `NIGHT SHIFT`/`EVENING SHIFT`/`EVENING`/`NIGHT`/`AFTERNOON SHIFT`) → `shift='E'`.
- **Everything else** — blank, absent, unrecognized (incl. `STARTING`/`ENDING`), OR an explicit **Morning** label (`MORNING SHIFT`/`MORNING`) → `shift='M'` (default to Morning).

A blank-shift run is therefore **NO LONGER MALFORMED for "missing shift"** — it gets Morning by default and links to that date's `M` parent normally (this pushes the manual blank-shift recovery of L-007/L-014 into the extractor for the blank-shift sub-case). **The WEIGHT guard is preserved:** a run still missing `ttl_kg` (G{r}) is still held/MALFORMED, and a grade outside `{3X50,6X50,8X50,2X6,4X8}` is still MALFORMED — the shift default does NOT rescue a weightless or bad-grade row.

**Transparency marker.** When a run's shift was defaulted *because column H was blank/absent/unrecognized* (NOT when H explicitly said `MORNING`), the run dict carries `_shift_defaulted: true` AND the constant note `shift defaulted to Morning (operator left blank)` is written into the run's `remarks` (the audit trail a human reads to tell auto-defaulted rows from explicitly-marked ones). An explicit `MORNING` label sets no flag and adds no note. This note is **additive/write-only**: `classify_production_runs.py::field_diff` strips it from the email-side remarks before diffing, so a Morning row already in the DB without the note stays `DUPLICATE_NOOP` (idempotent), never a perpetual `VALUE_CHANGED`. The sentinel `SHIFT_DEFAULT_NOTE` is defined once in `extract_daily_production.py` and duplicated byte-identically in `classify_production_runs.py` (they must stay in sync). The `_shift_defaulted` flag is never part of any natural key or diff.

**Section B — Downtime → `production_downtime`** (left block ~rows 24–27):

| Cell | Meaning |
|---|---|
| `C24` | Category, e.g. `REPAIR` |
| `F25` | `DURATION` header |
| `C27` | Time-range(s), newline-separated (e.g. `8:00 AM-8:09 AM\n8:25 AM-…`) |
| `E27` | Duration value(s) in **MINUTES**, newline-separated (e.g. `9 MINUTES\n19 MINUTES`) |
| `F27` | Reason text (e.g. `CLEANED SCREENS RS 2A, RS 2B`) |

Aggregate: `dt_mins = sum(all event minutes)`, `dt_reason = category + " | " + joined reasons`. Write ONE row on the day's **M** shift. `shift_hrs` not cleanly present (`C26` holds an ambiguous integer like `7`) → **default `shift_hrs=12`**. Only create a row when downtime actually occurred.

**Section C — Trucks → `truck_readings`** (header row 46; data rows 47, 49, 51):

| Cell | Meaning |
|---|---|
| `C{r}` | Plate: `AAV 6111` (47), `KCA 378` (49), 3rd vehicle/FORKLIFT (51, plate may be blank) |
| `D{r}` | Departure meter reading → `start_km` |
| `E{r}` | Arrival meter reading → `end_km` |
| `F{r}` | Total distance traveled (`ttl_km`; generated = end−start) |
| `H{r}` | Liters issued → `fuel_liters` (when numeric) |
| `J{r}`,`K{r}` | Starting/arriving fuel **gauge** (qualitative, e.g. `more than 1/2`) → `remarks` |
| `L{r}` | Weekly Fuel Issued (liters) — weekly cumulative, decide use during build |

Sample days showed `F=0` (idle). Skip a truck row when no movement AND no fuel.

**Section D — Electricity MAIN → `electricity_readings` (meter `MAIN`)** (rows 53–60):

| Cell | Meaning |
|---|---|
| `D54` | PREVIOUS READING → `start_kwh` (raw) |
| `E54` | PRESENT READING → `end_kwh` (raw) |
| `F54` | KWH DIFFERENCE (raw, = E54−D54) |
| `E59`/`E60` | `METER MULTIPLIER` / value `120` → `meter_multiplier` |
| `F59`/`F60` | `CONSUMPTION (KWH)` = diff × 120 → equals generated `consumption_kwh` |

**Section E — Electricity BUNKHOUSE/PUMP** (rows 63–69): `A65=BUNKHOUSE`, `A67=PUMP`; `D=`prev, `E=`current, `F=`consumption. **Idle since 2025-12-12** (0/blank in 2026) — skip blank rows.

Deferred sections present in the email (NOT v1): charcoal fed (R21–26), PC stockpile (R30–34), RC tank level (R37–38), dump-truck refuse (R41), sundry (R71–74), magnet/ayag (R78–115), re-classify/blending/re-bagging/weight-adjust (R118–136).

### 15.3 Ivy email — scrape map (per month-sheet)

Header spans rows 2–4. `A{r}` = the day's date. Data rows start ~row 5.

| Stream | SACKS col (dropped) | **KLS col → schema** |
|---|---|---|
| R.S. #1 DUST (RS 1A) | B | **C → `rs1a_kg`** |
| RS 1B | D | **E → `rs1b_kg`** |
| FILTER | F | **G → `bf_kg`** |
| RS 2&3 | H | **I → `rs23_kg`** |
| R.S. 5 | J | **K → `rs5_kg`** |
| UNCOOKED/SHELL | L | **M → `trml1_kg`** |
| STONES | N | **O → `trml2_kg`** |
| GRIT | P | **Q → `grit_kg`** |
| TOTAL WASTE | — | R (reconciliation check) |
| buyer note | — | S (e.g. `PCG/BUNAWAN`) — informational |
| shift | — | V (`MORNING SHIFT`/`EVENING SHIFT`, only on dual-shift days) |

Per (date, shift) → one `production_waste` row. Shift: `V` MORNING→M, EVENING→**E**; **absent V** (pre-2026-05-25 single daily totals)→**M**. **Skip**: the first row if it's a prior-month carryover date (e.g. `2026-04-30` in the MAY sheet), the trailing `0` stub rows, and the bottom **column-sum footer** row (all KLS columns summed, large `R` grand total).

### 15.4 Verification — waste positional mapping is correct (8/8, two dates)

`extract_master_prod.py` (MASTER, schema names) vs Ivy email (KLS cols), exact values:

| Date | rs1a | rs1b | bf | rs23 | rs5 | trml1 | trml2 | grit | result |
|---|---|---|---|---|---|---|---|---|---|
| 2026-05-22 | 2159 | 1915 | 165 | 579 | 160 | 125 | 0.5 | 30 | **8/8 ✓** |
| 2026-05-23 | 2507 | 1814 | 175 | 526 | 95 | 125 | 0.5 | 27 | **8/8 ✓** |

Conclusion: MASTER's WASTE SUMMARY IS Ivy's email with renamed headers (FILTER=BF, UNCOOKED/SHELL=TRML1, STONES=TRML2). Positional mapping preserves both per-stream values and totals.

### 15.5 Live DB reality (queried 2026-05-29)

- **`production_shifts`:** `M=140`, `E=18`, `N=0`. → 2nd-shift `E` decision needs **no migration**.
- **`electricity_readings`:** `MAIN` 331 rows (2025-03-01 → 2026-05-23, **daily**); `BUNKHOUSE` 205 & `PUMP` 205 (both end 2025-12-12, idle since). MAIN 5/23 sample: `start=391.7 end=398.7 diff=7.0 rate=120` → 840 kWh. **Raw readings stored** → electricity rework is a clean rename + generated column, MAIN recomputes automatically.
- DB latest production date ≈ 2026-05-23; first email catch-up window = **5/24 → 5/28**.

### 15.6 Shift normalization (canonical)

| Source label | Operator | Canonical code |
|---|---|---|
| `MORNING SHIFT` | MC + Ivy | `M` |
| `NIGHT SHIFT` | MC | `E` |
| `EVENING SHIFT` | Ivy | `E` |
| (absent, single daily waste row) | Ivy pre-5/25 | `M` |
| (blank / absent / unrecognized **on a RUN row**, incl. `STARTING`/`ENDING`) | MC | `M` (DEFAULTED — flagged `_shift_defaulted`; ledger L-025) |
| (future 3rd shift) | — | `N` (reserved, unused) |

> **Run-shift default (L-025, 2026-06-29):** for MC **production_runs** rows, a blank/absent/unrecognized column H now defaults to `M` at extraction time (was previously emitted as `shift=null` → MALFORMED). Evening (`E`) is set only when column H indicates it. The defaulted row is marked `_shift_defaulted=true` + a strippable `remarks` note for transparency. The WEIGHT guard is unaffected — a run still missing `ttl_kg` still HOLDs. See §15.2 "Run-shift DEFAULT rule" for the full contract.

### 15.7 Remaining minor open items (non-blocking; sensible defaults chosen)

1. **`shift_hrs` for downtime** — email lacks a clean value; default `12`. Refine if MC starts reporting shift length.
2. **BUNKHOUSE/PUMP multiplier** — assumed `120` like MAIN (idle in 2026). Confirm if direct-read (multiplier 1) when they resume.
3. **Truck `fuel_liters`** — use `H` (Liters issued); `L` (Weekly Fuel Issued) is weekly-cumulative — decide whether to record. Gauge `J/K` → remarks.
4. **Truck 3rd vehicle (row 51)** — plate often blank (FORKLIFT?). Enumerate full plate list during build.
5. **Pre-5/25 Ivy single-row days** — waste attached to `M` (consistent with the downtime→M rule).
   **RESOLVED for MC runs 2026-06-29 (L-025):** a blank/absent/unrecognized run-row shift now defaults to `M` in the extractor (flagged `_shift_defaulted` + strippable note), instead of surfacing as a MALFORMED null-shift row for the agent to recover by hand. The WEIGHT-missing MALFORMED path is unchanged. (Waste-row absent-shift handling is separate and unchanged — Ivy's absent `V` still → `M`.)
6. **`--since YYYY-MM-DD` watermark filter (added 2026-05-29)** — both extractors (`extract_daily_production.py`, `extract_waste_production.py`) gained an optional `--since` flag that keeps only records dated *strictly after* the watermark (exclusive — the watermark is the latest already-ingested date, not re-ingested). The agent now passes `--since {watermark}` alongside `--all-sheets`, so the cumulative workbooks (MC's quarter, Ivy's year) are filtered deterministically Python-side instead of in agent prose. Fixes the cumulative-workbook window bug found in the 2026-05-29 e2e test: without it the classifier's DB comparison window ballooned to ~5 months and 74 historical null-shift rows surfaced as MALFORMED noise. Omitting `--since` preserves the full-history backfill behavior unchanged.

---

## 16. Production Manager agent (built 2026-05-29)

The orchestration "brain" now exists: **`.claude/agents/production-manager.md`** — the third ICTC ingestion employee, alongside `deliveries-manager.md` and `rc-out-manager.md`. It coordinates the 8 Python tools in §5 + Supabase MCP into the email→DB pipeline. Built mirroring the `rc-out-manager.md` template (frontmatter, PROPOSE/EXECUTE split, pre-flight, error table, operating principles).

**Scope:** six tables from two emails — `production_shifts` (parent) + `production_runs` / `production_downtime` / `production_waste` (children) + `electricity_readings` / `truck_readings` (independent). Sources: MC `Daily Production Report` (runs/downtime/electricity/trucks) + Ivy `WASTE PRODUCTION REPORT` (waste).

**Modes:** PROPOSE (default — fetch + extract + classify 5 types + informational reconcile + summary, no writes) / EXECUTE (upsert shifts → insert children + electricity + trucks → audit logs → Gmail label).

**Five rules baked into the agent:**
1. Reconciliation is INFORMATIONAL — NEVER halts on drift (opposite of rc-out-manager; §8 feed-tank reason).
2. `production_shifts` upserted before any child (children FK to `shift_id`; §6).
3. Null-shift / MALFORMED rows are surfaced, NEVER auto-written.
4. `customer` is real — CEBU default, KURARAY legitimate (§12); KOREA/LOCAL/ZAMBOANGA powder already dropped by the extractor.
5. Electricity `meter_multiplier` (120) is a meter factor, not a peso rate; `consumption_kwh` is a generated column — never written (§13/§14).

Idempotency = DB watermark (`MAX(transaction_date) FROM production_shifts`) + Gmail `Blackwood-Processed` label. New agent files don't load mid-session — Renzo must restart Claude Code to register `production-manager` as a named subagent (test via `general-purpose` proxy until then). Next: §11 Phase 8 — first end-to-end test against the 5/24→present catch-up window.
