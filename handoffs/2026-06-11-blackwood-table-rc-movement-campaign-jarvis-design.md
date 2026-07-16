# Handoff — 2026-06-11 — Blackwood Table shipped · RC Movement → campaign · June 8–10 sync · Jarvis-sync design

Prior handoff: `handoffs/2026-06-05-digest-dashboard-editable-daily-block-june-sync.md`

## TL;DR
Huge session. (1) Shipped the universal **"Blackwood Table"** grid primitive across **all 8 grids** + the Daily Block retrofit + context-menu consolidation — **committed `60092a2` and merged to `dev`**, then a follow-up commit **`56a375a`** landed the digest + RC Movement features + 4 migrations on `dev`. (2) Ran **two ICTC syncs** via the employee-subagent playbook (June 5, then June 8–10) — **DB is current through June 10** across deliveries / rc_out / production. (3) Backfilled `rc_out.production_batch` (**128 rows**) from the Google Sheet. (4) Overhauled the **RC Movement matrix**: weighted-avg fed-price columns/footers, TOTAL PRODUCED + dynamic grade columns + tricolor yield/loss footer, then **re-keyed the whole matrix from calendar-month → `production_batch` CAMPAIGN** (fed AND production), dropped the redundant Batch column, surfaced the campaign in the toolbar. (5) Wrote **`docs/SYNC_JARVIS_DESIGN.md`** — a full architecture plan (design-only) for an in-app "Jarvis" sync button powered by the Claude API.
**Next concrete action:** Renzo will **run an ICTC sync next session** from Claude Code (the established gsheet-first → email/production auditors → propose → approve → execute playbook). Watermark to beat: **2026-06-10** for all streams. Also: **commit the small uncommitted tail** (Batch-column removal + the new design doc) — currently on branch `feat/blackwood-table-universal-grid`.

## What shipped
**Blackwood Table primitive (committed `60092a2`, merged to `dev`):**
- New package `components/shared/grid/` (`GridCell` extended, `SelectCell`, `DatePickerCell`, `EditInput`, `GridContextMenu`, `index.ts`, `CONTEXT.md`) + `lib/hooks/` (`use-grid-keyboard-nav.ts` with `NavResolver` + `createCoordinateNavResolver` + `createDomOrderNavResolver`, `use-grid-edit-session.ts`, `use-grid-paste.ts`, `use-grid-context-menu.ts`).
- Migrated all 7 flat grids (rc-in `bulk-delivery-input.tsx`, rc-out `bulk-usage-input.tsx`, cenapro `production-ledger-grid.tsx` + `bulk-add-modal.tsx`, production `daily-ledger-grid.tsx` + `electricity-grid.tsx` + `trucks-grid.tsx`) onto the shared hooks.
- Retrofitted the **Daily Block** (`app/(app)/cenapro/production/production-daily-block.tsx`) from always-on inputs → canonical click-to-select / type-or-dblclick/F2-to-edit (DOM-order resolver; collision-lock, InsertPopover/BaggingMetaPopover, dirty tints, frozen panes, save path all preserved).
- Consolidated the 3 hand-rolled context menus (delivery-master row+column, ledger, daily-ledger) onto `GridContextMenu`.
- **QA fixes (in the same arc):** collapsed cell height made Daily Block unclickable (`h-full` needs `h-7` on the host `<td>`); filler-row identity navid collision (Tab duplicating value into 2 rows) → stable parent-owned slot ids; grade/source couldn't clear (IdentitySuggestInput auto-accepted empty query); custom typeahead + "recognized value" chips; `Sh`→`SHFT`; **React-19 blur-commit drop** meant the Daily Block Save button never appeared → switched to explicit commit (other grids persist on keystroke, unaffected).

**Digest dashboard (committed `56a375a`):**
- KPI **sparklines now skip zero-value dates** for rc_in/rc_out/production/power (was misread as hiding cards — corrected to filtering the spark series in `lib/digest/queries.ts`; `kpi-hero.tsx` renders all cards). net_flow untouched.
- New **"Trucks with a trip"** band (`components/digest/trucks-summary.tsx`, from `truck_readings` where `ttl_km>0`).
- **Production-by-grade chart now split by shift** (`digest-charts.tsx`) — needed `shift` added to `view_digest_grades`.

**RC Movement matrix (`app/(app)/inventory/rc-movement/`, mostly `56a375a`; Batch-column removal UNCOMMITTED):**
- "Fed ₱/kg" column between Batch and Total fed (per-day weighted-avg fed price); per-block ₱/kg footer; campaign/month avg fed-price footer. Price basis = each batch's weighted-avg `deliveries.cost_basis` (NOT stale `batches.avg_cost`).
- **TOTAL PRODUCED** + dynamic **grade columns** (from `production_runs`) after Total fed; **tricolor full-bleed yield/loss footer** (amber=produced, green=yield, red=loss%; loss shown as `1−yield`).
- **Re-keyed month picker → production_batch CAMPAIGN** (e.g. "June 2026"); fed AND production both filtered to the campaign; transition days split by tag (5/29 MAY-feed vs JUNE-feed not merged); URL `?campaign=JUNE-2026`; tolerates fed-but-no-production campaigns (production data only exists Dec-2025+).
- **Dropped the now-redundant frozen "Batch" column** (reclaimed 96px) and surfaced the active campaign in the toolbar — *this last bit is uncommitted in `rc-movement-matrix.tsx` + its `CONTEXT.md`*.

**Supabase migrations (4, applied to remote + committed in `56a375a`):**
- `20260609005044_add_shift_to_digest_grades.sql` (DROP+CREATE view + re-GRANT — see learning below)
- `20260609010000_create_rc_movement_fed_price_views.sql` (`view_rc_movement_day_price`/`_month_price`/`_batch_price`)
- `20260609020000_create_rc_movement_production_yield_views.sql` (`_production_daily`/`_daily_total`/`_production_monthly`/`_yield_monthly`)
- `20260609030000_create_rc_movement_campaign_views.sql` (8 campaign-keyed views: `view_rc_movement_campaign_options`/`_cells`/`_day_price`/`_price`/`_production_daily`/`_production_daily_total`/`_production`/`_yield`)

**Data writes (live in DB, not git):**
- ICTC sync #1 (June 5): +1 delivery, +2 rc_out feeds, full production day. ICTC sync #2 (June 8–10): +7 deliveries (2 new batches JUNE-26-BLK4/FEED3), +8 rc_out feeds, production for 6/8–6/10. June 6 dropped (relabeled-duplicate of 6/5 — new failure mode, ledger **L-016**); 6/8 was a 0-kg maintenance day.
- **Backfilled `rc_out.production_batch` (128 rows)** from the Sheet (verbatim copy; 2024 legacy left null because the Sheet itself is blank there).

**Design doc:** `docs/SYNC_JARVIS_DESIGN.md` (UNTRACKED) — full plan for an in-app sync button (Claude API Agent SDK / Messages API, manual agentic loop on a small always-on worker, streaming live feed via Supabase Realtime, propose→approve→execute, single-operator Renzo). Appendix B analyzes the existing in-app Jarvis chatbot as the precedent; Appendix C confirms server-side IMAP is fine.

## Critical learnings (highest value)
- **DROP VIEW wipes GRANTs.** When `view_digest_grades` was rebuilt (DROP+CREATE, because the new `shift` column inserts mid-SELECT and CREATE OR REPLACE forbids that), the anon/authenticated SELECT grant was lost → the chart silently returned 0 rows for the logged-in app (service role still saw data). **Always re-`GRANT SELECT TO authenticated, anon` after any DROP+CREATE.** The grant is now in the migration.
- **`batches.avg_cost` is STALE** for several live batches (e.g. JAN-26-BLK11 stored 42.44 vs true weighted 45.57). All new RC Movement price math computes from `deliveries.cost_basis` instead. Anything else still reading `avg_cost` may show wrong prices.
- **`production_batch` ≠ `batch_code`.** `production_batch` = operational campaign ("MAY"/"JUNE"); `batch_code` = the physical pile ("MARCH-26-BLK3"). A campaign feeds piles from many months, and the SAME pile/date can split across two campaigns (5/29 JAN-26-BLK10 = MAY 11,210 + JUNE 10,600). This is why the matrix had to group by campaign, not calendar month.
- **React 19 / Next 16 drops `onBlur`-commit** when the input unmounts in the same render as the focus move — broke the Daily Block Save button (held edits locally, committed on blur). Fix = explicit commit, not blur. Watch for this anywhere an editor commits on blur.
- **Google Sheet keeps LAGGING Renzo's operator-side corrections.** Every sync, the Sheet tries to revert fixes (mangled truck plates, sacks typo, FEED5 double-count, FEB-25-BLK8 weight). Ledger L-013 makes gsheet-sync check `audit_logs` before any Sheet-wins UPDATE and FLAG reverts instead of applying. **Someone should update the Sheet to match the DB or these reverts surface forever.**
- **Operator relabel duplicate (L-016):** MC re-emitted 6/5's full production record under a 6/6 label, defeating the `MAX(transaction_date)` watermark. The cheapest tell = the cumulative electricity meter (a real new day continues the prior end-kwh; a duplicate repeats it). Future runs cross-check a `watermark+1` day against the prior day.
- **Two flavors of "unlabeled"** in rc_out: true `NULL` and empty-string `''` (118 rows). A naive `WHERE production_batch IS NULL` misses the empties — the backfill guarded both.
- **Jarvis design "brain vs hands":** the sticking point was that the Claude API is the *brain* (judgment) but can't hold creds or touch Gmail/DB — a thin always-on "worker" still has to execute credentialed tool calls. Renzo wanted the API to BE the worker; it can't. (User ultimately parked the feature.)

## Current state
- **Working / tested (typecheck + prod build green):** the entire Blackwood Table migration, digest changes, RC Movement overhaul. `npx tsc --noEmit` clean throughout; `npm run build` passed.
- **NOT browser-verified:** the app is login-gated and the agent can't authenticate — all UI was verified via typecheck + targeted throwaway public harnesses, NOT a real logged-in click-through. **Renzo should eyeball:** the campaign-grouped RC Movement matrix, the tricolor footer, the Daily Block click-to-select/type-to-edit, and the digest bands.
- **Deferred:** RLS is **disabled** on production tables (`truck_readings`, `production_*`, `electricity_readings`, etc.) — readable/writable with the anon key. Pre-existing security exposure; not addressed.
- **Known nits:** pre-existing eslint debt in `rc-movement-matrix.tsx` (`set-state-in-effect`, one `any`); the L-009 `audit_logs` PostgREST grant gap (agents write audit rows via the elevated MCP as a workaround); L-010 `enrich_prices.py` plate-typo fallback still recurs.

## Open decisions
- **Commit the uncommitted tail?** (Batch-column removal in `rc-movement-matrix.tsx`+`CONTEXT.md` + `docs/SYNC_JARVIS_DESIGN.md` + the `.claude/` ledger/memory updates.) Use git-branch-guardian; `git add .`.
- **Jarvis-sync feature:** design-only. If pursued, the open forks are (a) where the worker process lives (Renzo's Mac vs small VM) and (b) OK to host Gmail app-password + Supabase service-role + Anthropic key in that worker. Renzo parked it for now.
- **Fix the Google Sheet** to stop the recurring stale reverts.

## Next concrete action
**Run the daily ICTC sync next session** from Claude Code, watermark = 2026-06-10:
1. Launch **gsheet-sync** (PROPOSE, source of truth) first.
2. Then **deliveries-manager + rc-out-manager + production-manager** (PROPOSE) + **rc-movement-auditor** (read-only) in parallel.
3. Consolidate, present to Renzo, get approval, then EXECUTE (gsheet writes typically deferred to the email agents which have the fuller/enriched set).
4. Expect zero/low new rows unless 6/11+ reports arrived. Honor ledgers L-007/L-010/L-013/L-014/L-015/L-016. Don't re-apply Sheet reverts.
*(Separately, low-effort: commit the uncommitted tail above.)*

## Git state
- **Branch:** `feat/blackwood-table-universal-grid` (this is also where `dev` points after the FF merge).
- **Committed + on `origin/dev`:** `60092a2` (Blackwood Table primitive) and `56a375a` (campaign RC Movement + digest + 4 migrations). `main` untouched at `4deb20e`.
- **Uncommitted (working tree):** `app/(app)/inventory/rc-movement/rc-movement-matrix.tsx` + `CONTEXT.md` (Batch-column removal / campaign-in-toolbar), `docs/SYNC_JARVIS_DESIGN.md` (untracked), and `.claude/` ledger + agent-memory updates (L-013→L-016 etc.).
