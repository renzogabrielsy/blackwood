# FLECON Bag Inventory — Design (Bagging Manager, v1)

**Status:** decisions locked 2026-07-02 (Renzo). Scope = **FLECON bags only**. Surface = **dedicated Inventory page + dashboard card**. Siblings (`BAGGED POWDER`, `BAGGED 4X8`) are DEFERRED to a phase 2.

This is the "Bagging Manager" earmarked in `PRODUCTION_DESIGN.md` §10 ("FB (Flecon Bagged) → Bagging Manager → bag-type inventory + bagging events"). It ingests packaging-material (empty jumbo/flecon bag) stock — NOT charcoal. It reuses ALL existing sync infrastructure (Gmail IMAP + labels, PROPOSE→EXECUTE, audit logs, tail-scoping, ledger/digest, `lib/db.py`).

## 1. Source

- **Email:** subject `FLECON BAGGED` (and `Re: FLECON BAGGED`), sender **Ivy Mae Edillo `edilloivymae306ictc@gmail.com`** (same sender as WASTE). Sent ~daily, ~09:00 PHT.
- **Attachment:** `FLECON BAG MOVEMENT 2026.xlsx` — a **single cumulative workbook**, **one tab per YEAR** (`JANUARY 2026` = all of 2026, with in-sheet month section headers `JANUARY`…`JULY`). Pick the tab for the target year (fallback: last sheet). NOTE: cell `E2='YEAR 2025'` is a stale label — trust the **tab name + row dates**, not E2.

## 2. Workbook structure (JANUARY 2026 tab)

- **Header:** row 4 `A=DATE`, `B=PARTICULAR`; rows 4–6 define bag-type columns C…P (14 SKUs). `H4='Running Balance'` is a label, not data.
- **Row 7 `Forwarded Balance`:** per-bag-type OPENING stock for the year (observed 2026: H=20, I=340, M=207, N=108, O=25, P=507; blanks = 0).
- **Data rows:** `A`=date (a dated cell starts a date; sub-rows inherit it), `B`=particular (event text), and a **signed integer** in exactly one bag-type column (99.6% single-column; 2 rare rows move two types — a blend/recount). **Negative = bags consumed OUT; positive = bags received/returned IN.**
- **Month section rows:** `A`=month name (alpha), `B`=empty → context marker, skip.
- **Marker rows:** many `RS 1 ZAMBOANGA`/`RS 1 ZAMBAONGA` rows carry NO bag quantity → skip (not movements). (Two spellings — a data-quality quirk; keep raw text, do NOT auto-"fix".)
- **Balance snapshot row** (~row 499): per-type running balances the operator maintains → used only as an **informational cross-check**, never ingested as movements.

### 2.1 Bag-type dimension (14 SKUs — stable column map)

| Col | Source label | `code` |
|---|---|---|
| C | 590 kls (Kuraray) | `KURARAY_590` |
| D | Un-usable bag | `UNUSABLE` |
| E | 550 kls (FUTAMURA) | `FUTAMURA_550` |
| F | 550 KLS (KOREA) BEIGE | `KOREA_550_BEIGE` |
| G | 500 kls (KOREA) | `KOREA_500` |
| H | 590 kls (Kuraray) brandnew | `KURARAY_590_NEW` |
| I | kuraray (Re-turn bag) | `KURARAY_RETURN` |
| J | PLASTIC LINER (78x130x15 mm) | `PLASTIC_LINER` |
| K | ECOPACK BEIGE (90x90x125) | `ECOPACK_BEIGE` |
| L | ECOPACK BEIGE / TUNNER BAG (UN MARKINGS) | `TUNNER_BAG` |
| M | FG w/ Black Sling (6X50) | `FG_BLACK_SLING_6X50` |
| N | FG ALL BLACK (4X8) | `FG_ALL_BLACK` |
| O | KOREA (WHITE) | `KOREA_WHITE` |
| P | 580 KLS (MAEHATA) (8X50) | `MAEHATA_580` |

The extractor uses this FIXED column→code map with a header sanity-check (warn, don't crash, if a header label drifts).

### 2.2 Event vocabulary (raw `particular`, not enumerated in schema)

OUT (negative): `BAGGED POWDER`, `BAGGED 6X50/3X50/4X8/2X6`, `USED BAG OF SUNDRY`, `SUNDRY FEEDING HINUBO`, `DAMAGED BAG …`, `UNACCOUNTED …`, `5X9 SEGREGATION`.
IN (positive): `CEBU INCOMING …`, `RETURNED BAG FROM TIMBOL/KURARAY …`, `RETURNED BAG … OLD STOCK`, `ZAMBOANGA DELIVERED EMPTY BAG`, `FIBC ECOPACK … BRANDNEW`, `ACTUAL COUNTING …` (adjustment).
We store the raw `particular` verbatim; **IN/OUT is derived from the sign of `qty_delta`** (no brittle keyword enum in v1).

## 3. Schema (Supabase, charcoal tenant)

Additive migration. Three objects + one view. No change to existing tables.

- **`flecon_bag_types`** (dimension, seeded once): `id` (uuid pk), `code` (text unique — the 14 codes above), `label` (text), `source_column` (char, C…P), `sort_order` (int), `active` (bool default true), `notes` (text null). Optional descriptive cols (`capacity_kls` int null, `material` text null, `color` text null) — nice-to-have, fine to leave null in v1.
- **`flecon_bag_opening_balances`** (per-year forwarded balance): `id`, `bag_type_id` (fk), `year` (int), `qty` (int), unique `(bag_type_id, year)`. Seed 2026 from row 7.
- **`flecon_bag_movements`** (fact): `id` (uuid pk), `transaction_date` (date), `particular` (text), `bag_type_id` (fk), `qty_delta` (int, signed, NOT NULL), `source_row` (int null — sheet row for traceability), `remarks` (text null), `created_at` (timestamptz default now()). Index on `(transaction_date)` and `(bag_type_id)`.
- **`view_flecon_bag_balance`** (running balance, **SQL-computed — HARD RULE**): per `bag_type_id`, `opening = COALESCE(opening_balances.qty,0)` for the current year `+ SUM(movements.qty_delta)` = `balance`; also expose `total_in` (SUM of positive), `total_out` (SUM of |negative|), `last_movement_date`. Join `flecon_bag_types` for label/sort. This view is what the UI + dashboard card read.

**Idempotency / natural key — REPLACE-BY-DATE (the key decision):** a movement register legitimately repeats (two `BAGGED POWDER` -X same day/type), so there is no stable per-row natural key. On EXECUTE, for each `transaction_date` in the tail window, **DELETE that date's `flecon_bag_movements` then re-INSERT the sheet's current movements for that date** ("replace the day"). Safe because FLECON has a SINGLE source (Ivy's sheet — no competing writer). Bounded strictly to the tail window (`>= watermark − 3 days`); settled history below the window is NEVER touched. Each replace writes an `audit_logs` row (provenance in comment). This makes re-runs exact and absorbs same-day corrections.

## 4. Extractor — `extract_flecon_bags.py`

- Args: `--file <xlsx>`, `--since YYYY-MM-DD` (tail-scope; drop rows with `transaction_date < since`), optional `--year`.
- Pick the year tab; parse header (fixed column map + sanity-check); parse row 7 opening balances; iterate data rows carrying the date forward; emit one movement per populated bag-type column: `{transaction_date, particular, bag_type_code, qty_delta, source_row}`. Skip month-header + no-quantity marker rows. Emit `opening_balances` + `warnings` + `overall_confidence` like the other extractors. JSON to stdout / work_dir.

## 5. Classifier — `classify_flecon_bags.py`

- Scope to `--since`; group extracted movements by date. For each in-window date, compare the extracted day-set to the DB day-set: identical set → `DUPLICATE_NOOP`; any difference → `DATE_CHANGED` (the whole day will be replaced on EXECUTE); date absent in DB → `NEW` day. Summary counts + per-date deltas. Full JSON to work_dir; agent loads summary + changed/new days only (never NOOP). Also emit the informational balance cross-check (SQL-computed balance vs the sheet's balance-snapshot row) if the snapshot is locatable.

## 6. Employee — `bagging-manager.md` (agent)

- **Model = Sonnet** (routine daily driver; escalate to Opus only for genuine adjudication). Reads `RULES_DIGEST.md`; PROPOSE→EXECUTE; coordinator-relayed approval is authoritative (L-023). Fetches the `FLECON BAGGED` thread (Ivy) via `fetch_gmail.py`, extracts + classifies scoped to `watermark − 3d`, returns summary (NEW/CHANGED days + per-type balance preview + informational balance cross-check), and on approval performs the replace-by-date writes + audit logs + Gmail `Blackwood-Processed` label. Watermark = `MAX(transaction_date)` from `flecon_bag_movements`. Reconciliation is INFORMATIONAL, never a write gate.

## 7. UI (charcoal-tenant domain module)

- **Page `app/(app)/inventory/flecon-bags/`** (mirrors the RC OUT module pattern — server `page.tsx` + `actions.ts` + client grid). Two zones:
  1. **Balance cards** — per bag type: current balance (from `view_flecon_bag_balance`), opening, total in/out, last movement. Compact, Excel-density.
  2. **Movement ledger** — Excel-style table (date · particular · bag type · ± qty), month-grouped, `font-mono` right-aligned numerics, newest first, filterable by bag type. Follows the "Excel Standard" + frozen-header patterns.
- **Dashboard card** — a `components/digest/` band ("Bag Inventory") summarizing current balance per bag type (compact chips), reading the same view via `lib/digest/queries.ts`. Register in `app/(app)/page.tsx`.
- Register the page in the navbar `getBreadcrumb()` and the inventory route map. Not price-gated (no ₱ in this domain).

## 8. Scope boundaries (v1)

- FLECON bags ONLY. `BAGGED POWDER` + `BAGGED 4X8` (separate Ivy/others attachments) are DEFERRED — the `bagging-manager` can absorb them in phase 2 without schema churn (they'd add their own fact tables).
- **Balances require the full 2026 history**, so the FIRST run does a one-time full-2026-tab backfill (`--since 2026-01-01`) to seed all of this year's movements; daily runs thereafter tail-scope (`--since watermark − 3d`). Pre-2026 tabs are NOT ingested (the 2026 `Forwarded Balance` opening row already folds in prior years). Balance = opening(2026) + SUM(all 2026 movements) → matches the sheet's running balance.
- No ₱/cost data in this domain (packaging counts only).

## 9. Build order

1. **DB foundation** (supabase-backend-engineer): migration for the 3 tables + view + seed 14 bag types + seed 2026 opening balances; regenerate `types/supabase.ts`. *(FIRST — everything depends on it.)*
2. **Tooling** (Python): `extract_flecon_bags.py` + `classify_flecon_bags.py` + `bagging-manager.md`; offline-verify against the downloaded workbook.
3. **UI** (senior-frontend-engineer): Inventory page + dashboard card + navbar/route registration + `CONTEXT.md`.
4. First live PROPOSE→EXECUTE run (bagging-manager) once 1–3 land + user restarts Claude Code to register the agent.
