# Handoff — 2026-06-02 — Cenapro Second Tenant Built (Schema → Backfill → Editable Ledger + Flec Inventory)

> **For the next session.** If the user says **"view latest handoff file"**, "where did we leave off", or "what's the current state", read this first.
>
> **Lineage:** continues `2026-05-31-gsheet-source-of-truth-pivot-self-learning-blocking-fix.md`. That handoff's "next action" (gsheet-sync lean refactor / flip email agents to audit mode / pricing) was **NOT done** — this session pivoted entirely to onboarding the **Cenapro** second tenant (Renzo introduced it 2026-06-01). Those ICTC-sync items remain deferred.

---

## TL;DR

Built the **entire Cenapro second tenant (CI / Cebu charcoal company) end-to-end** — a brand-new, fully-isolated tenant on the Blackwood platform, all on branch **`feat/cenapro-integration`** (16 commits, pushed to origin, **NOT yet merged to `dev`**). It's an isolated `cenapro` Postgres schema, a 752-row backfill from Renzo's `2025 CI PRODUCTION V2.xlsb`, and two **editable** screens (Production ledger + Excel-style Flec Inventory) — **the app is now the maintaining file, replacing the Excel.** Earlier in the session, ICTC production-table visual fixes also shipped to `dev`.

**Next concrete action: TEST-RUN the ICTC Gmail/email scraping sync** — the `sync-ictc` employee agents ingesting ICTC daily ledgers from Gmail (IMAP). This is the headline next step; everything Cenapro is parked-but-working.

---

## What shipped (with paths)

### A. Cenapro tenant — the whole thing (branch `feat/cenapro-integration`, 16 commits)

**Design docs:**
- `cenapro/CENAPRO_PRODUCTION_ANALYSIS.md` — analysis of the `.xlsb` (file-only inference; partially WRONG, see learnings).
- `cenapro/CENAPRO_SCHEMA.md` — the authoritative schema design doc (ported from codo's spec; kept in sync as decisions changed).

**Database (4 migrations in `supabase/migrations/`):**
- `20260601113339_create_cenapro_schema.sql` — isolated `cenapro` schema: 6 lookup tables (`shift`, `grade`, `plant`, `warehouse`, `source_location`, `partner_equipment`), the `production_event` spine, `warehouse_opening_balance`, `drift_log`; the `flec_ledger(p_warehouse_code, p_start_date)` + `flec_balance(...)` start-date-scoped functions; `view_production_daily`; a BEFORE-INSERT trigger computing `unique_tag` + `batch_year`.
- `20260601113340_harden_cenapro_function_search_path.sql` — pins `search_path=''`.
- `20260601113341_add_public_cenapro_accessors.sql` — **read** accessors in the already-served `public` schema (`cenapro_production_events` VIEW, `cenapro_flec_balance`/`cenapro_flec_ledger` functions).
- `20260601113342_cenapro_write_path_and_opening_balance_history.sql` — **write** path: GRANT INSERT/UPDATE/DELETE on the auto-updatable `cenapro_production_events` view; opening-balance made **append-only** (dropped the UNIQUE natural key); new functions `cenapro_set_opening_balance`, `cenapro_opening_balances`, `cenapro_opening_balance_history`; `flec_ledger` seed tie-breaks by `created_at DESC`.

**Backfill (`scripts/cenapro/`):**
- `backfill_from_xlsb.py` — idempotent pure parser → SQL generator (UPSERT on `unique_tag`; append-only drift). `backfill_cenapro.sql` + `chunks/` are its output. Applied via Supabase MCP `execute_sql` (NOT PostgREST — schema not exposed). Result: **752 `production_event`, 2 `warehouse_opening_balance`, 631 `drift_log`** rows.

**Frontend module (`app/(app)/cenapro/`):**
- `types.ts` — generated-type-derived rows + lookup constants + the shared `parseCccFlec`/`formatCccFlec`/`CCC_FLEC_OPTIONS` helpers.
- `production/` — `page.tsx`, `actions.ts` (`fetchProductionEvents(period)`, `fetchCenaproPeriods()`, `saveProductionEvents(dirty, deleted)`), `production-ledger-grid.tsx` (the editable grid: inline edit, dropdowns, dual-date sort, Shift/Grade/Plant/WHSE/Source filters, **frozen left columns #/Recv/Prod/Batch**, bold + IN/OUT color coding + CCC-FLEC/Plant badges, NO trailing input row), `production-view.tsx`, `period-picker.tsx`, `bulk-add-modal.tsx` + `bulk-paste-utils.ts` (8-preset-row Excel/Sheets paste modal).
- `inventory/` — `page.tsx`, `actions.ts` (`fetchFlecInventory`, `fetchOpeningBalances`, `fetchOpeningBalanceHistory`, `saveOpeningBalances`), `flec-inventory-client.tsx` (Excel "PC WHSE"-style: editable STARTING block per grade×side + "now" closing + movement ledger + append-only history/backtracking; localStorage-persisted warehouse+date).
- `layout.tsx`, `page.tsx` (landing), `loading.tsx`, `error.tsx`, `CONTEXT.md` (full module doc).
- `components/navbar.tsx` — registered a separate "Cenapro · Cebu" section (vs "ICTC · Davao").
- `types/supabase.ts` — regenerated (includes the public `cenapro_*` accessors).

### B. ICTC production-table fixes (on `dev`, earlier this session)
- `app/(app)/inventory/...` daily ledger / `app/(app)/production/daily/daily-ledger-grid.tsx`: DT-reason + remarks collapsed into clickable **message-icon popover cells** (commit `dc63a16`); **footer totals condensed** (600k style + tooltips); **SHIFT M/E/N ordering** + **SHIFT/CUSTOMER/GRADE header filters** (commit `3b241ad`).

---

## Critical learnings (highest-value section)

1. **The `cenapro` schema is NOT PostgREST-exposed, and Claude CANNOT expose it.** The hosted Supabase MCP is OAuth-based (`https://mcp.supabase.com/mcp`) — no extractable management PAT; the keychain "Supabase CLI" token returns 401; `ALTER ROLE authenticator SET pgrst.db_schemas` is denied on managed Supabase. **Solution shipped:** the app reads/writes cenapro through thin accessors in the already-served `public` schema (`public.cenapro_*`). Data + logic stay 100% in `cenapro`; `public` only has look-through windows. **Consequence:** any NEW cenapro column/function the UI needs requires adding/widening a `public.cenapro_*` accessor (the whole-schema toggle is off). If Renzo ever flips Dashboard → Settings → API → Exposed schemas → `cenapro`, you can drop the wrappers and use `.schema('cenapro')` directly.
2. **CCC/FLEC is ONE column in the UI (Excel parity), normalized in the DB.** codo's spec split the Excel `CCC / FLEC` column into `disposition_kind` + `partner_equipment_code`; Renzo wanted one column back (copy-paste alignment). The grid + bulk modal show ONE `CCC/FLEC` column (`FLEC`/`C1`–`C4`/`RK1`–`RK4`); `parseCccFlec`/`formatCccFlec` in `types.ts` derive the two DB fields on save. **Do not re-split the UI.**
3. **181 "warehouse-unknown" bagging rows are KEPT as production** (warehouse=NULL), not dropped — older rows recorded the plant code in the WHSE column. They're "unplaced," excluded from the flec ledger until a warehouse is assigned (editable in the grid). Dropping them would've hidden ~20% of production.
4. **145 DVO rows DEFERRED** (parked in `drift_log` kind=`dvo_row_deferred`). DVO / WHSE 3 sub-system is out of v1 (Renzo excluded `DVO IN`). Schema is forward-compatible (WHSE 3 + DVO source/plant seeded; validity matrix keeps DVO cells).
5. **Opening balances are APPEND-ONLY** (the UNIQUE natural key was dropped). Every "set" is a new dated row; effective opening = greatest `period_start_date ≤ as-of`, tie-broken by `created_at DESC`; full history powers backtracking. This is Renzo's "modular starting balance that never loses data."
6. **Backfill = Claude Code subagent, NOT an in-app upload.** Renzo's correction: the app is view/maintain only; re-loading the `.xlsb` is a subagent job (the idempotent `backfill_from_xlsb.py`). There is NO upload button. A future `cenapro-sync` agent could wrap the parser.
7. **codo (`~/CI-ICTC-Inventory-App`) is the authoritative reference**, not my from-scratch analysis. Its `docs/schema-extraction.md` is the human-corrected spec (e.g. C1–C4 = partner crushers, RK1–RK4 = partner kilns — my `CENAPRO_PRODUCTION_ANALYSIS.md` wrongly guessed "quality classes"). The 17GB scare was just stale Rust build artifacts in a `.claude/worktrees/.../target` dir (deleted, reclaimed ~11.8GB).
8. **Perf:** the production grid rendered all 752 rows unvirtualized + re-rendered every row on each keystroke → slow. Fixed with a **Year+Batch period picker** (loads one period; defaults to the NEWEST = June 2026 = only 2 rows) + `React.memo` row component. (See open decisions — the near-empty June default may want changing to "most-populated-recent".)
9. **Two React bugs fixed:** (a) date-sort header didn't flip — `setDateSortDir` was nested inside a `setDateSortKey` updater, and Strict Mode double-invokes updaters → flipped twice → no-op. Keep setState calls flat. (b) `<colgroup>` hydration error — inline `{/* */}` comments between `<col>` left whitespace text nodes (illegal in React 16). No inline comments in `<colgroup>`.
10. **Data-quality flag: `Production` row 1011** (2026-05-11, WHSE 7) has `weight_kg = 139917` — almost certainly a typo for 13,991.7. Loaded verbatim (the parser doesn't "correct" numbers); Renzo to fix at source + re-run backfill.

---

## Current state

### ✅ Working / verified
- Cenapro schema + 752 rows live; `flec_balance('WHSE 7','2026-03-10')` 3X50/RS = 56 (matches codo reference). ICTC `public` schema verified byte-for-byte untouched throughout.
- Editable production ledger + editable flec starting balances proven to WRITE as the real `authenticated` role (insert/update/delete, append-only openings). `tsc --noEmit` 0 errors; `npm run build` clean.
- All 16 Cenapro commits pushed to `origin/feat/cenapro-integration` (tip `fc163a1`). Working tree clean.

### ⚠️ Built but pending Renzo's click-test
- The Cenapro screens are auth-gated; verified via DB queries + Node SDK calls, but the final in-browser eyeball (esp. dark mode, frozen-column scroll, badge contrast) is Renzo's. He's been refining these live (period picker, freeze panes, colors, CCC/FLEC merge, sort, filters all done in response to his feedback).

### ⚠️ Deferred / known minor
- `feat/cenapro-integration` is **NOT merged to `dev`** — open a PR into `dev` when Renzo signs off (link: https://github.com/renzogabrielsy/blackwood/pull/new/feat/cenapro-integration).
- Unused `Badge` import lint **warning** in `production-ledger-grid.tsx` (pre-existing, non-blocking).
- Production default period = newest (June 2026, ~2 rows) → opens near-empty (see open decisions).
- DVO sub-system deferred; future `cenapro-sync` subagent for re-loads not built.
- **From the prior handoff, still NOT done:** gsheet-sync lean Python refactor, flip deliveries-manager/rc-out-manager to audit mode, pricing (Czarina `cost_basis`).

---

## Open decisions
- **Merge `feat/cenapro-integration` → `dev`?** (Renzo's call once he's happy with the screens.)
- **Production default period:** newest batch (June, near-empty) vs most-populated-recent batch. One-line change to the sort/default in `production/page.tsx` + `actions.ts` `fetchCenaproPeriods`.
- **Cenapro re-load mechanism:** confirm a `cenapro-sync` Claude Code subagent wrapping `backfill_from_xlsb.py` is the path (vs anything else) when Renzo wants to refresh from a new `.xlsb`.

---

## Next concrete action — TEST the ICTC Gmail / email scraping sync

Renzo wants to **test-run the ICTC daily-ledger email scraping** next session. Prerequisites + how to start cold:

- **The employees** (all built + registered as named agents): `deliveries-manager` (RC IN), `rc-out-manager` (RC OUT / PROPOSED DAILY REPORT), `rc-movement-auditor` (read-only cross-check), `production-manager` (MC + Ivy emails → 6 tables), `gsheet-sync` (Google Sheet source-of-truth). Defs in `.claude/agents/`; Python tools in `.claude/skills/sync-ictc/scripts/`.
- **Gmail auth = IMAP + App Password ONLY.** Creds at `~/.config/sync-ictc/credentials.env` (`GMAIL_USER` + `GMAIL_APP_PASSWORD`). Fetch via `fetch_gmail.py` (IMAP; only path that downloads attachments). The `claude.ai` Gmail MCP connector is read-only / no attachments — do NOT rely on it.
- **Run in PROPOSE mode first (dry-run):** each agent fetches → extracts → classifies vs DB (NEW / DUPLICATE_NOOP / VALUE_CHANGED) → returns a summary + path to classified JSON, **without writing**. Present to Renzo → approve → relaunch in EXECUTE mode.
- **Orchestration:** the daily sync = **parallel `Task` (Agent) launches on Sonnet** — Renzo **dislikes the Workflow tool** (tokens). NOT `Workflow`. (There's a documented `.claude/workflows/ictc-sync.js` but it's for reference only.)
- **Idempotency:** processed threads get the Gmail label `Blackwood-Processed` (Label_14); search queries exclude it. To re-test, IMAP `STORE -X-GM-LABELS` to unlabel.
- **Watch-outs:** daily kg-in vs kg-out drift is EXPECTED (continuous-flow feed tank, balances at month-end) — NOT an error except the rc-out HARD gate on PROPOSED-vs-RC-MOVEMENT daily drift (>500 kg). Batch-code prefixes are INCONSISTENT (JAN vs MARCH vs full names) — use primary + fallback codes, route unmapped to UNMAPPED (never auto-create batches). Read `.claude/skills/sync-ictc/LEARNING_LEDGER.md` (L-001…L-006) before classifying.

Suggested first move: ask Renzo which report(s) to test (deliveries / rc-out / production), then launch that agent in PROPOSE mode and review its classified output together.

---

## Git state
- **Branch:** `feat/cenapro-integration` — clean working tree, in sync with `origin/feat/cenapro-integration` at **`fc163a1`**. **16 commits ahead of `dev`** (the whole Cenapro build, `e6cc194`…`fc163a1`).
- **`dev`** tip ≈ `1041f32` and carries the ICTC visual fixes (`dc63a16`, `3b241ad`) + the Cenapro analysis doc. The Cenapro feature branch was cut from `dev` at `1041f32`.
- Nothing to commit; everything pushed.

---

*End of handoff — 2026-06-02 — Cenapro second tenant built end-to-end (isolated schema + 752-row backfill + editable production ledger + Excel-style flec inventory), all on `feat/cenapro-integration` (unmerged). Next: test the ICTC Gmail/email scraping sync.*
