# Blackwood Project Timeline

> **Living document.** Update this file whenever a task is completed, a phase starts, or scope changes.
> Both Claude and Antigravity agents must read this file before starting any work session.
> Last updated: **2026-05-29**

---

## Recent Completions

| Date | Item |
|---|---|
| 2026-05-30 | **ICTC one-click sync workflow v1 built + first parallel run** — Shipped `.claude/workflows/ictc-sync.js`: runs deliveries + rc-out + production in **PARALLEL** auto-execute (no approval gate; each agent keeps its internal safety gates) + `rc-movement-auditor` read-only after. Invocable as `ictc-sync` / "run the ictc sync". First parallel run (`wf_96f6c7b6-4a6`) **PROVED 3 concurrent agents on one Gmail mailbox = zero `[Errno 60]`** (the IMAP gotcha is intra-agent only, not cross-agent) — the prior sequential caution was unnecessary. deliveries + production clean **noop** (idempotency proven 2 ways: watermark + label control-query); rc-out wrote 2 rows / 36,495 kg for 5/28 but **HELD 2** (NOV-24-BLK5 19,898 kg trigger-collision + block 514 2,749 kg unmapped), left PROPOSED thread UID 118629 unlabeled for retry. **The built-in auditor independently caught the write was incomplete**: 5/27 short 12,563 + 5/28 short 19,898 = **32,461 kg stranded** by NOV-24-BLK5's stale `A-20B` `location_ref` (slot occupied by active MAY-26-BLK2). Also surfaced 4 pre-existing over-consumed batches (OCT-25-BLK9 worst at -11,788). Learnings → `.claude/skills/sync-ictc/SYNC_LEARNINGS.md` (top items: reconciler needs `--unmapped-aware` to stop false-halting on unmapped-block weight — 2nd instance; rc-out reconciliation should be write-based not map-based; trigger INSERT-branch needs the same replacement-location guard the UPDATE branch has). Kill-and-relaunch from sequential→parallel was clean — idempotency held under mid-write interruption (zero duplicate rows). |
| 2026-05-29 | **First unified production + deliveries EXECUTE run (real writes, parallel named agents)** — Ran `production-manager` + `deliveries-manager` as registered named agents in parallel through the full PROPOSE → user approval → EXECUTE gate. **Production (first-ever EXECUTE for this employee):** 5/25–5/28 catch-up wrote 8 `production_shifts` (parent) + 8 runs + 4 downtime + 8 waste + 4 electricity + 1 truck + **33 audit_logs**; DB-verified post-write, watermark **5/23→5/28**, generated cols computed by Postgres (elec 5/25 = 9.0×120 = 1080 kWh); MC #118639 + Ivy #118635 labeled `Blackwood-Processed`; reconcile `ok` (informational, never gates). **Deliveries:** 1 NEW delivery inserted (Ornales `MAY-26-BLK13` D-18D, 671 sacks, 20,250 kg @ ₱42.00) + batch `MAY-26-BLK13` auto-created (STORED, trigger-recomputed to 20,250 kg @ ₱42.00), 6 VALUE_CHANGED→`db_wins` skipped, 50 DUPLICATE_NOOP, watermark **5/26→5/27**, RC #118488 labeled. Zero errors, no parallel Gmail/DB collision, idempotency verified on both (re-run writes nothing). **Surfaced follow-up:** `deliveries-manager.md` Step 6's manual `INSERT INTO audit_logs` double-writes against the existing `deliveries_audit_trigger` — agent worked around it this run + saved the correction to its agent-memory (`.claude/agent-memory/deliveries-manager/project_db_triggers_on_deliveries.md`); a one-line playbook fix to the agent definition is pending. |
| 2026-05-29 | **Production Manager agent built + validated end-to-end (EXECUTE deferred)** — Third ingestion employee shipped. Started by deep-reading the two real source emails (MC "Daily Production Report" = one sheet/day `MM-DD-YY`; Ivy "WASTE PRODUCTION REPORT" = one sheet/month) which surfaced real divergences from the design assumptions: the electricity "120" is a **meter multiplier, not a peso rate** (→ migration `20260529070745` renamed `rate_php_per_kwh`→`meter_multiplier`, added generated `consumption_kwh`, dropped `view_electricity_monthly`; grid `RATE`→`MULT`, `TTL PHP`→`TTL KWH`, un-gated); Ivy's waste headers differ from MASTER but map **positionally, verified 8/8** (FILTER→bf, UNCOOKED/SHELL→trml1, STONES→trml2); MC's "NIGHT" = Ivy's "EVENING" = canonical shift **`E`** (DB already M/E, no migration). Built the deterministic pipeline in `.claude/skills/sync-ictc/scripts/`: `extract_daily_production.py` + `extract_waste_production.py` (with `--since` exclusive watermark filter), 5 classifiers (`classify_production_{runs,downtime,waste,}.py` + electricity/trucks), `reconcile_production.py` (informational, never gates — feed tank empties month-end). Agent at `.claude/agents/production-manager.md` (PROPOSE/EXECUTE, 6 tables, upserts shifts before children, MALFORMED/null-shift never written, KURARAY preserved). PROPOSE validated against live DB: catch-up 5/25–5/28 = 25 NEW rows, 0 malformed — the test caught + fixed a cumulative-workbook window bug (the `--since` flag). **No data written yet (DB still through 5/23); EXECUTE deferred to a unified production+deliveries run on the user's say-so, after a Claude Code restart registers the named agent.** 3 commits: `e80f6f6` (electricity rework), `d244be3` (pipeline), `2539181` (agent + `--since`). See `handoffs/2026-05-29-production-manager-agent-built.md`. |
| 2026-05-29 | **Production module: MASTER backfill + parent-child shifts refactor + Excel ledger UI** — Backfilled 1,411 historical rows from MASTER (production_runs 207, downtime 158, waste 158, electricity 741, trucks 147) + 1,411 audit_logs via 3 new extractors (`extract_master_prod/electricity/trucks.py`). 4 follow-on migrations: `..020000` added production_batch to natural keys (same-day batch crossover), `..030000` added `customer` column to production_runs (KURARAY surfaced — "CEBU implicit" assumption was wrong), `..040000` **restructured to a parent-child shifts model** (`production_shifts` parent; runs/downtime/waste FK via `shift_id`; dropped redundant date/batch/shift cols + 7 SKS cols from waste; in-place, no data lost), `..040001` rewrote `view_production_daily`. Daily tab rebuilt as a single unified Excel ledger (`daily-ledger-grid.tsx`, ~1500 lines): frozen Identity+Production columns (sticky + colgroup + border-separate), inline-editable cells, cell-selection→FloatingStatusBar aggregation, right-click context menu, sticky footer totals with per-column SUM/AVG pills + GRADE filter, DATE click-sort, inline remarks (BAGS + waste-REM removed). Trucks tab pivoted by plate (1 truck = START/END/TTL/FUEL group). Electricity+Trucks monthly summaries removed. **Universal period picker** promoted to module level (`ProductionPeriodProvider` + `PeriodPicker`): Year+Batch shared across all 3 tabs, always visible, batch→month mapping for electricity/trucks. App font swapped to **Atkinson Hyperlegible** (both sans + mono). All 8 subagents set to **Opus 4.8**. Deliveries Manager + RC Out Manager tested end-to-end natively (new decision rules encoded to agent memory). Build: zero TS errors. **Next: build the Production Manager agent** (DB + UI now ready). See `handoffs/2026-05-29-production-ledger-backfill-shifts-refactor.md`. |
| 2026-05-27 | **Production module rewritten to Excel-style inline-editable grids (3 side-by-side on Daily, single grid on Electricity / Trucks). Dialog inputs removed.** — 5 new grid components replace all Dialog-based inputs and read-only tables. Daily tab: horizontal flex, overflow-x-auto. Actions consolidated to `saveBulkProductionRuns/Downtime/Waste/Electricity/Trucks`. Build: zero TypeScript errors. |
| 2026-05-27 | **Production module scaffold (UI + bulk inputs)** — 3 tabs (Daily / Electricity / Trucks), 5 tables wired (`production_runs`, `production_downtime`, `production_waste`, `electricity_readings`, `truck_readings`), 2 summary views (`view_electricity_monthly`, `view_trucks_monthly`). Navbar enabled (`disabled: true` removed). Awaiting agent backfill. Build: zero TypeScript errors. |
| 2026-05-27 | **Production Manager designed (no code yet)** — full `PRODUCTION_DESIGN.md` (589 lines) at `.claude/skills/sync-ictc/`. 5 target tables locked: `production_runs` (date/grade/shift, CEBU implicit, no destination col), `production_downtime` (with DT_REASON from MC's emails), `production_waste` (8 streams mirroring MASTER+Ivy's WASTE PRODUCTION REPORT), `electricity_readings` (daily per-meter MAIN/BUNKHOUSE/PUMP), `truck_readings` (daily per-truck AAV 6111 / KCA 378 / etc). Phase 0 (email inspection) done: confirmed Daily Production Report from mccontinedo.ictc@gmail.com, daily granularity for electricity+trucks, one consolidated XLSX per email with one sheet per production day. Locked: shifts M/E/N (preparing for 3rd shift), grade enum 3X50/6X50/8X50/2X6, full MASTER backfill, NO rc_tank_level table, NO production_waste_sales table (KOREA/LOCAL/ZAMBOANGA waste sales out of scope), daily kg-in/kg-out drift informational only (feed tank empties end-of-month). 14+ other MC email sections (Magnet/Ayag/Re-Classify/Blending/Re-Bagging/Sundry/Refuse/PC Stock) deferred to future Bagging/QC/Sundry managers. 12-hour build estimate across 2 sessions for Phase 1+. |
| 2026-05-27 | **RC Out Manager + RC Movement Auditor agents shipped (not yet tested end-to-end)** — `.claude/agents/rc-out-manager.md` (350 lines, PROPOSE+EXECUTE modes, owns PROPOSED DAILY REPORT → `rc_out` writes); `.claude/agents/rc-movement-auditor.md` (223 lines, read-only watchdog comparing RC MOVEMENT daily fed totals vs rc_out daily sums vs view_rc_movement). Python tools: `extract_proposed_daily.py` (426 lines, per-block sections from one-sheet-per-day xlsx, batch_code derived from BLOCK DATE + BLOCK NO), `extract_rc_movement.py` (234 lines, section-break detection required because sheet has two data sections), `classify_rc_out.py` (258 lines, natural key (date, batch_id, destination='MAIN')), `reconcile_rc_movement.py` (170 lines, exit code 0/1/2 = none/warning/serious). Design doc at `.claude/skills/sync-ictc/RC_OUT_DESIGN.md` (195 lines). Reconciliation verified end-to-end on 5/26: PROPOSED sum of 5 block sections = 45,167 kg = RC MOVEMENT raw_charcoal_fed (drift = 0 kg). RC MOVEMENT thread NEVER labeled processed (cumulative reference data needed every run). HARD gate: serious drift >500 kg halts writes. |
| 2026-05-27 | **Deliveries Manager shipped + end-to-end production test passed** — `.claude/agents/deliveries-manager.md` (298 lines, PROPOSE+EXECUTE modes, owns RC DELIVERIES email → `deliveries` table). Python tools at `.claude/skills/sync-ictc/scripts/`: `fetch_gmail.py` (573 lines, IMAP+App Password, X-GM-RAW search, X-GM-LABELS idempotency), `extract_rc_deliveries.py` (532 lines, multi-row headers, forward-fill dates, B-label→batch_code heuristic with PILED-IN-MONTH remarks fallback, FEEDING AREA→FEED translation), `enrich_prices.py` (286 lines, matches Czarina's RAW CHARCOAL PURCHASES by (supplier,truck,weight) since payment_date != delivery_date), `classify_deliveries.py` (264 lines, NEW/CHANGED/NOOP per natural key date+batch+block+weight). Real production run today: 2 NEW rows inserted (5/23 Ornales MAY-26-BLK9 D-17A 18,725kg ₱41.50 + 5/25 Tag-at MAY-26-FEED6 19,330kg ₱40.00), 6 VALUE_CHANGED routed to db_wins (DONE FEEDING was RC OUT info, ASAH was typo), 48 DUPLICATE_NOOP filtered, batch MAY-26-FEED6 auto-created, 7 Gmail threads labeled, 2 audit_logs written, DB latest advanced 5/21→5/25. Re-test after user deleted 3 rows: agent correctly identified all 3 as NEW. |
| 2026-05-27 | **Gmail auth strategy locked: IMAP + App Password** — abandoned Google Cloud OAuth, Composio hosted MCP, klodr community MCP after evaluating all four paths. Final: pure IMAP via Python stdlib `imaplib`, App Password generated at https://myaccount.google.com/apppasswords (requires 2FA), credentials at `~/.config/sync-ictc/credentials.env` mode 0600 with GMAIL_USER + GMAIL_APP_PASSWORD. Zero third-party trust, zero Google Cloud project, 2-min user setup. fetch_gmail.py enforces 0600 perms and refuses to run on looser files. Idempotency via Gmail label `Blackwood-Processed` (label_id Label_14) applied to threads after successful ingestion. |
| 2026-05-27 | **Email ingestion Phase A shipped (manual XLSX upload pipeline)** — extract → row-level diff against existing DB rows → human review → commit to `deliveries`. Backend: migration `20260527000000_create_ingestion_watermarks.sql` applied to live Supabase (1 row per report type, tracks last email scanned for Phase B Gmail polling). `xlsx@0.18.5` (SheetJS) installed. `lib/jarvis/extractors/rc-deliveries.ts` — `RcDeliveriesExtractor` class implementing `ReportExtractor`. Parses the user's RC DELIVERIES daily XLSX format (date / supplier / batch / block_loc / truck / sacks / weight / lab metrics / cost). Flexible column-name matching, per-cell try/catch, accumulates warnings, confidence drops 0.15 per warning. `lib/jarvis/classifier.ts` — `classifyEmail()` + extractor REGISTRY (Phase A has 1 entry, Phase B adds 8 more). `lib/jarvis/diff-engine.ts` — `classifyRow()` runs natural-key SELECT against target table, returns NEW / DUPLICATE_NOOP / VALUE_CHANGED with diff details. Natural key for RC DELIVERIES: `(transaction_date, batch_code, block_loc, weight_kg)`. Deep equality on JSONB `lab_results`. Server actions at `app/(app)/review-queue/actions.ts`: `uploadForReview(FormData)`, `listPending()`, `getReviewDetail(id)`, `approveReview({ id, decisions })`, `rejectReview({ id, reason })`. Approve writes to `deliveries` via existing audit-log machinery. Per-row decisions for VALUE_CHANGED: `email_wins` (UPDATE), `db_wins` (skip), `both` (INSERT as split shipment). DUPLICATE_NOOP rows are silently filtered before persistence — never reach the queue. Frontend: `app/(app)/review-queue/page.tsx` (server component, role-gated Owner/Admin/Dev). `components/review-queue/`: `ReviewQueueClient` (orchestrator, list ↔ detail swap), `UploadXlsxForm` (file picker + report type select), `PendingReviewList` (responsive card grid, hover-lift, confidence dot, count badges), `ReviewDetailPanel` (sticky glass header + diagnostic banner + table + sticky footer + AlertDialog reject confirmation), `ClassifiedRowsTable` (Excel-dense, RC IN column order, font-mono numbers, amber left-border on changed cells with email-bold-over-DB-strikethrough), `RowDecisionToggle` (3-state segmented buttons), `ConfidenceDot`. Navbar updated: `/review-queue` breadcrumb + Modules dropdown link (role-gated). All error toasts use `errorToast()` from `lib/toast.ts` (persistent + Copy button — HARD RULE). CONTEXT.md files: `app/(app)/review-queue/CONTEXT.md` (new) + `app/(app)/jarvis/CONTEXT.md` updated with ingestion pipeline section. Build: zero TypeScript errors. **Not yet built (Phase B):** Gmail OAuth + polling cron, 8 remaining extractors (Daily Production, Waste, RC Movement, FLECON, Bagged Powder, QC × 2, Maintenance), validation rule engine §7, LLM fallback for ambiguous rows, auto-commit threshold tuning. |
| 2026-05-27 | **Error toast hard rule + wrapper** — `lib/toast.ts` exports `errorToast(message, { description? })` that enforces `duration: Infinity` + close button + Copy action (copies full error to clipboard). 14 `toast.error()` call sites across 8 files migrated (admin, settings, rc-in × 2, rc-out × 2). Jarvis inline chat error gets a Copy button next to Retry. Rule documented in CLAUDE.md + memory file `feedback_error_toasts.md`. **Why:** users paste errors into Claude chats; auto-dismiss forces screenshots which waste tokens on OCR. |
| 2026-05-27 | **Jarvis chat polish** — `query_deliveries` SELECT extended to include `lab_results` + `remarks` (was missing, broke quality questions). Tool description rewritten to spell out every returned field and tell Sonnet to weight by `weight_kg` for aggregations. `react-markdown` + `remark-gfm` installed; `JarvisMessage` now renders assistant turns as markdown with chat-bubble-appropriate styling (scrollable tables, mono code, tight spacing, semantic tokens). User-side messages stay plain. System prompt rule #8 rewritten to ALWAYS include price columns (avg_cost / cost_basis / php_total) in any data table — no longer opt-in. |
| 2026-05-26 | **Jarvis AI chat foundation shipped (scaffold)** — slide-out chat agent accessible from every `(app)/*` page. Backend: migration `20260526020000_create_jarvis_tables.sql` applied to live Supabase with 4 tables (`jarvis_conversations`, `jarvis_messages`, `jarvis_learnings`, `pending_review`) + RLS + indexes. Anthropic SDK wired (`lib/anthropic/client.ts`, model = `claude-sonnet-4-6`, max_tokens=4096). System prompt at `lib/jarvis/system-prompt.ts` (~2.6K tokens, prompt-cache eligible via `cache_control: 'ephemeral'`) covering ICTC business context, four inventory modules, block_loc format, status enum, lab metrics, supplier set, tone rules. Tool handlers at `lib/jarvis/tool-handlers.ts` with `TOOL_DEFINITIONS` + `executeToolCall()` dispatch and 2 starter tools (`query_batches`, `query_deliveries`) — both read-only, both strip cost data when user role is `production`. Server actions at `app/(app)/jarvis/actions.ts` — `chat()` (tool-use loop max 5 iterations), `listConversations()`, `getMessages()`, `clearConversation()` (the /clear command). Extractor skeleton at `lib/jarvis/extractors/` (types + `DailyProductionExtractor` stub) ready for Phase 2 XLSX parsing. Frontend: `components/jarvis/` directory with `JarvisProvider` (open/closed state, Cmd+K shortcut, localStorage persistence `bw_jarvis_open`), `JarvisFloatingButton` (fixed bottom-right FAB), `JarvisChatPanel` (slide-out Sheet, 480px desktop / full mobile, canonical dialog glass), `JarvisMessage` (user/assistant/tool/system role styling, two-click /clear confirmation), `JarvisInput` (textarea Enter-to-send, Shift+Enter newline, auto-grow), `JarvisConversationList`, `useJarvisChat` hook. Sheet primitive added at `components/ui/sheet.tsx` (was missing from shadcn). Mounted in `app/(app)/app-shell.tsx` via dynamic import (ssr:false, same pattern as Navbar). CONTEXT.md files at `app/(app)/jarvis/` + `components/jarvis/`. Build: zero TypeScript errors, dev server boots clean. **Not yet built (Phase 2+):** streaming responses, Gmail integration, email polling, XLSX parsing, `/review-queue` page, writing to `jarvis_learnings`. Smoke test pending — needs Renzo's authenticated session. |
| 2026-05-26 | Frontend: PCA/PCB warehouse zones wired into Blocking grid and `block_loc` validation. `lib/validation.ts` regex extended to `^(PCA\|PCB\|[A-DF])-\d{1,2}[A-D]$` — capture group now extracts the warehouse prefix (was hardcoded to `trimmed[0]`); new `WAREHOUSE_COLS: Record<string, [number, number]>` lookup replaces the hardcoded 1-20 col range so PCA/PCB validate to cols 15-17 with improved per-warehouse error messages. `lib/rc-utils.ts` `calculateWhse()` checks `PCA-`/`PCB-` prefixes before the single-char fallback so `PCA-15A` → `'PCA'` (was falling through to `'-'`). Blocking constants gain `colStart: number` on `WarehouseConfig` + two new entries (`PCA`/`PCB`, 3 cols × 3 rows = 9 slots each, colStart=15) plus a `STANDARD_WAREHOUSES = ['A','B','C','D']` const. `blocking-grid.tsx` iterates `Object.keys(WAREHOUSES)` for render order, `STANDARD_WAREHOUSES` drives the "ALL" baseline (PCA/PCB stay opt-in to preserve the 220-slot operator mental model), PCA/PCB chips appear after a thin divider next to WHSE A/B/C/D. `WarehouseSection` uses `colStart` for column header labels and adds a prepared-charcoal subtitle (`PCA · Prepared Charcoal`) + `max-w-[280px]` on the narrow grid. `WarehouseRow` accepts `colStart` and computes `col = colStart + i` for locKey math. `app/(app)/inventory/blocking/CONTEXT.md` updated with PCA/PCB rows, "PC = Prepared Charcoal" note, 238-slot grand total, and a "future polish" note about auto-show-when-occupied. Build: zero TypeScript errors. |
| 2026-05-26 | Schema: widened `chk_block_loc_format` (deliveries) and `chk_location_ref_format` (batches) CHECK constraints to accept PCA/PCB prefixes (`^(PCA|PCB|[A-DF])-\d{1,2}[A-D]$`). PCA/PCB are physical subdivisions of the A-row 15-17 area used for prepared charcoal sundrying. Migration: `20260526000000_widen_block_loc_check_for_pca_pcb.sql`. rc_out.block_loc confirmed to have no format constraint — no change needed there. `types/supabase.ts` regenerated. |
| 2026-05-26 | RC Movement frontend: new "Movement" tab (4th) added to `/inventory`. Tab union extended in `inventory-tab-context.tsx` (`'movement'`) and registered in `sheet-tabs.tsx`. `inventory-view.tsx` adds 4th conditional render block. Lazy loader `components/rc-movement-lazy-tab.tsx` reads `?y=&m=` URL params on mount, defaults to current month, fetches via `fetchRcMovementData(year, month)`, manages refetch on picker change with `window.history.replaceState` URL sync. Table `rc-movement/rc-movement-table.tsx` mirrors Excel columns exactly (DATE/DAY/TTL KG/BLOCKS/START BAL/BATCH FED/TTL FED/% LOSS/PHP/KG/PHP TTL/STATUS/BLOCK LOC). Architecture: single flat `VirtualItem` array (`{ kind: 'day-header' \| 'lane' }`) flattened from day groups, rendered via raw `<table>` + `@tanstack/react-virtual` (bypasses TanStack Table's row model since grouped virtual rows don't map cleanly to `ColumnDef`). Day-header rows are single `<td colSpan>` glass cells (`bg-muted/90 backdrop-blur-sm`) with summary `DAY 22 · May 22, 2026 · TTL KG 31,908 · ₱1,530,720 · 4 lanes`. % LOSS: italic+muted with `*` superscript when active (provisional), solid when closed (final), color-coded (<0 red, >30% amber). STATUS: green dot active / red ✕ line-through closed. Role gating: PHP/KG and PHP TTL columns filtered out entirely (not blanked) when `!canViewPrices`; day-header omits ₱ segment. Month picker: custom in-table footer with `[← Prev] May 2026 [Next →]` + year `<Select>` — lighter than `DeliverySheetFooter`. SSR=false wrapper at `rc-movement/components/rc-movement-table-wrapper.tsx`. Redirect stub at `rc-movement/page.tsx` → `/inventory?y=&m=`. New CONTEXT.md files: `rc-movement/CONTEXT.md` + `app/(app)/inventory/CONTEXT.md` (parent tab container overview). Build: zero TypeScript errors. |
| 2026-05-25 | RC Movement backend: `view_rc_movement` SQL view (3-CTE: `batch_meta` → `day_agg` → `with_windows`; one row per batch_id/date; running balance, cum_fed, start_balance, pct_loss, feed_day_n, status via window functions). Migration `20260525000000_create_view_rc_movement.sql` applied to live Supabase. Patch migration `20260525000001_fix_rc_movement_block_loc_empty_string.sql` — `NULLIF(rc.block_loc, '')` so empty-string block_loc falls back to `batches.location_ref`. Server action `fetchRcMovementData(year, month)` at `app/(app)/inventory/rc-movement/actions.ts` — month-scoped query (`select('*')` to avoid multi-line select type-inference issue), date-group in JS, Production-role cost scrubbing (php_per_kg / php_total / ttlPhp → null). Exports `RcMovementRow`, `RcMovementDay`, `RcMovementData`. `types/supabase.ts` regenerated. Build: zero TypeScript errors. **Note:** live Supabase rc_out latest = 2026-02-28; user's Excel has data through 2026-05-22 — schema is current but data is 3 months behind. |
| 2026-03-02 | Tenant config extraction (`lib/widgets/adapters/tenant-config.ts`): moved `CHARCOAL_FIELDS` from `charcoal-special.ts` and chart series/group/preset definitions from `charcoal-chart.ts` into a single tenant config file. Both adapters now import from `tenant-config.ts`. Extracted `migrateLegacyPrefs()` from `DashboardGrid.tsx` into `lib/dashboard/migrate-prefs.ts` — pure function handling all localStorage migration/normalization. Refined `WarehouseOccupancyWidget` responsive sizing: xs/sm width shows minimal labels + thin bars, md shows compact stats, lg/xl shows full stats. Build: zero TypeScript errors. |
| 2026-02-20 | SpecialChartWidget system rework. Replaced `QualityScatterWidget` + `charcoalScatterAdapter` with a fully generic `SpecialChartWidget` (scatter/pie/donut), `charcoalSpecialAdapter`, and supporting files. New files: `special-chart/types.ts` (`FieldDef`, `SpecialChartData`, `SpecialChartSettings`, `SpecialChartType`, `ScatterGranularity`), `special-chart/aggregation.ts` (pure aggregation utilities: `niceScale`, `numericFields`, `categoricalFields`, `fieldLabel`, `fieldUnit`, `granularityKey`, `aggregateScatterData`, `aggregatePieData`, `buildColorMap`, `YEAR_COLORS`, `GENERIC_PALETTE`), `special-chart/scatter-renderer.tsx` (generic SVG scatter; X/Y/colorBy all field-driven), `special-chart/pie-renderer.tsx` (SVG pie/donut with arc path math, GENERIC_PALETTE, donut center total), `special-chart/SpecialChartWidget.tsx` (shell dispatcher with settings popover — chart type toggle, field dropdowns, granularity, quarter filter tree). Adapter: `lib/widgets/adapters/charcoal-special.ts` — one flat row per delivery, 11 numeric + 7 categorical `FieldDef` fields, `CHARCOAL_FIELDS` constant. Deleted: `components/widgets/quality-scatter/` (entire directory), `lib/widgets/adapters/charcoal-scatter.ts`. Updated: `components/widgets/index.ts` (registry entry `special-chart`), `lib/dashboard/types.ts` (`specialChartSettings` replaces `scatterSettings`), `components/dashboard/DashboardGrid.tsx` (import swap, prop rename, handler rename, `renderWidgetContent` swap, `loadPrefs` migration for existing users), `app/(app)/page.tsx` (adapter swap), `lib/widgets/mock-data.ts` (`CHARCOAL_SPECIAL_DATA` replaces `CHARCOAL_SCATTER_DATA`), `components/widgets/CONTEXT.md`. Build: zero TypeScript errors. |
| 2026-02-19 | Simplified chart year model from fiscal years (Mar–Feb, 'FY' prefix) to plain calendar years. `charcoal-chart.ts`: replaced `getFiscalYear`/`getFiscalMonth` with `getCalYear`/`getCalMonth`; accumulator is now `Map<calYear, MonthAcc[12]>` (0=Jan). `FiscalCalEntry.fiscalYear` stores plain year string ('2025', '2026'); `fiscalMonth` = `calIdx` = 0=Jan…11=Dec. `STATIC_FISCAL_CALENDAR` in `mock-data.ts` updated: Jan 2026 → `fiscalYear:'2026', fiscalMonth:0`, Feb 2026 → `fiscalYear:'2026', fiscalMonth:1`. `dataYears: ['2025', '2026']`. `getFilterIndices` in `utils.ts`: removed `'FY' +` coercion; quarters updated to Q1=Jan–Mar, Q2=Apr–Jun, Q3=Jul–Sep, Q4=Oct–Dec. `ChartWidget`: `CURRENT_FY` → `CURRENT_YEAR`, `FISCAL_MONTH_LABELS` → `MONTH_LABELS` (Jan–Dec order), quarter dropdown labels updated, comparison slice filter `onChange` now auto-populates label from selected value. Build: zero TypeScript errors. |
| 2026-02-19 | Dashboard persistence foundation (`lib/dashboard/profile-store.ts`, multi-profile `bw_v1` store with migration from `bw_d6_prefs`). Shared types extracted to `lib/dashboard/types.ts` (`D6Prefs`, `LayoutItem`) to avoid circular imports. Grid reflow fix (`compactVertically` on pin, `prePinLayout` snapshot in `D6Prefs` for restore on unpin). Removed Inventory + Admin nav chips from KPI adapter (`lib/widgets/adapters/charcoal-kpi.ts`) + mock data (`lib/widgets/mock-data.ts`). Per-chip settings builder: `KPIChipOverride` type + `chipOverrides` in `KPIStripSettings` (`types.ts`), `applyChipOverrides()` in `KPIStripWidget.tsx`, inline expand panel in settings popover with label/pinned/showComparison/showSparkline controls (now `w-64`). Active profile name shown in dashboard header. Auto-fetch live KPI on mount when saved period != 'month'. Build: zero TypeScript errors. |
| 2026-02-19 | Sticky KPI Bar pinning feature. `D6Prefs` extended with `stickyKpi?: boolean`. Pin button added to KPI strip `WidgetShell` header action — pins the strip out of the grid into a second row of the sticky dashboard header. Unpin button in sticky row restores to grid with 200ms exit animation. `animate-kpi-enter` / `animate-kpi-exit` CSS keyframes added to `globals.css`. `STICKY_BAR_SIZE` module-level constant provides xl/sm tier to `WidgetSizeContext`. `IntersectionObserver` sentinel adds `shadow-lg` when header scrolls past viewport top. Mobile guard (`isMobile`, `max-width: 640px`) skips pinned mode on small screens — strip stays in grid. `showStickyBar` / `showKpiInGrid` derived booleans gate grid filter and map render loop. Build passes zero TypeScript errors. |
| 2026-02-19 | KPI Strip Widget Full Customization System. Extended `KPIData` port with `variant`, `thresholds`, `sparkline`, `comparison` (KPIComparison), `flowData` (KPIFlowData), `pinned`, `drilldown`. Extended `KPIStripSettings` with `hidden`, `order`, `chipMode`, `period`. Created `chips.tsx` (pure chip variant renderers: `DefaultChip`, `FlowChip`, `ProgressChip`, `RatioChip`, `Sparkline`, `ComparisonLine`, `getThresholdColor`). Created `settings-popover.tsx` (gear-icon popover: visibility toggle, reorder, density mode). Refactored `KPIStripWidget.tsx` with period selector (D/W/M/Q/Y), pinned-first xs/sm behavior, chip dispatcher. Updated `DashboardGrid.tsx`: `kpiSettings` in `D6Prefs`, `handleKpiSettingsChange`, `liveKpiData` state, `KPIStripSettingsPopover` in headerAction slot, inner `renderWidgetContent` function. Created `app/(app)/actions.ts` with `fetchKpiData(period)` server action. Updated `charcoalKpiAdapter` with `fetchWithPeriod()`, 6-query `queryAndBuild()` (adds sparkline query), new chip fields (pinned, variant, thresholds, drilldown, comparison, flowData). Updated `CHARCOAL_KPI_DATA` static mock with all new fields. Build passes zero TS errors. |
| 2026-02-19 | Removed all mock data fallbacks from dashboard adapter error handling. `WidgetError` component created (`components/dashboard/WidgetError.tsx`) — amber warning state with one-click clipboard copy of full diagnostic string (adapter ID, timestamp, stack trace). `DashboardGridProps` extended with `kpiError`, `chartError`, `warehouseError`, `scatterError`. `page.tsx` `formatAdapterError()` helper formats copy-friendly diagnostic strings. `DashboardGrid.tsx` checks error/data per widget type; renders `WidgetError` when either condition is met. All mock data fallback imports removed from both files. Build passes zero TS errors. |
| 2026-02-19 | Live Supabase adapters for all 4 dashboard widgets. `QualityScatterWidget` and `WarehouseOccupancyWidget` decoupled from mock-data. Port types (`ScatterPoint`, `WarehouseData`) created. `lib/widgets/adapters/` directory created with `types.ts`, `charcoal-kpi.ts`, `charcoal-chart.ts`, `charcoal-warehouse.ts`, `charcoal-scatter.ts`. `DashboardGrid` accepts `DashboardGridProps` (all optional, fall back to static). `DashboardShell` is the new SSR-safe client wrapper. `app/(app)/page.tsx` converted to async Server Component — runs all 4 adapters in `Promise.allSettled` with static fallback on failure. Build passes with zero TypeScript errors. |
| 2026-02-19 | `KPIStripWidget` decoupled from hardcoded data. Accepts `data: KPIData[]` prop. `KPIData` + `KPIStripSettings` interfaces defined in `kpi-strip/types.ts`. Static adapter exports `CHARCOAL_KPI_DATA` from `lib/widgets/mock-data.ts`. `DashboardGrid` passes it via prop. Zero domain knowledge remains in widget layer. |

---

## How to Read This File

- `[ ]` — Not started
- `[/]` — In progress
- `[x]` — Done
- **ETA** = estimated working days (not calendar days)
- Phases are sequential — each phase depends on the previous one being substantially complete
- Sub-tasks within a phase can sometimes be parallelized

---

## Current Sprint

**Focus:** Widget Resizing Refinement
**Started:** 2026-02-19
**Goal:** All widgets handle resizing as gracefully as `ChartWidget` — text scales, elements reflow, nothing clips at any size tier.

### Tasks
- [ ] Audit current resizing behavior across all 4 widgets
- [x] Refine `KPIStripWidget` — chip variants (flow/progress/ratio/default), pinned xs/sm, period selector, settings popover
- [x] Live Supabase prefs sync — `user_dashboard_prefs` table, `loadDashboardPrefs` / `saveDashboardPrefs` server actions, 1500ms debounce, `serverPrefs` prop seeds grid on hydration (Supabase-primary, localStorage-cache)
- [x] Multi-profile localStorage store — `lib/dashboard/profile-store.ts`, `bw_v1` key, migration from legacy `bw_d6_prefs`
- [x] Sticky KPI Bar — Pin/PinOff, second sticky header row, `prePinLayout` snapshot, mobile guard, `animate-kpi-enter`/`animate-kpi-exit`
- [x] `WidgetError` component — amber error state with one-click diagnostic clipboard copy
- [x] Calendar-year chart model — replaced fiscal-year (FY prefix, Mar–Feb) with plain calendar years (Jan–Dec)
- [x] Refine `QualityScatterWidget` → replaced with `SpecialChartWidget` (scatter/pie/donut, generic field system)
- [x] Refine `WarehouseOccupancyWidget` — progress bars, stats collapse at small sizes, tier-based label/footer adaptation
- [ ] Review `WidgetShell` — consider adding `fontScale` to `WidgetSizeContext`
- [ ] Manual QA across desktop, tablet (820px), mobile (393px) viewports

---

## Phase 1 — Widget Data Layer Decoupling
**ETA:** 5–8 days · **Status:** Complete · **Completed:** 2026-02-19

Break the static adapter coupling so widgets can receive data from any source. This is the foundational work that enables multi-tenant use.

### Tasks
- [ ] Move `CHART_PALETTE` and `SLICE_PALETTE` from `mock-data.ts` → `components/widgets/chart/constants.ts`
- [x] Refactor `getFilterIndices()` in `chart/utils.ts` — accepts `fiscalCalendar` as parameter instead of importing `FISCAL_TO_CALENDAR`
- [x] Convert `QualityScatterWidget` to accept data via props
- [x] Convert `WarehouseOccupancyWidget` to accept data via props
- [x] Define `WidgetAdapter<TPort>` interface type in `lib/widgets/adapters/types.ts`
- [x] Build live adapters: `charcoal-kpi`, `charcoal-chart`, `charcoal-warehouse`, `charcoal-scatter`
- [x] Wire live adapters into dashboard page with `Promise.allSettled` + `WidgetError` fallback on failure
- [x] Update `components/widgets/CONTEXT.md`

### Definition of Done
- Zero imports from `mock-data.ts` inside `components/widgets/` (except for default fallbacks passed via props)
- At least one widget renders live Supabase data via an adapter
- All existing widget behavior unchanged (no regressions)

---

## Phase 2 — Dashboard Persistence & Multi-Device
**ETA:** 4–5 days · **Status:** Complete (core persistence) · **Completed:** 2026-02-19

Dashboard layouts and prefs persisted to Supabase so users can see their layout on any device. Multi-profile support added via `profile-store.ts`.

### Tasks
- [x] Design `user_dashboard_prefs` table schema (`user_id` PK, `prefs` JSONB, `updated_at`)
- [x] Create Supabase migration and RLS policy (users can only access their own row)
- [x] Add Supabase persistence to `DashboardGrid.tsx` — `saveDashboardPrefs` with 1500ms debounce
- [x] Add localStorage as offline cache (`bw_v1` key, `profile-store.ts`) — Supabase-primary, localStorage-cache
- [x] `loadDashboardPrefs()` server action seeds `serverPrefs` prop at page render (no cold-start flicker)
- [x] `lib/dashboard/profile-store.ts` — pure multi-profile store; migrates from legacy `bw_d6_prefs`
- [x] `lib/dashboard/types.ts` — `D6Prefs` + `LayoutItem` extracted to avoid circular imports
- [ ] Add device-type detection (mobile / tablet / desktop) for responsive layout profiles
- [ ] Add responsive column breakpoints — 12 cols (desktop) → 6 (tablet) → 2 (mobile)

### Definition of Done
- Dashboard layout saved per user in Supabase
- Layout edits on desktop visible on phone after refresh
- Offline fallback works when Supabase is unreachable

---

## Phase 3 — Widget Registry V2 & New Widget Types
**ETA:** 5–7 days · **Status:** Not Started · **Depends on:** Phase 1

Make the widget system richer and more extensible for general-purpose use.

### Tasks
- [ ] Extend `WidgetDefinition` with `dataPort` type for typed adapter binding
- [ ] Add `category` field to registry (e.g., "Analytics", "Operations", "Monitoring")
- [ ] Support multi-instance for all widget types (not just charts)
- [ ] Build `TableWidget` — generic dense data table widget (TanStack Table inside a widget shell)
- [ ] Build `BlockingGridWidget` — wrap blocking grid pattern as a dashboard-embeddable widget
- [ ] Build `TextWidget` — markdown/rich-text display for notes, announcements
- [ ] Redesign WidgetPicker with category sections and search
- [ ] Update `components/widgets/CONTEXT.md` and `components/widgets/index.ts`

### Definition of Done
- Widget picker shows categories
- At least 3 new widget types functional
- Any widget type can have multiple instances

---

## Phase 4 — Mobile-Forward Design Pass
**ETA:** 5–8 days · **Status:** Not Started · **Depends on:** Phase 2, Phase 3

The "do everything on your phone" sprint. Touch-first UX, bottom sheets, responsive polish.

### Tasks
- [ ] Audit all interactive elements for 44×44px minimum touch targets
- [ ] Replace popovers with bottom sheets on mobile (< 768px)
- [ ] Add swipe-to-dismiss on widget detail panels and slide-overs
- [ ] Implement pull-to-refresh on dashboard
- [ ] Optimize blocking grid for portrait mobile — vertical scroll with fixed column headers
- [ ] Test navigation flow on iPhone 14 Pro (393×852) and Pixel 7 (412×915)
- [ ] Test on iOS Safari and Android Chrome for rendering differences
- [ ] Add haptic feedback triggers for iOS (via Capacitor later)

### Definition of Done
- All core workflows (dashboard view, widget config, inventory tables) usable with thumb-only navigation
- No horizontal scroll on any page at 375px width
- Touch targets ≥ 44×44px everywhere

---

## Phase 5 — Multi-Platform Packaging
**ETA:** 8–12 days · **Status:** Not Started · **Depends on:** Phase 4

Ship as a PWA, Electron desktop app, and Capacitor mobile app.

### Tasks
- [ ] Add PWA manifest (`manifest.json`) + service worker for installable web app
- [ ] Configure `next-pwa` or custom service worker with offline caching strategy
- [ ] Electron wrapper — main process, preload, window config
- [ ] Build Windows `.exe` installer (Electron Builder)
- [ ] Build macOS `.dmg` installer (Electron Builder)
- [ ] Capacitor project init + iOS/Android config
- [ ] Capacitor plugin integration (Push Notifications, Haptics, App Badge)
- [ ] Cross-platform notification bridge (web push → Capacitor push)
- [ ] CI/CD pipeline for multi-platform builds
- [ ] App Store / Play Store submission prep (icons, screenshots, descriptions)

### Definition of Done
- Web app installable as PWA from Chrome/Safari
- Electron `.exe` and `.dmg` build and launch successfully
- Capacitor iOS build runs on simulator
- Capacitor Android build runs on emulator
- Push notifications reach all platforms

---

## Future Backlog (Unscheduled)

These are ideas and features that may be prioritized into a future phase:

- [ ] Multi-tenant support — organization switcher, data isolation per tenant
- [ ] Custom widget builder — drag-and-drop widget creation UI
- [ ] Data connector marketplace — connect Shopify, QuickBooks, Google Sheets, etc.
- [ ] AI insights widget — GPT-powered anomaly detection on inventory data
- [ ] Audit trail / changelog for dashboard edits
- [ ] White-label theming — tenants can customize colors, logo, branding
- [ ] Role-specific default dashboards — different layouts per user role
- [ ] Export/import dashboard layouts as JSON
- [ ] Collaborative editing — multiple users editing the same dashboard
- [ ] Automated test suite (Playwright E2E + Vitest unit tests)

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-02 | Tenant config modularity (Phase A): created `lib/widgets/adapters/tenant-config.ts` with `TenantFieldConfig`, `TenantChartConfig`, `CHARCOAL_FIELD_CONFIG`, `CHARCOAL_CHART_CONFIG`. Refactored `charcoal-special.ts` and `charcoal-chart.ts` to import field/series/preset definitions from `tenant-config.ts` instead of defining inline. Extracted `migrateLegacyPrefs()` from `DashboardGrid.tsx` into `lib/dashboard/migrate-prefs.ts` — all migration/normalization logic in a standalone pure function. Refined `WarehouseOccupancyWidget` responsive sizing: xs/sm width shows minimal labels + compact bars, md shows partial stats, lg/xl shows full stats; footer adapts. Build: zero TypeScript errors. |
| 2026-02-19 | Sticky KPI Bar: `stickyKpi` pref, Pin/PinOff buttons, second header row with `WidgetSizeContext.Provider`, sentinel IntersectionObserver for shadow-on-scroll, mobile guard, `animate-kpi-enter`/`animate-kpi-exit` keyframes. Build: zero TypeScript errors. |
| 2026-02-19 | KPI Strip full customization: new chip variants (flow/progress/ratio), threshold coloring, sparklines, MoM comparison, period selector, settings popover (visibility + reorder + density). `chips.tsx` + `settings-popover.tsx` created. `KPIStripWidget` refactored. `DashboardGrid` wired with `kpiSettings` persistence + `liveKpiData` state. `app/(app)/actions.ts` created with `fetchKpiData` server action. `charcoalKpiAdapter.fetchWithPeriod()` added with 6-query build logic. Build: zero TypeScript errors. |
| 2026-02-19 | Live Supabase adapters implemented for all 4 widgets. Phase 1 widget decoupling tasks completed. `ScatterPoint`/`WarehouseData` port types created. `lib/widgets/adapters/` directory created with `WidgetAdapter<TPort>` base interface and 4 charcoal adapters. `page.tsx` converted to async Server Component with `Promise.allSettled` + static fallback pattern. `DashboardShell` created as SSR-safe client wrapper. `DashboardGrid` accepts `DashboardGridProps`. Build: zero TypeScript errors. |
| 2026-02-19 | `KPIStripWidget` fully decoupled — `KPIData`/`KPIStripSettings` types created, `CHARCOAL_KPI_DATA` static adapter added, widget now accepts `data` prop with zero domain knowledge in platform layer. |
| 2026-02-19 | Initial timeline created. Codebase audit confirmed hexagonal architecture is ready for general-purpose pivot. Current sprint set to widget resizing refinement. |
