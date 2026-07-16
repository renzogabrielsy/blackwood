# Cenapro Production — Data Source Analysis

> **Status:** ANALYSIS ONLY. No code, schema, migration, agent, or DB was created or modified to produce this document. This is the knowledge base that will inform a future, deliberately-separate Cenapro tenant on the Blackwood platform.
>
> **Source file:** `/Users/renzosy/Documents/1A WORK FILES/PRODUCTION/2025 CI PRODUCTION V2.xlsb`
> **Format:** Excel **Binary Workbook (.xlsb)** — read via Python `pyxlsb` (LibreOffice `soffice` not installed; binary read used directly). File never modified.
> **Analyzed:** 2026-06-01
> **Size:** ~2.16 MB, 12 sheets.

---

## 0. Critical framing — Cenapro is a SEPARATE tenant from ICTC

This workbook is **Cenapro's** (the main company's) production log. It is a **different tenant/domain** from ICTC charcoal operations (RC IN / RC OUT / Blocking / Production already live in Blackwood). Per the hard separation requirement:

- ICTC's email/Gmail fetching + Google-Sheet sync agents (`deliveries-manager`, `rc-out-manager`, `production-manager`, `gsheet-sync`, etc.) stay **ICTC-only**. None of them should ever touch Cenapro data.
- Cenapro gets its **own** domain module, its **own** adapters, and (recommendation) its **own** Postgres schema namespace. It plugs into the platform layer the same way ICTC does — through normalized widget interfaces — but shares **zero** business logic with ICTC.
- **Scope for now:** production + product (FLECON / Prepared Charcoal) inventory only. Nothing beyond those two domains is requested yet.

**Vocabulary note (do not confuse with ICTC):** Cenapro and ICTC use overlapping words with *different* meanings. Both say "WHSE", "GRADE", "SHIFT", "FLEC". They are NOT the same warehouses, grades, or codes. Keep the namespaces physically separate to avoid cross-contamination.

---

## 1. Workbook Overview

12 sheets. **3 are deliberately EXCLUDED** from analysis per instruction (their existence is noted; contents were not analyzed beyond a one-line header peek to confirm identity).

| # | Sheet | Approx size (rows × cols, data) | Type | Purpose (one line) |
|---|-------|------------------|------|---------|
| 0 | `DVO OUT` | 653 data rows × 5 cols | Raw table | Davao (DVO) warehouse **outflow** log — daily charcoal pulled out, by aged lot ("SIDE"). |
| 1 | `W6 Summary` | ~244 non-empty rows × up to 34 cols | **Pivot/report** | Plant **W6** production rollup — TWO side-by-side pivots (daily detail block + monthly rollup), CCC-bucket columns. Computed from `Production`. |
| 2 | `W7 Summary` | ~169 non-empty rows × 17 cols | **Pivot/report** | Plant **W7** production rollup — same shape as W6 Summary. Computed from `Production`. |
| 3 | `Production` | **906 weight-bearing rows** (1166 incl. blanks/legend) × 15 cols | **Raw master ledger** | The core event log: each production/transfer movement (date, batch-month, shift, grade, plant, warehouse, source, weight, CCC/FLEC classification). **This is the spine of the whole workbook.** |
| 4 | `PC WHSE 7` | 102 data rows × 13 cols | Raw table | **Prepared-Charcoal (FLECON) inventory** ledger for Warehouse 7 — IN/OUT events with running balance. Most-populated of the PC sheets. |
| 5 | `PC WHSE 1` | ~4 data rows × 13 cols | Raw table | Same structure as PC WHSE 7, Warehouse 1. Nearly empty (newly started). |
| 6 | `PC WHSE 2` | ~2 data rows × 13 cols | Raw table | Same structure, Warehouse 2. Nearly empty. |
| 7 | `PC W3` | ~2 data rows × 13 cols | Raw table | Same structure, Warehouse 3. Nearly empty. |
| 8 | `PC WHSE 5` | ~61 data rows × 13 cols | Raw table | Same structure, Warehouse 5. Moderately populated. |
| 9 | `PC W3 - DVO` | 377 × 63 | **EXCLUDED** | **NOT ANALYZED** (per instruction). Header is a row of aged-lot labels (OCTOBER2023LEFT, JANUARY2024RIGHT, …) — appears to be a wide DVO-lot cross-tab. Noted only. |
| 10 | `PC WA7 - DVO` | 377 × 28 | **EXCLUDED** | **NOT ANALYZED** (per instruction). Header is aged-lot labels (JUNE2017LEFT, NOVEMBER2018…). Noted only. |
| 11 | `DVO IN` | 3245 × 22 | **EXCLUDED** | **NOT ANALYZED** (per instruction). First row mentions IN COUNT / OUT COUNT / FOR PULLOUT — a DVO intake ledger. Noted only. |

> The 3 excluded sheets **all relate to DVO (Davao) inventory detail**. They were skipped as requested. If the Cenapro scope later expands to full DVO lot tracking, they become the next analysis target.

**Sheets ANALYZED:** `DVO OUT`, `W6 Summary`, `W7 Summary`, `Production`, `PC WHSE 7`, `PC WHSE 1`, `PC WHSE 2`, `PC W3`, `PC WHSE 5` (9 sheets).
**Sheets EXCLUDED (noted, not analyzed):** `PC W3 - DVO`, `PC WA7 - DVO`, `DVO IN` (3 sheets).

---

## 2. Per-Sheet Structure

### 2.1 `Production` — master event ledger (RAW)

**The most important sheet.** Single header row at **r0**; **rows 1–8 are a dropdown/legend block** (lists valid SHIFT, GRADE, and CCC codes — NOT data); **real data begins at r11**. Daily batches are separated by **1–2 fully blank rows** (244 blank rows interspersed across the sheet). Data runs to ~r1121.

**Header (r0), left→right:**

| Col | Header | Type | Meaning | Example |
|-----|--------|------|---------|---------|
| 0 | `CCC RECV` | date (Excel serial) | Date charcoal received / movement recorded. Range **45992–46170 = 2025-12-01 → 2026-05-28**. | `45992` → 2025-12-01 |
| 1 | `PROD DATE` | date (Excel serial) | Production date of the batch being moved (often earlier than CCC RECV). Range from **45989 = 2025-11-28**. | `45989` → 2025-11-28 |
| 2 | `BATCH` | text (month name) | Batch-month label — the production campaign. **7 distinct: NOVEMBER, DECEMBER, JANUARY, FEBRUARY, MARCH, APRIL, MAY.** | `DECEMBER` |
| 3 | `SHIFT` | enum | Work shift. Dominant `M` (856); legend declares **M / E / N** (Morning/Evening/Night). Dirty values seen: `M,`, ` M`. | `M` |
| 4 | `GRADE` | enum | Product grade/size. **3X50** (753), **2X6** (113), **3.5** (50), **4X8** (1). Legend also lists `4X8`. | `3X50` |
| 5 | `PLANT` | enum | Producing plant. **W6** (447), **W7** (204), **DVO** (145), **W6 / W7** (114). Dirty: `W`, `37.0`, `W6 /W7`. | `W6` |
| 6 | `WHSE` | enum | Destination warehouse. **W6, WHSE 7, WHSE 3, W7, WHSE 5, WHSE 1** (note inconsistent `W6`/`WHSE 7` naming). | `WHSE 7` |
| 7 | `SRC` | enum | Source vessel/area. **FLEC** (196), **W7** (163), **TNK 1/2/3/4** (tanks), **DVO** (145), **W6**. | `TNK 2` |
| 8 | `WT` | number (kg) | Weight moved, kilograms. Range **567 – 139,917**; total across sheet **13,249,762 kg**. | `26156` |
| 9 | `CCC / FLEC` | enum | Charcoal classification bucket. **C1** (425), **FLEC** (283), **C2** (89), **RK4** (64), **RK2** (28), **RK3** (27), plus **RK1, C3, C4**. Legend declares C1–C4, RK1–RK4. Dirty: `FLEC ` (trailing space). | `C1` |
| 10 | `FLEC AMT` | number | FLECON sack/unit count (only on FLECON rows). Range 1–647; populated 462/906. | `42` |
| 11 | `WHSE SIDE` | text | Physical side of warehouse / aged-lot tag. **RS** (Right Side, 106), **LS** (Left Side, 54), plus aged-lot labels like `NOVEMBER2025RIGHT`, `SEPTEMBER2025LEFT`. | `RS` |
| 12 | `FLEC STAT` | enum | FLECON status. Single value seen: **`DONE`** (360 rows). | `DONE` |
| 13 | `DVO SIDE` | text | **Empty in all data rows** (0 fills) — a defined-but-unused column. | *(empty)* |
| 14 | `UNIQUE TAG` | text (derived) | Composite natural key, dash-joined from other columns. **908 distinct / 909 — effectively unique.** | `45992-45989-NOVEMBER-M-3X50-W6-W6--TNK 2-C1` |

**`UNIQUE TAG` decoded:** `{CCC_RECV}-{PROD_DATE}-{BATCH}-{SHIFT}-{GRADE}-{PLANT}-{WHSE}-{DVO_SIDE}-{SRC}-{CCC_FLEC}` (the empty DVO_SIDE leaves the `--` double-dash). This is almost certainly a **formula-built concatenation** the operator uses to dedupe.

- **Formulas:** `UNIQUE TAG` is a concatenation formula. `pyxlsb` returns computed values, so the literal formula text isn't surfaced, but the column is clearly derived from the same-row cells.
- **Merged cells / totals:** No in-sheet totals row. Blank rows are visual separators between days, not subtotals.
- **Raw vs report:** **RAW** — one row per physical charcoal movement.

---

### 2.2 `PC WHSE 7` / `PC WHSE 1` / `PC WHSE 2` / `PC W3` / `PC WHSE 5` — Prepared-Charcoal (FLECON) inventory ledgers (RAW)

**All five share an identical layout** (verified header-by-header). Each sheet = one physical warehouse's prepared-charcoal stock ledger.

**Top block (rows 0–12) — a small status/starting-inventory panel, NOT the data table:**
- r0: `START:` → an Excel-serial date (all five = `46091` = **2026-03-10**, the inventory baseline date).
- r1: `WHSE:` → warehouse name (`WHSE 7`, `WHSE 1`, `WHSE 2`, `W3`, `WHSE 5`).
- r2: `FLECON` (section label).
- r3–r11: a tiny starting-balance matrix by GRADE (`3X50`, `2X6`) × side (`RS` / `LS`) with a `STARTING` sub-block. Hand-maintained opening counts.

**Real data table — header at r13, data from r14:**

| Col | Header | Type | Meaning | Example |
|-----|--------|------|---------|---------|
| 0 | `UNIQUE TAG` | text (derived) | Composite key, e.g. `46091-46091-MARCH`. Built from RECV+PROD date + batch-month. | `46091-46091-MAR…` |
| 1 | `RECV DATE` | date serial | Receive date into this warehouse. | `46091` → 2026-03-10 |
| 2 | `PROD DATE` | date serial | Production date of the lot. | `46091` |
| 3 | `SRC` | enum | Source. **FLEC, W7, TNK 1/2/3/4** (same vocabulary as Production.SRC). | `TNK 2` |
| 4 | `GRADE` | enum | **3X50, 2X6**. | `3X50` |
| 5 | `SIDE` | enum | **RS / LS** (Right/Left side of warehouse). | `RS` |
| 6 | `TAG` | text (derived) | `{GRADE}-{SIDE}`, e.g. `3X50-RS`, `2X6-LS`. | `3X50-RS` |
| 7 | `STATE` | enum | Movement direction. **IN / OUT** (in WHSE 7: 51 IN / 51 OUT — balanced). | `IN` |
| 8 | `KG IN` | number (kg) | Weight in (only on STATE=IN rows). WHSE 7 range 1,604–139,917. | `17501` |
| 9 | `KG OUT` | number (kg) | Weight out (only on STATE=OUT rows). WHSE 7 range 4,370–29,783. | `10716` |
| 10 | `FLEC IN` | number | FLECON unit/sack count in. | `33` |
| 11 | `FLEC OUT` | number | FLECON unit/sack count out. | `20` |
| 12 | `RUN BAL` | number (derived) | **Running balance** — likely a formula (cumulative KG IN − KG OUT, or FLEC count). | `86` |

- **Formulas:** `RUN BAL`, `UNIQUE TAG`, `TAG` are derived (running balance is the classic spreadsheet-formula column).
- **Merged cells:** the top status block (rows 0–11) uses label/value pairs that read like light merges; the data table itself is flat.
- **Data volume is uneven:** WHSE 7 (102 rows) and WHSE 5 (61) are real; WHSE 1/2/W3 have only 2–4 rows — these warehouses are newly opened (all START = 2026-03-10). The structure is identical and ready to fill.
- **Raw vs report:** **RAW** — one row per IN or OUT movement, with a maintained running balance.

---

### 2.3 `W6 Summary` & `W7 Summary` — production pivots/reports (DERIVED)

**These are report sheets, not data sources.** Each contains **two side-by-side pivot blocks** built off `Production`:

**Left/main block (cols ~0–16):** a vertical, grouped daily roll-up. Pattern per day:
- A `BATCH`/date header (Excel serial, e.g. `46019` with year label `2025`/`2026`),
- one row per `(SHIFT, GRADE, TNK)` combination with the weight landing in the matching CCC-bucket column,
- a **`{M/D/YY} Total`** subtotal row,
- and at the very bottom a **`{MONTH} Total`** grand-total row (e.g. `W6 Summary` r344: `MAY Total` → C1 159,438 / C2 41,000 / FLEC 161,717 / **Grand Total 362,155**).

**Right block (cols ~18–33, `W6 Summary` only — wider):** a flatter pivot labelled `PLANT W6`, headered `DATE | BATCH | TNK | SHIFT | GRADE | C1 | C2 | C3 | C4 | RK1 | RK2 | RK3 | RK4 | FLEC | TTL`. Same CCC-bucket columns, one row per movement.

**Bucket columns (both summaries):** `C1, C2, C3, C4, RK1, RK2, RK3, RK4, FLEC, Grand Total` — these mirror `Production.CCC / FLEC`. The summaries simply **pivot `Production.WT` by date × shift × grade × CCC-bucket**.

- **Formulas:** heavily formula/pivot-driven (SUMIFS or a manual pivot). Subtotal and grand-total rows are computed.
- **Raw vs report:** **REPORT** — do **not** ingest these as a source of truth. They are a **validation cross-check** against an aggregate computed from `Production` (analogous to how ICTC's Blocking tab is cross-check-only, never ingested).

---

### 2.4 `DVO OUT` — Davao warehouse outflow log (RAW)

Header at **r7**: `DATE | REMARKS | AMOUNT | WHSE | SIDE`. Data r8 → r674 (653 rows).

| Col | Header | Type | Meaning | Example |
|-----|--------|------|---------|---------|
| 0 | `DATE` | date serial | Outflow date. Range **45308–46009 = 2024-01-17 → 2025-12-18**. | `45308` → 2024-01-17 |
| 1 | `REMARKS` | text (sparse) | Free note, only 5 rows. Values: `LAST OUT`, `START 30T`, `=`. | `LAST OUT` |
| 2 | `AMOUNT` | number (kg) | Weight pulled out. Range 0–32,149. | `5526` |
| 3 | `WHSE` | text | Always `WHSE 3` (one typo `WGSE 3`). DVO = Davao site, Warehouse 3. | `WHSE 3` |
| 4 | `SIDE` | enum (aged lot) | The aged inventory lot being drawn down, formatted `{MONTH}{YEAR}{LEFT/RIGHT}`. **8 distinct**: JANUARY2024RIGHT (254), OCTOBER2023LEFT (107), JULY2024LEFT (105), JUNE2025LEFT (59), MARCH2025LEFT (44), JULY2025RIGHT (38), SEPTEMBER2025LEFT (31), NOVEMBER2025RIGHT (14). | `OCTOBER2023LEFT` |

- **Formulas:** none obvious; looks hand-entered.
- **Raw vs report:** **RAW** — one row per DVO outflow event. The `SIDE` aged-lot vocabulary is the **same lot-naming scheme** used in the excluded `PC W3 - DVO` / `PC WA7 - DVO` sheets and in `Production.WHSE SIDE`, confirming DVO lots are a shared dimension across the workbook.

---

## 3. Entity & Relationship Model

### Inferred logical entities

| Entity | Grain | Natural key | Source sheet(s) |
|--------|-------|-------------|-----------------|
| **Production Movement** | One charcoal movement/transfer event (a tank emptied into a warehouse, a FLECON run, etc.) | `UNIQUE TAG` = `(ccc_recv_date, prod_date, batch_month, shift, grade, plant, whse, dvo_side, src, ccc_bucket)` | `Production` |
| **Prepared-Charcoal (FLECON) Inventory Movement** | One IN or OUT of finished prepared charcoal at a specific warehouse | `(warehouse, unique_tag, state, recv_date)` where unique_tag = `(recv_date, prod_date, batch_month)` | `PC WHSE 1/2/5/7`, `PC W3` |
| **DVO Outflow** | One outflow event from Davao WHSE 3 | `(date, side_lot, amount)` | `DVO OUT` |
| **Warehouse** (dimension) | A physical warehouse | name (`W6`, `W7`, `WHSE 1/2/3/5/7`) — *naming is inconsistent; needs canonicalization* | referenced everywhere |
| **Plant** (dimension) | A producing plant line | `W6`, `W7`, `DVO`, `W6 / W7` | `Production.PLANT` |
| **Grade** (dimension) | Product size/grade SKU | `3X50`, `2X6`, `3.5`, `4X8` | `Production.GRADE`, PC sheets |
| **CCC Bucket** (dimension) | Charcoal classification | `C1–C4`, `RK1–RK4`, `FLEC` | `Production.CCC/FLEC`, summaries |
| **Source vessel** (dimension) | Tank or area a movement came from | `TNK 1–4`, `FLEC`, `W6`, `W7`, `DVO` | `Production.SRC`, PC sheets |
| **Shift** (dimension) | Work shift | `M`, `E`, `N` | `Production.SHIFT` |
| **Aged Lot / "SIDE"** (dimension) | A dated, sided inventory lot (esp. DVO) | `{MONTH}{YEAR}{LEFT\|RIGHT}` | `DVO OUT.SIDE`, `Production.WHSE SIDE`, excluded DVO sheets |

### Relationships (text ER)

```
                         ┌─────────────────────┐
                         │   Plant (W6/W7/DVO)  │
                         └──────────┬──────────┘
                                    │ produces (1:N)
                                    ▼
   Shift ───┐               ┌──────────────────────────┐             ┌─── Grade (3X50/2X6/3.5/4X8)
   (M/E/N)  ├──classifies──►│   PRODUCTION MOVEMENT     │◄──tagged────┤
   Source ──┤               │   (Production sheet)      │             └─── CCC Bucket (C1-4/RK1-4/FLEC)
   (TNK n)  ┘               │   PK: UNIQUE TAG          │
                            └───────────┬──────────────┘
                                        │ lands product in (N:1)
                                        ▼
                         ┌───────────────────────────┐
                         │   Warehouse (W6/7/1/2/3/5) │
                         └───────────┬───────────────┘
                                     │ holds (1:N)
                                     ▼
                  ┌──────────────────────────────────────────┐
                  │  PREPARED-CHARCOAL INVENTORY MOVEMENT       │
                  │  (PC WHSE n sheets) — STATE IN/OUT + RUN BAL│
                  │  one ledger PER warehouse                  │
                  └──────────────────────────────────────────┘

   DVO site (WHSE 3) ──draws-down──► Aged Lot "SIDE" ({MONTH}{YEAR}{L/R})
                                          ▲
                                          │ same lot vocabulary
   DVO OUT (outflow log) ────────────────┘   also appears in Production.WHSE SIDE
                                              and excluded DVO sheets

   W6 Summary / W7 Summary  ──── PIVOT/derived from ────►  PRODUCTION MOVEMENT
   (reports, NOT a source; use as cross-check only)
```

**Cross-sheet links (concrete):**
- `Production.WHSE` → `PC WHSE n` sheet (a movement into WHSE 7 should appear as a `KG IN` row in `PC WHSE 7`). **Cardinality 1:N** (Production is the upstream event; PC ledger is the per-warehouse landing).
- `Production.SRC` / `PC.SRC` share the **same vocabulary** (`TNK 1–4`, `FLEC`, `W6`, `W7`, `DVO`) — a shared Source dimension.
- `Production.CCC / FLEC` ⇄ `W6/W7 Summary` bucket columns (`C1…FLEC`) — the summaries are `SUM(WT) GROUP BY date, shift, grade, ccc_bucket`.
- `Production.WHSE SIDE` ⇄ `DVO OUT.SIDE` ⇄ excluded DVO sheets — shared **aged-lot** dimension (`{MONTH}{YEAR}{LEFT/RIGHT}`).
- `Grade` (`3X50`, `2X6`) is shared between `Production` and the `PC WHSE n` ledgers.

**Note on `UNIQUE TAG` as a key:** it is operator-built and **brittle** — it embeds free-text columns that have dirty variants (`M,`, `W6 /W7`, `FLEC `). 908/909 distinct means it *currently* dedupes, but it is not a stable surrogate key. A real schema should mint its own PK and treat `UNIQUE TAG` as an imported, advisory natural key.

---

## 4. How Cenapro's method differs from ICTC

| Dimension | **ICTC** (existing Blackwood tenant) | **Cenapro** (this file) |
|-----------|--------------------------------------|--------------------------|
| **Delivery vehicle** | Daily **report emails** (Gmail) with XLSX attachments + a link-shared **Google Sheet** that is now source-of-truth. Multiple report types from multiple senders. | A **single, self-contained `.xlsb` workbook** maintained by hand. One file, 12 tabs, all interlinked. No email pipeline, no per-day attachments. |
| **Update cadence** | Per-email, near-daily; agents poll Gmail / re-fetch the Sheet and diff. | **Workbook-snapshot.** The whole file is re-saved as it's edited. No event stream — you ingest the current state of the file and diff against last snapshot. |
| **Grain** | Normalized per-table (deliveries, rc_out, production_shifts/runs/downtime/waste, …) with explicit FKs and triggers maintaining `current_weight`. | **Spreadsheet-grain.** `Production` is one flat event ledger keyed by a concatenated `UNIQUE TAG`; inventory is per-warehouse ledgers with hand-maintained `RUN BAL`. Derived totals live in pivot tabs, not views. |
| **Identifiers** | `batch_code` text linking (JAN/FEB/MARCH… month-prefix conventions), UUID PKs, `block_loc` = `{WHSE}-{COL}{ROW}`. | `BATCH` = bare **month name** (NOVEMBER…MAY); `UNIQUE TAG` = dash-concatenated composite; warehouses named inconsistently (`W6` vs `WHSE 7`); lots named `{MONTH}{YEAR}{LEFT/RIGHT}`. |
| **Source of truth** | Google Sheet (RC IN/OUT) + emails (production, pricing). Blocking = cross-check only. | The `.xlsb` itself. Within it, `Production` + `PC WHSE n` are truth; `W6/W7 Summary` are derived cross-checks. |
| **Derived state** | DB triggers + SQL views (`view_rc_movement`, `view_blocking_grid`) compute balances. **Rule: never compute balances in app code.** | Balances/totals are **Excel formulas** (`RUN BAL`, summary subtotals, `UNIQUE TAG`). Moving to Blackwood means **re-deriving these in SQL views** rather than ingesting the spreadsheet's computed cells. |
| **Domain** | Raw-charcoal receiving → feed tank → consumption → blocking grid (220 slots, 4 warehouses A–D). | **Finished/prepared-charcoal production & FLECON warehousing** across plants W6/W7/DVO into warehouses 1/2/3/5/7, plus aged-lot DVO drawdown. Different physical operation entirely. |

**Single biggest structural difference:** ICTC is a **multi-source streaming/event** architecture (emails + a live Google Sheet, diffed continuously, normalized into many FK-linked tables). Cenapro is a **single hand-maintained multi-tab workbook snapshot** whose tabs are interlinked by **brittle concatenated keys and Excel formulas** — there is no event stream and no relational integrity; the relationships live implicitly in shared text vocabularies across tabs.

---

## 5. "Coco" project findings

**NOT FOUND as a code project.** Searched, with negative results:

- `find ~ -maxdepth 4..6 -iname "*coco*" -type d` → only **PDF documents** about "coco shell by-product" / "self-heating coco byproduct" charcoal material (`CI - Self Heating Coco Byproduct…pdf`, `CI COCO BY-PRODUCT…pdf`, an MSDS PDF). These describe a raw-material lab/safety topic — **not an app**.
- `~/Documents`, `~/Desktop`, `~/code`, `~/projects`, `~/dev`, `~/repos`, `~/src` for directories named `coco` / `coco-*` / `*-coco` → **none** (excluding `node_modules`).
- `package.json` / `schema.prisma` / `*.sql` / `*.ts` / `*.tsx` / `*.py` mentioning **`coco`** or **`cenapro`** anywhere under `~` (excluding `node_modules`/`Library`) → **none**. The only `cenapro`/`coco` substring hits were unrelated dependency package names (`picocolors`, `yoctocolors-cjs`) and an Antigravity VS Code Java-test extension.
- No VS Code `workspaceStorage`, no Antigravity workspace JSON, no sibling Supabase `migrations` dir referencing Cenapro.

**Conclusion:** There is **no discoverable "coco" codebase, schema, or migration set on this machine** to mine for domain context. If it exists, it is in a remote repo or another machine not searched here. **The entity/relationship model above is inferred purely from the workbook**, not from any coco artifact. → *User input needed (see §7) to confirm whether coco exists elsewhere and what its schema looks like.*

---

## 6. Proposed schema direction for Blackwood (FIRST DRAFT — not built)

### Tenancy / placement

- **Dedicated Postgres schema:** `cenapro` (e.g. `cenapro.production_movements`). Keeps it physically isolated from ICTC's `public` tables and from ICTC's sync agents. (Alternative: a `tenant` discriminator column — **not recommended** here; the domains share no columns and separate schemas make the hard-separation rule self-enforcing.)
- **Platform plug-in:** Cenapro becomes its own **domain module** (`app/(app)/cenapro/…` — production page + FLECON inventory page) and its own **adapter set** (`lib/widgets/adapters/cenapro-*.ts`) that fill the SAME data-agnostic widget interfaces (`ChartConfig`, `KPIData`, etc.). **Widgets need zero changes** — exactly the Grafana-style ports model. Cenapro adapters must live alongside, never inside, the ICTC charcoal adapters.
- **Ingestion** (future, separate decision): a **Cenapro-only** sync employee that reads the `.xlsb` snapshot (or a converted xlsx), diffs against the DB, and proposes NEW/CHANGED/NOOP — structurally like ICTC's `gsheet-sync` but with **its own scripts, its own agent file, and no shared code**. Do **not** reuse ICTC extractors.

### Draft tables

**Dimension / lookup tables** (small, canonicalize the dirty enums):

```
cenapro.plants            (code PK: 'W6'|'W7'|'DVO'|'W6/W7', display_name)
cenapro.warehouses        (code PK: 'W1'|'W2'|'W3'|'W5'|'W7'..., display_name, site 'CEBU'|'DVO')
cenapro.grades            (code PK: '3X50'|'2X6'|'3.5'|'4X8', display_name)
cenapro.ccc_buckets       (code PK: 'C1'..'C4'|'RK1'..'RK4'|'FLEC', kind 'C'|'RK'|'FLEC')
cenapro.sources           (code PK: 'TNK1'..'TNK4'|'FLEC'|'W6'|'W7'|'DVO')
-- shift + side modeled as enums:
enum cenapro.shift        = ('M','E','N')
enum cenapro.whse_side    = ('RS','LS')
enum cenapro.move_state   = ('IN','OUT')
```

**Fact table 1 — production movements** (`Production` sheet):

```
cenapro.production_movements
  id              uuid  PK  (minted; NOT the spreadsheet tag)
  ccc_recv_date   date  NOT NULL          -- col CCC RECV
  prod_date       date                    -- col PROD DATE (nullable)
  batch_month     text  NOT NULL          -- col BATCH ('NOVEMBER'… ; consider FK to a campaign table)
  shift           cenapro.shift           -- normalized from 'M'/' M'/'M,'
  grade_code      text  FK→grades
  plant_code      text  FK→plants
  whse_code       text  FK→warehouses     -- normalized 'WHSE 7'→'W7' etc.
  source_code     text  FK→sources        -- col SRC
  weight_kg       numeric(12,2) NOT NULL  -- col WT
  ccc_bucket_code text  FK→ccc_buckets    -- col CCC / FLEC
  flec_amt        numeric                 -- col FLEC AMT (nullable)
  whse_side       text                    -- col WHSE SIDE (RS/LS or aged-lot tag)
  flec_status     text                    -- col FLEC STAT ('DONE')
  dvo_side        text                    -- col DVO SIDE (currently always null)
  unique_tag      text  UNIQUE            -- imported advisory natural key
  source_row      int                     -- provenance: original sheet row
  provenance      text  DEFAULT 'cenapro_xlsb'
  created_at / updated_at
  -- natural-key UNIQUE on (ccc_recv_date, prod_date, batch_month, shift, grade_code,
  --                        plant_code, whse_code, source_code, ccc_bucket_code)
```

**Fact table 2 — prepared-charcoal inventory movements** (`PC WHSE n` sheets, unified):

```
cenapro.pc_inventory_movements
  id              uuid PK
  warehouse_code  text FK→warehouses   NOT NULL   -- which PC sheet
  recv_date       date NOT NULL                   -- col RECV DATE
  prod_date       date                            -- col PROD DATE
  src_code        text FK→sources                 -- col SRC
  grade_code      text FK→grades                  -- col GRADE
  side            cenapro.whse_side               -- col SIDE (RS/LS)
  state           cenapro.move_state NOT NULL     -- col STATE (IN/OUT)
  kg_in           numeric(12,2)                   -- col KG IN
  kg_out          numeric(12,2)                   -- col KG OUT
  flec_in         numeric                         -- col FLEC IN
  flec_out        numeric                         -- col FLEC OUT
  unique_tag      text                            -- advisory
  source_row      int
  provenance      text DEFAULT 'cenapro_xlsb'
  created_at / updated_at
  -- DO NOT store RUN BAL. Recompute as a window function in a view.
  -- natural-key UNIQUE on (warehouse_code, unique_tag, state, recv_date, grade_code, side)
```
*Plus the per-warehouse opening/`STARTING` balances (PC top block, rows 3–11) → a small `cenapro.pc_opening_balances(warehouse_code, grade_code, side, starting_qty, as_of_date)`.*

**Fact table 3 — DVO outflow** (`DVO OUT` sheet):

```
cenapro.dvo_outflows
  id          uuid PK
  out_date    date NOT NULL          -- col DATE
  amount_kg   numeric(12,2)          -- col AMOUNT
  warehouse   text DEFAULT 'WHSE 3'  -- col WHSE (canonicalize 'WGSE 3' typo)
  side_lot    text NOT NULL          -- col SIDE ({MONTH}{YEAR}{LEFT/RIGHT})
  remarks     text                   -- col REMARKS (sparse)
  source_row  int
  provenance  text DEFAULT 'cenapro_xlsb'
  -- natural-key UNIQUE on (out_date, side_lot, amount_kg)
```

**Views (re-derive what Excel computed):**
- `cenapro.view_pc_running_balance` — window `SUM(kg_in - kg_out) OVER (PARTITION BY warehouse_code, grade_code, side ORDER BY recv_date)` → replaces `RUN BAL`.
- `cenapro.view_production_daily` — pivot of `production_movements` by `(date, shift, grade, ccc_bucket)` → reproduces W6/W7 Summary, used as a **cross-check** against the spreadsheet's own summary tabs.

**Adapters (platform plug-in):**
- `lib/widgets/adapters/cenapro-production.ts` → `ChartConfig` / `KPIData` from `view_production_daily`.
- `lib/widgets/adapters/cenapro-pc-inventory.ts` → warehouse-occupancy-style data from `view_pc_running_balance`.

### What must be LOCKED before building

1. **Warehouse canonicalization** — is `W6` (in `Production.WHSE`) the same physical warehouse as one of the `PC WHSE n` sheets, or a plant tank-farm distinct from the numbered storage warehouses? The `WHSE` column mixes `W6`/`W7` with `WHSE 1/2/3/5/7`.
2. **`BATCH` semantics** — confirm a bare month name (`MAY`) is the full batch identity, or whether month+year (e.g. there are both 2025 and 2026 `JANUARY` rows in the summaries) is required. This affects the natural key.
3. **Grade `3.5`** — is it a distinct SKU or shorthand for `3.5X…`? And `4X8` (1 row) — real grade or typo?
4. **`CCC` vs `FLEC` vs `RK`** — confirm the meaning (C1–C4 = quality classes? RK = "re-cook"/rework? FLEC = FLECON finished product?). Drives whether these are quality grades or process stages.
5. **Whether to ingest the 3 excluded DVO sheets later** (full lot tracking) — out of current scope but they hold the DVO aged-lot detail that `DVO OUT` only summarizes.

---

## 7. Open Questions / Risks

**Data-quality issues found (evidence-based):**
- **Dirty enum values** in `Production`: `SHIFT` has `M,`, ` M`; `PLANT` has `W`, `37.0`, `W6 /W7`; `CCC/FLEC` has `FLEC ` (trailing space). Any extractor must trim + canonicalize, and route unmappable values to an UNMAPPED bucket (mirrors ICTC's "never auto-create" rule).
- **Inconsistent warehouse naming**: `W6`/`WHSE 7`/`W7` used interchangeably across `Production.WHSE`; `DVO OUT.WHSE` has a `WGSE 3` typo.
- **`UNIQUE TAG` is brittle** — built from free-text cols, so a single typo creates a phantom-new key or a false-duplicate. 908/909 distinct *today*, but not a safe surrogate PK.
- **`DVO SIDE` column is entirely empty** — defined but unused; confirm it's truly dead before modeling.
- **`RUN BAL` / summary totals are spreadsheet formulas** — must NOT be trusted as ingested truth; re-derive in SQL (consistent with Blackwood's "never compute balances in app code, trust the DB" rule — here it means trust *our* view, not Excel's cell).
- **Sparse PC warehouses** (W1/W2/W3 have 2–4 rows) — schema must handle near-empty ledgers; these warehouses only opened 2026-03-10.

**Open questions for the user:**
1. **Does "coco" actually exist as a codebase elsewhere** (remote repo / another machine)? Not found locally. If it has a schema, it should override the §6 draft.
2. **Time-scope:** ICTC's gsheet pivot locked "2025-01-01+". Should Cenapro have a similar floor? `Production` starts **2025-12-01**, but `DVO OUT` goes back to **2024-01-17**. Confirm the ingest window.
3. **Is `DVO OUT` in scope now?** It's a Davao outflow log; the 3 explicitly-excluded sheets are also DVO. `DVO OUT` was *not* on the exclusion list, so it's analyzed here — but confirm whether DVO belongs in the first Cenapro build or is deferred with the other DVO sheets.
4. **Plant vs Warehouse model:** confirm the physical reality (plants W6/W7/DVO produce → finished goods land in numbered PC warehouses) so FKs are correct.
5. **CCC/RK/FLEC taxonomy:** what do C1–C4 / RK1–RK4 / FLEC mean operationally? Needed to name the dimension correctly and to decide if FLECON inventory (PC sheets) is "the FLEC bucket realized as stock."
6. **Refresh mechanism:** how will the `.xlsb` reach Blackwood — manual upload, a watched folder, or (like ICTC) a link-shared cloud copy? Determines the future ingestion agent's design.

---

## Appendix — provenance of every number cited

- Read with Python `pyxlsb` 1.0.10 / pandas 3.0.2, `header=None`, full-sheet scan. Original file opened read-only; **never written**.
- Excel serial → date via `pyxlsb.convert_date` (1900 date system): 45308→2024-01-17, 45992→2025-12-01, 46091→2026-03-10, 46170→2026-05-28, 46009→2025-12-18.
- `Production` totals: 906 weight-bearing rows, ΣWT = 13,249,762 kg; by GRADE 3X50=10.89M / 2X6=1.53M / 3.5=0.83M; by PLANT W6=6.25M / W7=2.63M / DVO=2.49M / "W6 / W7"=1.84M.
- Distinct-value counts (SHIFT, GRADE, PLANT, WHSE, SRC, CCC/FLEC, WHSE SIDE) computed via `collections.Counter` over all data rows — see §2.1.
- PC sheet structural identity verified by comparing r0/r1/r13 across all five sheets (identical 13-column header).
- Excluded sheets touched only for a single first-non-empty-row header peek to confirm identity; their bodies were not analyzed.
