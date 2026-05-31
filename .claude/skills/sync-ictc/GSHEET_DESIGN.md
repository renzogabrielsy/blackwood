# GSHEET-SYNC Ingestion — Design Doc

> **Status:** deterministic foundation built; policy LOCKED (2026-05-30); agent
> definition written at `.claude/agents/gsheet-sync.md` (PROPOSE + EXECUTE). Second
> PROPOSE dry-run (scoped 2025+) complete. **Still PROPOSE-only — no DB writes, no
> Gmail — pending Renzo's approval for the first EXECUTE run.**
>
> **Locked policy (Renzo, 2026-05-30):**
> 1. **Scope = 2025-01-01 onward.** Pre-2025 Sheet rows out of scope; the DB's
>    pre-2025 legacy stays UNTOUCHED (never matched/updated/deleted).
> 2. **Sheet = source of truth for 2025+:** NEW → insert; VALUE_CHANGED → Sheet-wins
>    UPDATE. Pure/immaterial diffs (rounding, null↔0) demoted to NOOP — no churn.
> 3. **Conflict guardrail:** a NEW Sheet row that collides with a *different* DB
>    batch at the same date/slot/weight = likely reassignment → **FLAGGED**, never
>    auto-written, **never deletes a DB row**.

## Why this employee exists

Renzo's **Google Sheet is the source of truth for RC IN + RC OUT** (decided 2026-05-30,
see `MEMORY/gsheet_data_source.md`). It's maintained by Renzo's own hires from his master
file **minus pricing** — genuinely independent from the legacy *email* reports (which a
separate person maintains for Joseph). That independence makes the three-way
**Sheet ↔ email ↔ DB** match a real cross-check, not a copy.

`gsheet-sync` is a **writer** in that model: it ingests RC IN + RC OUT from the Sheet into
`deliveries` + `rc_out`, running FIRST in the daily flow. The Sheet's `Blocking` tab is a
**cross-check only — never ingested** (Blackwood computes blocking itself via
`view_blocking_grid`). Pricing (`cost_basis`) is **out of scope** here — it comes from the
Czarina email side later.

## Source — the Google Sheet

- **File ID:** `1yBZ0wW0DTr4ktYYtDIgXSVVoGsiETawyppkdyV1EiMM`
- **Access:** link-shared ("anyone with link") → **no auth**. Pull the whole workbook fresh:
  ```
  curl -sL "https://docs.google.com/spreadsheets/d/<ID>/export?format=xlsx" -o /tmp/gsheet_sync/rc_gsheet.xlsx
  ```
  Read named tabs with `openpyxl` (`data_only=True, read_only=True`).
- **8 tabs:** `Blocking` · **`RC IN`** · **`RC OUT`** · `SUNDRY` · `3X50 QC` · `Production` · `ORDERS` · `PROD SCHED`.
  Only `RC IN` + `RC OUT` are in scope for this employee.

## Scope

| Tab | Role | Target |
|---|---|---|
| **RC IN** | INGEST | `deliveries` |
| **RC OUT** | INGEST | `rc_out` |
| Blocking | cross-check only (future) — **never written** | (Blackwood's own `view_blocking_grid`) |
| SUNDRY / 3X50 QC / Production / ORDERS / PROD SCHED | out of scope (other employees / future) | — |

---

## Tab "RC IN" → `deliveries`

- **Header on row 7**, data rows 8..end. The Sheet is padded with blanks
  (max row ≈ 2,985); only **~962 rows are populated**, back to 2023-07-01.
- **Column E already holds Blackwood-style full `batch_code`s** (e.g. `MAY-26-BLK13`,
  `OCT-23-BLK1`) — unlike the operator email file which holds short labels like `B09`.
  So batch translation is *light* here; we still emit primary + fallback codes to
  survive the inconsistent month-prefix convention (see below).
- **No price column** → `cost_basis` is always `null`.
- Early "2023 BACKLOG" rows are sparse (often only WT + MC) — handled gracefully
  (forward-fill date, tolerate missing lab metrics).
- Columns **R–X (`WTD *`)** are weighted products (weight × metric) used for the
  Sheet's own weighted-average math — **IGNORED**, not source data.

### Column → schema map (LOCKED)

| Col | Header | → `deliveries` field | Notes |
|---|---|---|---|
| A | STATE | — | ignored (STORED/IN-USE/etc.) |
| B | WHSE | — | ignored (derivable from block_loc) |
| C | DATE | `transaction_date` | forward-filled on sparse rows |
| D | SUPPLIER | `supplier` | |
| E | BLOCK | `batch_code` (→ FK `batches`) | full code; primary + fallbacks emitted |
| F | BLOCK LOC | `block_loc` | validated against `{A-D,F,PCA,PCB}-NN[A-D]` |
| G | TRK | `truck_plate` | |
| H | WT | `weight_kg` | |
| I | SKS | `sacks` | |
| J | MC | `lab_results.mc` | |
| K | GRIT | `lab_results.grit` | |
| L | ASTM | `lab_results.bd_astm` | |
| M | JIS | `lab_results.bd_jis` | |
| N | VM | `lab_results.vm` | |
| O | ASH | `lab_results.ash` | |
| P | FC | `lab_results.fc` | |
| Q | REMARKS | `remarks` | |
| R–X | WTD * | — | **ignored** (weighted-avg helpers) |

---

## Tab "RC OUT" → `rc_out`

- **Header is on row 4** (rows 1–3 are blank/title) — *not* row 1. Data rows 5..end.
  ~**1,909 populated** rows (max row ≈ 2,602), back to 2024-01-01.
- **The `batch_code` lives in column C ("BLOCK"), NOT column B.** Column B ("BATCH")
  holds only a **month label** (e.g. `MAY`) → mapped to `production_batch`.
- `destination` (col E, "PLANT/ETC"): `MAIN` (1,829) | `SUNDRY` (78), plus rare typos
  (`MAN`, `MIAN`) normalized to `MAIN`.
- Columns I/J/K (`MC` / `MC WTD` / `DAY`) and L (duplicate BATCH) are the Sheet's own
  helpers — not ingested.

### Column → schema map (LOCKED)

| Col | Header | → `rc_out` field | Notes |
|---|---|---|---|
| A | DATE | `transaction_date` | |
| B | BATCH | `production_batch` | month label only (e.g. `MAY`) |
| C | BLOCK | `batch_code` → `batch_id` (FK `batches`) | **the real batch_code** |
| D | WT | `weight_kg` | |
| E | PLANT/ETC | `destination` | `MAIN`/`SUNDRY`; `MAN`/`MIAN`→`MAIN` |
| F | REMARKS | `remarks` | often `CLOSED`/`BACKLOG`/`OPEN` |
| G | BLOCK LOC | `block_loc` | |
| H | (blank) | — | |
| I | MC | — | ignored (Sheet helper) |
| J | MC WTD | — | ignored (weighted) |
| K | DAY | — | ignored |
| L | BATCH | — | ignored (duplicate) |

---

## Batch_code prefix conventions are INCONSISTENT

The DB mixes 3-letter and full-name month prefixes by era (`JAN`/`FEB` 3-letter;
`MARCH`/`APRIL`/`MAY` full; mid-2025 transition switched some months). See CLAUDE.md /
MEMORY. Every extracted row therefore carries:

- `batch_code_primary` — exactly what the Sheet wrote.
- `batch_code_fallbacks` — alternate-prefix spelling(s) (e.g. `MARCH-26-BLK6` ⇄
  `MAR-26-BLK6`), generated from a canonical alias map.

The classifier resolves **primary → fallbacks** against the DB:
- **RC IN:** against the set of `batch_code`s that exist in the `deliveries` window.
- **RC OUT:** against the `batches` lookup → `batch_id` (uuid).

A row whose primary **and** all fallbacks miss → **UNMAPPED**. **NEVER auto-create a batch.**
(First dry-run: **0 UNMAPPED** on either tab — the alias map covers the live data.)

---

## Forward-only dedup + classification (LOCKED decision #1)

Classify each Sheet row against the DB by **natural key**; do **not** propose rewriting
history. Buckets:

| Outcome | Meaning | Action (future write path) |
|---|---|---|
| **DUPLICATE_NOOP** | key present, all compared fields agree (within tol) | skip — the expected majority |
| **NEW** | key absent from DB | INSERT |
| **VALUE_CHANGED** | key present, ≥1 field differs | surface field-level diff for human decision |
| **UNMAPPED** | batch_code (primary+fallbacks) unresolved | manual batch decision — never auto-create |
| **MALFORMED** | missing date / batch / weight | skip with reason |

### Natural keys

- **deliveries:** `(transaction_date, batch_code, block_loc, weight_kg)` — RC IN has
  **0 key collisions** across 962 rows (clean).
- **rc_out:** `(transaction_date, batch_id, destination)` — confirmed against
  `classify_rc_out.py`. 9 same-key duplicates out of 1,900 keys (mostly same-day SUNDRY);
  the classifier pairs each Sheet row to the closest-weight DB row.

### Tolerance / aggregation matching (LOCKED decision #3)

The Sheet may log **one aggregated per-block** row where the DB/email logged several
**per-truck** rows (or vice-versa). So RC IN matching is two-pass:
1. exact natural key (weight to 3 dp);
2. if that misses, retry `(date, batch, block)` and accept the closest DB weight within
   **`AGG_TOL_KG` (50 kg)** as the same event — flagged with an `aggregation_note` rather
   than called a hard NEW row.

(First dry-run used 0 tolerance matches — the Sheet and DB are per-row aligned today —
but the path is in place for when granularity diverges.)

### Compared vs ignored fields

- **RC IN diff fields:** `supplier`, `truck_plate`, `sacks`, `remarks`, `lab_results`
  (lab compared at 2-dp). **`cost_basis` is never diffed** (out of scope).
- **RC OUT diff fields:** `weight_kg` (±1 kg tol), `remarks`, `production_batch`
  (only when *both* sides non-empty — DB stores `''` for most legacy rows, so an
  empty-vs-`MAY` mismatch is intentionally *not* a diff to avoid thousands of noise breaks).

### Material-change gate (LOCKED decision #2)

A VALUE_CHANGED row only enters the **Sheet-wins UPDATE** plan if at least one diff is
*material*. Demoted-to-NOOP (immaterial) categories:
- `sacks`: null ↔ 0 (the Sheet leaves sacks blank on some rows).
- `lab_results`: rounding/padding only — values equal at integer precision, or a
  null ↔ 0 pad, or a missing-metric whose present value rounds to 0. A genuinely
  *new* lab measurement the DB lacks (e.g. DB has no `mc`, Sheet adds `mc=9.07`) is
  **material** and wins.
Everything else (supplier, truck_plate, remarks, weight, real lab change,
`production_batch`) is material. Demoted rows carry an `immaterial_note` and live in
the `noop` bucket for transparency.

### Conflict guardrail (LOCKED decision #3)

A would-be **NEW** row is re-routed to **FLAGGED** (not inserted) when the DB already has
a *different* batch at the same:
- RC IN: `(date, block_loc, weight)` under a different `batch_code`;
- RC OUT: `(date, destination, weight)` under a different `batch_id`.
This is the batch-reassignment / double-count case. It is **never auto-written and never
deletes a DB row** — it goes to Renzo with the colliding DB row(s) and a yes/no question.

---

## Files

| File | Role |
|---|---|
| `scripts/extract_gsheet.py` | Sheet XLSX → normalized RC IN + RC OUT JSON (primary+fallback batch_codes). |
| `scripts/classify_gsheet.py` | `--mode rc_in\|rc_out --since YYYY-MM-DD` — classify vs DB → buckets (NOOP/NEW/changed/flagged/unmapped/out_of_scope). PROPOSE only. |
| `../../agents/gsheet-sync.md` | the employee agent — PROPOSE + EXECUTE modes, encodes the locked policy. |
| `GSHEET_DESIGN.md` | this doc |

**Run order (PROPOSE):**
```
curl -sL ".../export?format=xlsx" -o /tmp/gsheet_sync/rc_gsheet.xlsx
python3 scripts/extract_gsheet.py --file /tmp/gsheet_sync/rc_gsheet.xlsx \
    --out-rc-in /tmp/gsheet_sync/rc_in_extract.json \
    --out-rc-out /tmp/gsheet_sync/rc_out_extract.json
# pull DB rows (>=2025-01-01) + batch_lookup via supabase MCP (json_agg) into /tmp/gsheet_sync/*.json
python3 scripts/classify_gsheet.py --mode rc_in  --since 2025-01-01 --extract-json …/rc_in_extract.json  --db-rows-json …/db_deliveries.json --output …/rc_in_classified.json
python3 scripts/classify_gsheet.py --mode rc_out --since 2025-01-01 --extract-json …/rc_out_extract.json --db-rows-json …/db_rc_out.json --batch-lookup-json …/batch_lookup.json --output …/rc_out_classified.json
```

---

## PROPOSE dry-run #2 — WRITE PLAN, scoped 2025-01-01+ (2026-05-30, vs live DB)

DB at run time: `deliveries`=1,584 (max 2026-05-27), `rc_out`=1,925 (max 2026-05-28),
`batches`=657. Sheet maxes match the DB exactly (RC IN 2026-05-27, RC OUT 2026-05-28).

| Tab | Sheet rows | out-of-scope (pre-2025) | NOOP | INSERT (NEW) | UPDATE (Sheet-wins) | FLAGGED | UNMAPPED | MALFORMED |
|---|---|---|---|---|---|---|---|---|
| **RC IN** | 962 | 144 | 785 | **12** | **21** | 0 | 0 | 0 |
| **RC OUT** | 1,909 | 284 | 1,615 | **1** | **6** | **2** | 0 | 1 |

The 2025+ scope dropped all the 2023-backlog rounding noise; the material gate further
demoted 7 RC IN pure-rounding lab diffs to NOOP (so RC IN UPDATE fell 40 → 21).

### RC IN — INSERT (12)
All Feb-2026 **`JAN-26-SUNDRY4/6/7`** layupan rows (`A-4C`, `PCA-16A`, `PCB-16B`) present on
the Sheet but absent from `deliveries`. Weights 1,620–13,048 kg.

### RC IN — UPDATE (Sheet-wins, 21) — all genuine data-quality fixes
- **supplier** spelling normalizations: `Arbellera→Arbelera`, `Bagiuo Tipalan→Baguio / Tipalan`,
  `Tipalan/Baguio→Baguio / Tipalan`, `Bagiuo /Tipalan→Baguio / Tipalan` (4 rows).
- **truck_plate** corrections, incl. a date-parse artifact: `218842→Mar-99` (×6),
  `2499-03-01 00:00:00→MAR 2499` (1).
- **remarks** the DB lacks / differs (5): e.g. `MARCH-26-REFEED1` ← "FROM RC TANK HABWA…",
  `MARCH-26-BLK26` ← "PILED IN MARCH #26".
- **lab_results** that are *real new measurements* (5): the DB row is missing `mc` entirely
  (e.g. `MARCH-26-SUNDRY6` DB has no mc, Sheet adds `mc=9.07`; `APRIL-26-SUNDRY1` DB lab ∅,
  Sheet full panel). Correctly material — not rounding.

### RC OUT — INSERT (1)
`NOV-25-BLK16` MAIN 3,754 kg on 2026-03-24 (remarks CLOSED).

### RC OUT — UPDATE (Sheet-wins, 6)
- weight: `FEB-25-BLK8` 7,306→2,336 (+ remarks ''→CLOSED, production_batch APRIL→MAY);
  `JAN-26-BLK8` SUNDRY 9,017→8,453; `MARCH-26-BLK3` 6,497→6,000.
- remarks: `NOV-25-BLK9` SUNDRY CLOSED→∅; `MARCH-26-FEED6` ∅→CLOSED; `MARCH-26-BLK19` ''→CLOSED.

### RC OUT — FLAGGED (2) — conflict guardrail fired, NO auto-write
Both are the **`MAY-26-FEED5` reassignment** the guardrail was designed to catch:
- **r2165:** Sheet `MAY-26-FEED5` MAIN **6,497 kg** on 2026-05-26 would be NEW — but the DB
  already has 6,497 kg that day under a *different* batch (`MARCH-26-BLK3`, id `6075b49c…`,
  which is itself the 6,497→6,000 UPDATE above). Inserting would double-count.
- **r2171:** Sheet `MAY-26-FEED5` MAIN **13,330 kg** on 2026-05-27 collides with an existing
  13,330 kg DB row under a different batch (id `c58c1503…`).
- **Question for Renzo:** on 5/26–5/27, is `MAY-26-FEED5` a *reassignment* of those existing
  feeds (→ `reassign:<db_id>`, update the batch, don't insert), or a genuinely separate feed
  (→ `insert`)? Held until answered. **No DB row is ever deleted.**

### RC OUT — MALFORMED (1)
`DEC-25-BLK7` 2026-02-23, missing/zero weight.

---

## Blockers / schema surprises

- **None blocking.** Two layout surprises vs the original brief, both resolved in code:
  - RC OUT header is on **row 4**, not row 1.
  - RC OUT `batch_code` is in **column C ("BLOCK")**; column B ("BATCH") is just a month
    label → `production_batch`.

## Status / next step

The agent `.claude/agents/gsheet-sync.md` is written (PROPOSE + EXECUTE) and encodes the
locked policy. New agent files don't load mid-session — to register `gsheet-sync` as a named
agent, Renzo restarts Claude Code (or it's tested via a `general-purpose` proxy first).
**The first EXECUTE run is pending Renzo's explicit approval** + decisions on the 2 flagged
RC OUT reassignments.
