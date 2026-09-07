# `products` — finished-product (flecon) inventory

**Status:** live 2026-09-07. **TS-native — there is no Python oracle and no parity fixture**
(see `PORTING_DECISIONS.md`). Everything below was measured against the live sheet on
2026-09-07 and is pinned by `test/reports/products.test.ts` (32 assertions) against a
committed copy of that workbook.

**NO PESO ANYWHERE.** This sheet has no price data in it at all. Nothing in the tables,
views, RPCs, findings or the Excel sheet carries a ₱ or can derive one, so nothing here is
`canViewPrices()`-gated and nothing needs to be nulled before a payload leaves the server.

---

## 1. What it is

Renzo keeps a link-shared Google Sheet with **one tab per product grade**. Each tab holds a
header block of current per-stage flec counts and a running ledger of signed movements
between stages. His requirement, verbatim:

> summarize the products I have on hand (type of grade, amount of flec, kg per flec and
> total volume on hand in tons); show me a running tally as seen in the google sheet;
> automatically add grades in the inventory if there is a new sheet detected (should be
> smart enough to know that a sheet wasn't detected as new because of a rename or anything).

Five tabs today — `8X50`, `6X50`, `2X6`, `Kuraray 3x50`, `4X8` — 808 movements between them.

Source: `https://docs.google.com/spreadsheets/d/<PRODUCTS_SHEET_ID>/export?format=xlsx`,
no auth, the same mechanism `reports/gsheet/download.ts` uses, including the **ZIP
magic-number check** — `fetch` does not fail on a "restricted, please sign in" HTML page, it
hands back its bytes, and a sync that parsed a login page as a workbook would report zero
grades on a file full of them.

## 2. Extraction (`extract.ts`)

Four rules, each for a measured reason.

**2.1 The DATE header row is FOUND, never assumed.** It is row 12 on four tabs and **row 13
on `Kuraray 3x50`**, which carries an extra `OLD PROD` stage. Everything else — the five
ledger columns, the stage columns, the opening row — is located relative to it. A tab where
it cannot be found is reported unreadable (§5), never silently skipped.

**2.2 Stage columns come from the header row's OWN LABELS, never a fixed position.** On four
tabs `F..L` is PROD / AYAG / MAGNET / FINAL / BLENDED / SUNDRY / RECLASS; on Kuraray the whole
block is shifted one column right by `OLD PROD`. Reading by position would file every Kuraray
balance under the wrong stage **and the numbers would still look plausible**.

**2.3 The date is CARRIED FORWARD.** Only the first row of a day carries a DATE cell.
Measured: **126 of 331** rows on 6X50, **87 of 216** on 2X6, **93 of 127** on Kuraray and
**78 of 101** on 4X8 inherit their date. Treating a blank DATE as end-of-data would drop
three quarters of Kuraray. A blank DATE with *nothing else on the row* is a different thing —
a spacer carrying only running-balance formulas — and is skipped.

**2.4 kg is NULLABLE and is not invented.** One real row (6X50, 2025-10-03, AYAG, 2 flec)
states no kg. It is stored `NULL`, never 0: "not recorded" and "zero kilos moved" are
different facts. `movements_missing_kg` carries the coverage.

Also parsed, tolerantly: the `FLECON STARTING BALANCE` row (opening flecs per stage) and its
`AS OF AUGUST 30, 2025` date — month token via `lib/months.ts`, the ONE month table, never a
local map (L-039's rule) — and the lab thresholds, which the sheet spells **`TRESHOLD`** on
three tabs and **`THRESHOLD`** on a fourth, and which 8X50 states not at all. A threshold
that is not stated is **absent from the object, not zero**.

### The proof

For all five grades, `opening + SUM(flec_delta)` reproduces the count **the tab itself
prints in its header block**, stage for stage — a number computed by Renzo's own formulas
from cells this extractor never reads:

| Grade | Movements | Stage balances (computed == printed) |
|---|---|---|
| 8X50 | 33 | FINAL 59 |
| 6X50 | 331 | PROD 157 · AYAG 3 · MAGNET 25 · FINAL 187 |
| 2X6 | 216 | FINAL 65 · BLENDED 20 |
| Kuraray 3x50 | 127 | OLD PROD 110 · FINAL 36 |
| 4X8 | 101 | FINAL 35 |

Zero extraction warnings on the real sheet.

## 3. kg per flec is per grade AND MOVES

Measured: 8X50 **550**, 6X50 **550 → 570**, 2X6 **550 → 570**, Kuraray **590**, 4X8 **575**.
So the kg is stored **per movement** (it is in the row) and the grade's rate is derived in
SQL as the **latest non-zero |kg| / |flec| ratio**. **Never hardcode 550.**
`kg_per_flec_distinct_count` says how many rates a grade has ever used, so a UI can show the
figure as a current rate rather than a constant. One outlier exists (2X6 sheet row 266, ratio
2736) and is deliberately **not** filtered by a tolerance — it is simply not the latest row.

## 4. Identity and the rename rule (`classify.ts`)

A grade **is** a tab, and a tab name is typed by a person. So identity is the canonical code
(`upper`, trimmed, whitespace-collapsed) and a rename must be decided from **content**, never
from name similarity — the guess that would merge two products' ledgers, which no later run
could undo. Each rung requires the candidate's own tab to be **gone from the workbook**: a
product cannot have been renamed into a second tab while its first tab is still sitting there.

| Rung | Evidence | Severity | Why |
|---|---|---|---|
| 1 | identical `content_fingerprint` | `info` | The opening balances + first ten ledger rows are the part of a tab that never changes once written. An exact match is sameness, not resemblance. |
| 2 | ≥ **80%** of movement `row_hash`es already under exactly one absent grade | `attention`, **carrying the measured %** | Catches a tab whose opening row was edited at the same time it was renamed. This is an inference, so the number that drove it is shown. |
| — | neither | `info` (`product_grade_added`) | A genuinely new product, auto-created and ingested. |

**And one refusal.** If **two or more** absent grades match, **nothing is renamed**: a new
grade is created (the reversible direction — nothing is destroyed, the old grades stay and
are flagged missing) and every candidate is **named** in a `product_grade_ambiguous` finding
so a person can settle in one glance what the machine correctly declined to guess.

A grade whose tab has disappeared and matched no rename raises `product_sheet_missing`
(`attention`) and is **never deleted and never auto-deactivated**. A tab can be hidden, moved
to another file, or renamed in a way this ladder does not recognise, and none of those is a
reason for a machine to retire a product. Deactivation stays a human act.

### The fingerprint, and one definition proven rather than assumed

`lib/productFingerprint.ts` is **the** implementation;
`public.fn_product_grade_fingerprint(jsonb)` is a SQL **check copy** of the same canonical
string, so the two can be proven equal — the discipline `lib/sync/portable-hash.ts`
established against `node:crypto`. The three hexes asserted in the test suite were **read out
of the live database**, not out of the TypeScript. Two details are load-bearing: openings are
sorted in **byte order on both sides** (`collate "C"` in SQL), and a **NULL kg contributes an
empty field, never `"0"`**.

### The row hash does NOT contain the grade code

`sha256(date | stage | flec | kg | remarks | source_row)`.

`source_row` is **in** it because the sheet legitimately repeats byte-identical movements
(8X50 books `PROD −1 / −550 / RESIKO FROM SUNDRY` more than once), and without it two real
rows would collapse into one and the balance would be wrong.

The **grade code is out**, and that was a correction a test caught the same day (migration
`20260907062522`). With the code in the hash, every hash changes the instant a tab is
renamed, so a rename rewrote the entire ledger (127 rows deleted and re-inserted on Kuraray,
reported as movement where nothing moved) and — far worse — **rung 2 became structurally
incapable of firing**, because the two sides it compares were hashed under different names.
The hash never needed the code: `product_movements` is `UNIQUE (grade_id, row_hash)`.

## 5. An empty read of a non-empty file is loud (L-048)

A tab whose ledger cannot be located is reported through the **existing**
`source_tabs_unreadable` channel (`reports/sourceTabs.ts`), not a parallel one — one workbook
opened, one vocabulary. `high` when **not one** tab parsed, `attention` for a partial miss,
and the note names **both** lists (what it could not read *and* what it could), because one
list is a complaint and two lists side by side show the naming convention that moved. When
zero tabs parse, the run does **not** advance the `products` watermark and does not classify:
nothing was written, so there is nothing to be idempotent about, and the next run must read
the same file again.

## 6. Write model — replace-by-grade

`fn_replace_product_grade(grade_id, openings, movements)` does the whole diff in **one
transaction**, keyed on `row_hash`: rows the tab no longer carries are deleted, rows not yet
present are inserted, **rows already present are left untouched** (no `UPDATE`). The flecon
lesson: a DELETE and an INSERT as two independent HTTP calls is exactly what leaves a grade
wiped with nothing written when the second fails.

**Idempotence, stated precisely.** A second run over an unchanged tab returns
`{inserted: 0, deleted: 0}`, writes no fact row, raises no note and writes **no audit row** —
proven on the live database (§8). It *does* refresh `product_grades.last_seen_at`, which is
run bookkeeping in the same sense as `ingestion_watermarks.last_run_at`: without it, "this
tab was not in the workbook today" could not be told from "we have not looked lately", and
`product_sheet_missing` would have nothing to stand on.

Each grade is written inside its own try/catch, so one bad tab cannot cost the other four
their day's data; a failure becomes an entry in `errors`, which suppresses the watermark.

## 7. Findings vocabulary

| kind | severity | meaning |
|---|---|---|
| `product_grade_added` | `info` | A new product, created and ingested. The feature working. |
| `product_grade_renamed` | `info` / `attention` | Same product, new name. `info` on an identical fingerprint; `attention` + a `MATCHED ON THE NUMBERS` badge + the % when inferred from row overlap. Names **both** spellings. |
| `product_grade_ambiguous` | `attention` | Two or more candidates matched, so nothing was renamed. Names every candidate. |
| `product_sheet_missing` | `attention` | A product's tab is gone. Nothing deleted, nothing deactivated. |
| `source_tabs_unreadable` | `high` / `attention` | Reused, not cloned (§5). |

None are held: no durable case, so nothing to close by hand — the moment the tabs line up
again they stop firing. Section `products`; Excel sheet **Products**, with the rename's
old/new names in the **Side A / Side B** pair.

## 8. First live run (2026-09-07)

| Run | inserts | deleted | grades created | renamed | notes | audit rows |
|---|---|---|---|---|---|---|
| 1st | **808** | 0 | 5 | 0 | 5 × `product_grade_added` | 5 |
| 2nd | **0** | 0 | 0 | 0 | 0 | 0 |
| 3rd | **0** | 0 | 0 | 0 | 0 | 0 |

Portfolio after ingestion: **697 flecs · 399.205 t · 382 FINAL flecs · 8.68 vans ready**,
`grades_without_rate` 0.

## 9. Two things the sheet itself gets wrong — flagged, never repaired

**9.1 Its own running-balance cells drift.** `view_product_ledger.agrees_with_sheet` is false
on **448 of 808** rows. Measured **in sheet order** (removing the ordering question entirely),
the sheet's printed running column against a cumulative sum of the sheet's **own** delta
column: 8X50 **0 of 33**, 6X50 **14 of 331** (PROD), 2X6 **153 of 216** (PROD) + 34 (FINAL),
4X8 **94 of 101** (PROD) + 66 (FINAL), Kuraray **117 of 127** (PROD) + 68 (OLD PROD).

Which side is right is settled independently: the header-block totals agree with our
arithmetic on **all twelve** non-zero (grade, stage) pairs exactly. The running cells are
cosmetic and nothing is computed from them. `view_product_onhand.sheet_running_disagreement_count`
exists so a UI states this **once per grade** rather than painting half the ledger red.

**9.2 Four 2X6 rows are dated `2025-07-29` and sit at sheet rows 229–232** — nearly a year
later in the ledger than their date, and before that tab's own first row (2025-09-18). This is
the shape of the flecon `2025-01-31` / `2026-01-31` operator year typo already on record;
very likely `2026-07-29` mistyped. **Not corrected** — guessing a date is how a loud wrong
becomes a quiet one — and balances are unaffected either way, since a sum does not care about
order. Flagged as `date_out_of_sheet_order` / `date_out_of_order_count`.

## 10. Configuration

`PRODUCTS_SHEET_ID` overrides the committed default at
`reports/products/download.ts::PRODUCTS_SHEET_ID_DEFAULT`. The default is version-controlled
and reviewable (as gsheet's file id is) while a different sheet can be pointed at without
shipping code. See `DEPLOY.md`.
