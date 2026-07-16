# Handoff — 2026-06-16 — Summaries feature shipped · supplier analytics + data-quality rules · ICTC routing restructure · sync token-lean · 6/12 sync

Prior handoff: `handoffs/2026-06-11-blackwood-table-rc-movement-campaign-jarvis-design.md`

## TL;DR
Very long session on branch **`feat/ictc-modules-routing`** (pushed to origin, NOT yet merged). Five arcs: (1) **ICTC architecture audit → routing restructure** — `/inventory/blocking` and `/inventory/rc-movement` are now real routed pages (were client tabs), `?tab=`/`?block=` URL state, nested-Inventory navbar menu, breadcrumb registry, **plus 4 price/cost leaks closed** server-side behind `canViewPrices()` (committed `ec15a3c`/`1e1e334`/`e4423c4`). (2) **Made the daily ICTC sync token-lean** — the 4 sync employees now run on **Sonnet** with tail-scoping + a `RULES_DIGEST.md` instead of the full ledger (~420k→~80-120k tokens/run; committed `07e15e5`). (3) **Built the permanent `Summaries` feature** at **`/summaries`** (ICTC module) — a "By Period" + "By Supplier" toggle, each with a multi-series price-line/volume-area graph, RC-IN-format table with Excel cell-selection + sum/avg popup, and (supplier) a slide-out panel with subgroup drill-down (committed `a4c03a9`). (4) A long series of **data-quality rules** baked into a SQL `canonical_supplier()` helper + the analytics views (see Critical Learnings). (5) Ran a **6/12 ICTC sync** (DB writes live, not git).
**Next concrete action:** open a **PR with base `dev`** (NOT main) for `feat/ictc-modules-routing` → `https://github.com/renzogabrielsy/blackwood/pull/new/feat/ictc-modules-routing`. Then next session, **run the ICTC sync** — watermarks to beat: **deliveries 6/12, rc_out 6/12, production_shifts/electricity 6/11, trucks 6/10**; the **6/12 production waste is HELD** pending MC filing 6/12 production.

## What shipped

### Summaries feature (`a4c03a9` — `feat/ictc-modules-routing`)
- **Route `app/(app)/summaries/`**: `page.tsx` (server, fetches both period + supplier analytics), `summaries-client.tsx` (`?view=period|supplier` toggle shell), `supplier-brief-client.tsx` (the By-Supplier view), `actions.ts` (`fetchSupplierAnalytics` + `SupplierMonthRow`/`SupplierYearSummary`/`SupplierSubgroup`/`SupplierAnalytics` interfaces), `CONTEXT.md`.
- **By Period** view = reuses `AnalystBriefClient` imported from `app/(app)/price-demos/demo4/` (the design demo it graduated from). Multi-YEAR overlay (each year a color, price line + volume area), year picker dropdown, Months/Quarters granularity, monthly table.
- **By Supplier** view = single year (dropdown), Months/Quarters + period multi-select, supplier-overlay graph (default top-3 by volume, cap 6, searchable "add supplier" since 2026 has ~41 suppliers), RC-IN-format supplier table (sortable, ₱-gated, Excel cell-selection), and a **slide-out `Sheet` panel** on supplier-name click showing year stats + the supplier's own mini chart + a **"Made up of" subgroup breakdown**.
- **Navbar** (`components/navbar.tsx`): "Summaries" added to the ICTC·Davao `MODULES`; `/summaries` breadcrumb entry.
- **Demos** `app/(app)/price-demos/demo1–4` + `_mock/data.ts` + index committed too (demo4 is still the implementation home of the period view — see learnings).

### Supabase analytics views + migrations (all in `a4c03a9`, applied to remote)
- `view_delivery_monthly_analytics` (period; year×month) + `view_delivery_yearly_analytics`.
- `view_delivery_supplier_monthly_analytics` + `view_delivery_supplier_yearly_analytics` (year×[month×]supplier).
- `view_delivery_supplier_subgroup_yearly_analytics` (year × main_supplier × subgroup) — powers the panel breakdown.
- **`canonical_supplier(text)` IMMUTABLE helper** — the single source of truth for supplier grouping (see learnings). All supplier views call it.
- Migrations (chronological): `..._create_view_delivery_monthly_analytics`, `..._create_view_delivery_supplier_analytics`, `..._exclude_sundried_from_delivery_analytics` (over-broad, superseded), `..._correct_sundried_exclusion_keep_inputs`, `..._normalize_supplier_grouping_upper_trim`, `..._exclude_refeed_recook_and_alias_baguio_tipalan`, `..._canonical_supplier_helper_and_subgroups`, `..._canonical_supplier_nazareno_alias`. `types/supabase.ts` regenerated.

### ICTC routing restructure (committed earlier this session: `ec15a3c`, `1e1e334`, `e4423c4`)
- `/inventory/blocking` + `/inventory/rc-movement` → real routed pages (were client tabs); `/inventory` is now a 2-tab "logs" shell (Deliveries + Usage) with `?tab=`; blocking deep-links a block via `?block=`.
- Blocking detail panel moved to `app/(app)/inventory/_shared/` and decoupled from the tab shell (event-seam + `onNavigateToBatch` prop).
- **Security: 4 price/cost leaks closed** server-side behind the canonical `canViewPrices()`/`roleCanViewPrices()` in `lib/auth.ts` — RC Movement matrix, RC OUT table, RC IN page role-check (was ignoring the impersonation cookie), and `fetchSingleDelivery` (caught by adversarial review). Production role can no longer pull ₱ off any network response.
- Navbar nested-Inventory menu + breadcrumb registry refactor; dead `/inventory/blocking` "Coming soon" stub replaced; dead RC OUT code removed.

### Sync token-lean refactor (`07e15e5`)
- 4 sync agents (`.claude/agents/{gsheet-sync,deliveries-manager,rc-out-manager,production-manager}.md`) → `model: sonnet`, tail-scope instruction (classify only since watermark−3d, not full 2025+ history), and read `RULES_DIGEST.md` not the full ledger.
- New `.claude/skills/sync-ictc/RULES_DIGEST.md` (one line per L-### rule). `CLAUDE.md` "Agent Model" carve-out documents the Sonnet-for-sync exception (escalate to Opus only on conflict).

### Data writes (live in DB, not git) — 6/12 ICTC sync
- +1 delivery (6/12, ORNALES → **new batch JUNE-26-BLK5**, 20,950 kg @ ₱38). +5 rc_out feeds (6/12, FEED3/FEB-26-BLK28/MARCH-26-BLK8; FEB-26-BLK28 auto-closed). **6/12 production waste HELD** (Ivy filed it, MC hadn't filed 6/12 production). Deliveries-manager net-zero (latest email was 6/9, already in DB).

## Critical learnings

- **`canonical_supplier(text)` is the ONE place supplier grouping lives.** Order-sensitive CASE: tipal/tipla → `BAGUIO/TIPALAN` (first); bagui/bagi w/o tipal → `BAGUIO`; misdeclare "/" combos (mercado+ornales, mercado+paquibot, arbelera+mercado, nazarte+arbelera) → `ORNALES`; (compra/suarez/baraquel)+paquibot → `PAQUIBOT`; nazareno/nazarino → `NAZARENO`; else `UPPER(TRIM())`. **Combo clauses require BOTH names**, so standalone Mercado/Suarez/etc. stay separate. To add a future typo/alias: edit this one function (CREATE OR REPLACE) — views call it, so they all update; no view rewrites, no type regen.
- **"Incoming deliveries only" = drop sundried/refeed/recook OUTPUT, keep INPUTS.** The WHERE on all 4 analytics views: `NOT ( (batch_code ILIKE '%SUNDR%' AND COALESCE(remarks,'') NOT ILIKE '%FOR SUNDR%') OR batch_code ILIKE '%REFEED%'/'%RECOOK%' OR supplier ILIKE '%refeed%'/.../%recook%/... )`. KEY nuance (Renzo corrected an over-broad first pass): **keep** all suppliers incl "Layupan"/"SUNDRY BACKLOG" (real incoming / parties we sundry for) and **"FOR SUNDRYING" inputs even on a sundry batch**; only drop the dried RESULT (it was already counted as incoming on arrival). Net incoming: **1,508 rows / 28,926,630.10 kg**.
- **Client-side rollup respects trust-the-DB.** The supplier view re-weights the DB's *per-month already-weighted* figures by month volume (`Σ(v·vol)/Σvol`, nulls excluded) for quarter/period/table/panel — this is a rollup of pre-weighted values, NOT a from-scratch TS average.
- **3 frontend bug patterns (all fixed; reuse them for any recharts+table page):** (1) **`chartReady` mount-gate** on every recharts `ResponsiveContainer` — it renders empty server-side / full client-side, shifting Radix `useId`s → hydration crash. (2) **`stableRange`** — `useCellSelection` rebuilds `range` as a fresh object each render; feeding that identity into the status-bar push effect caused an **infinite render loop** (max update depth, surfaced misleadingly in NotificationBell). Key on coords. (3) **`<colgroup>`** comments must be glued to `<col/>` (no space) — whitespace text nodes are illegal there. Plus **click-away deselect** ignores `[data-floating-status-bar]` + `[data-radix-popper-content-wrapper]`.
- **Period view is still imported from `price-demos/demo4`** — a "demos" folder feeding a permanent feature. Functional but a smell. Future cleanup: relocate `analyst-brief-client.tsx` + `fetchMonthlyDeliveryAnalytics` into `app/(app)/summaries/` and redirect/remove demo4.
- **`cost_basis=0` is the gsheet L-008 unpriced placeholder** — analytics weight price over `cost_basis>0` rows only (volume still counts all rows). Only 1 such row exists.
- **Sonnet-for-sync** is now the documented default (CLAUDE.md carve-out) — the "always Opus" rule still holds for implementation agents.

## Current state
- **Working / verified:** `npx tsc --noEmit` clean; `npm run build` compiles; `/summaries`, `/inventory/blocking`, `/inventory/rc-movement` all in the route manifest and respond 307 (auth redirect) — no 500s. SQL spot-checks reconcile (period total == supplier-view sum for sample months). All committed + pushed.
- **Built but NOT click-tested by an agent** (auth-gated; Renzo verifies in-browser): all interactive UI — the Summaries graph/table/panel/cell-selection, the routed blocking `?block=` deep-link, "Edit All Usage" landing on the right tab.
- **Held / deferred:** 6/12 production waste (awaiting MC's 6/12 production report); the `extract_gsheet.py` still parses the full sheet (no `--since` — flagged in `SKILL.md`, agent stays lean via the DB-window compare); the period-view-from-demos relocation.
- **Edge cases kept (flag if wrong):** one "MOVED FROM D18-D SUNDRY" row on a *normal* block (18,008 kg) and the "SUNDRY BACKLOG" supplier rows are treated as incoming (kept) because they're not on sundry batches.

## Open decisions
- **Open the PR** (base `dev`, per the git workflow — `feat/*` integrates via `dev`, not `main`).
- Relocate the period view out of `price-demos/demo4` into `/summaries`? (cleanliness, no user impact).
- DB-level price RLS hardening — flagged earlier as a background-task chip (app-layer gating is airtight today; this is defense-in-depth so a future export/widget can't re-leak).

## Next concrete action
**Open a PR for `feat/ictc-modules-routing` with base `dev`** (link above). Review the diff (3 new commits this session + the routing commits). After merge, next session **run the ICTC sync** via the gsheet-first → email/production auditors → propose → approve → execute playbook (now on Sonnet); watermarks to beat are deliveries/rc_out **6/12**, production/electricity **6/11**, trucks **6/10**, and clear the **held 6/12 waste** once MC files 6/12 production.

## Git state
- **Branch:** `feat/ictc-modules-routing` (pushed, upstream `origin/feat/ictc-modules-routing`, no PR yet).
- **This session's commits:** `a4c03a9` feat(summaries), `07e15e5` refactor(sync-ictc), `ea8c0a5` chore(memory/CLI). Earlier this session: `ec15a3c` feat(inventory routing), `1e1e334` fix(price gating), `e4423c4` chore(navbar cleanup), `ad09c22` chore(sync ledger L-017/L-018).
- **Uncommitted:** only `.claude/agent-memory-local/supabase-backend-engineer/MEMORY.md` (machine-local, gitignored-intent — deliberately left out of commits).
- **NOT merged to `dev`.**
