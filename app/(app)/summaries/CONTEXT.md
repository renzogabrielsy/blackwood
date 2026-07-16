# Summaries Module — Delivery Price & Volume Analysis

## Purpose
The `/summaries` route is the permanent home for delivery **price & volume analysis** (ICTC charcoal tenant). It graduated from the `price-demos/demo4` "Analyst Brief" concept. Two views share one shell, switched by a URL-driven toggle:

- **By Period** — year/month analysis. Multi-year overlay graph (each year a color, price line + volume area), KPI strip, and a monthly deliveries table (rows = months) in RC IN format with Excel cell-selection. *Reuses the existing `AnalystBriefClient` from `price-demos/demo4`.*
- **By Supplier** — single-year, supplier-focused. Suppliers overlaid on the graph (default top-3 by volume), KPI strip, a supplier table (rows = suppliers) in RC IN format, and a slide-out panel per supplier.

> **Domain Module (Charcoal Tenant).** Registered in the navbar's **ICTC · Davao** factory-icon section as "Summaries" (sibling of Production).

## Files
| File | Role |
|------|------|
| `page.tsx` | Server component. Fetches BOTH datasets — `fetchMonthlyDeliveryAnalytics` (period, imported from `../price-demos/demo4/actions`) and `fetchSupplierAnalytics` (supplier, from `./actions`) — each in its own try/catch, and passes `period` + `supplier` props to `<SummariesClient>`. |
| `summaries-client.tsx` | `'use client'` shell. URL-driven view toggle via `?view=period\|supplier` (default `period`; `?view=period` deletes the param to keep the URL clean). Renders `AnalystBriefClient` (period) or `SupplierBriefClient` (supplier). `useSearchParams` is wrapped in a Suspense boundary. |
| `supplier-brief-client.tsx` | The **By Supplier** view (see Key Behaviors). |
| `actions.ts` | `'use server'`. `fetchSupplierAnalytics()` + exported interfaces `SupplierMonthRow`, `SupplierYearSummary`, `SupplierAnalytics`. Price-gated via `canViewPrices()`. |

## Data
- **Period view:** `fetchMonthlyDeliveryAnalytics()` → SQL view `view_delivery_monthly_analytics` (lives with `price-demos/demo4/actions.ts`).
- **Supplier view:** `fetchSupplierAnalytics()` → SQL views `view_delivery_supplier_monthly_analytics` (year × month × supplier) + `view_delivery_supplier_yearly_analytics` (true weighted yearly rollup). Migration `20260616000000_create_view_delivery_supplier_analytics.sql`.
- **Supplier grouping = `public.canonical_supplier(text)` (IMMUTABLE SQL helper, the single source of truth):** both supplier views group AND label suppliers by `canonical_supplier(supplier)`. Order-sensitive CASE: (1) `ILIKE '%tipal%'/'%tipla%'` → **BAGUIO/TIPALAN** (tipalan FIRST, combined or standalone); (2) `ILIKE '%bagui%'/'%bagi%'` WITHOUT tipalan → separate **BAGUIO**; (3) misdeclare "/" COMBOS → **ORNALES** (Mercado/Ornales, Mercado/Paquibot, Arbelera/Mercado, Nazarte/Arbelera — either order); (4) "/" COMBOS → **PAQUIBOT** (Compra/Paquibot, Suarez/Paquibot, Baraquel/Paquibot — either order); (5) `ILIKE '%nazareno%'/'%nazarino%'` → **NAZARENO** (typo merge — placed AFTER the combo rules so "Nazarte/ Arbelera" still routes to ORNALES); (6) ELSE `COALESCE(NULLIF(UPPER(TRIM(supplier)),''),'UNKNOWN')` (collapses case/whitespace variants). Combo clauses require BOTH names, so standalone Mercado/Compra/Suarez/Baraquel/Arbelera/Nazarte stay their OWN supplier — no false positives. Pure regrouping: grand total unchanged, ₱/kg = volume-weighted blend. Migrations `20260616062408_canonical_supplier_helper_and_subgroups.sql` (helper + combos) then `20260616063514_canonical_supplier_nazareno_alias.sql` (Nazareno merge). Verified: ORNALES 2025 +123,749 kg (4 combos), PAQUIBOT 2025 +28,302 kg (3 combos); NAZARENO = Nazareno+Nazarino merged (10 rows / 101,610 kg).
- **Shape:** `{ years: number[], byYear: Record<year, SupplierYearSummary[]> (suppliers sorted by yearly volume DESC), canViewPrices }`. Each `SupplierYearSummary` has `monthly: SupplierMonthRow[12]` (zero-filled), a weighted `totals`, and `subgroups: SupplierSubgroup[]`. Lab + price fields are `number | null`.
- **Subgroup breakdown (slide-out panel):** view `view_delivery_supplier_subgroup_yearly_analytics` at grain (year, `main_supplier = canonical_supplier(supplier)`, `subgroup = UPPER(TRIM(supplier))`) with deliveries/sacks/volume_kg/weighted avg_price/php_total — same exclusions. The action exposes it as `SupplierYearSummary.subgroups: SupplierSubgroup[]` (`{ label, weightKg, sacks, deliveries, phpPerKg }`, sorted weightKg DESC, ₱ price-gated). Lets the panel show constituents under a main group, e.g. ORNALES → ORNALES (direct) + MERCADO / ORNALES + ARBELERA/MERCADO + MERCADO/PAQUIBOT + NAZARTE/ ARBELERA. Migration `20260616062408`.
- **Real data:** years 2020, 2022–2026 (no 2021); 2020/2022/2023 are sparse single-`BACKLOG` buckets; 2026 has ~41 distinct suppliers.
- **Sundried OUTPUT excluded (incoming only):** all four analytics views drop post-sundrying OUTPUT — `WHERE NOT (batch_code ILIKE '%SUNDR%' AND COALESCE(remarks,'') NOT ILIKE '%FOR SUNDR%')`. That is: a SUNDRY-batch row is excluded UNLESS its remarks say "FOR SUNDR…". KEEP everything else — **all suppliers including "Layupan" and "SUNDRY BACKLOG"** (they are real incoming deliveries / parties we sundry for), and **"FOR SUNDRYING" inputs** even on a sundry batch. Only the dried RESULT (remarks "SUNDRIED"/"FINAL SUNDRY WT" or untagged sundry-batch output) is removed, since it was already counted as incoming on first arrival. Migration `20260616140000_correct_sundried_exclusion_keep_inputs.sql` supersedes the earlier over-broad supplier-based filter (`20260616023550`).
- **Refeed + recook also excluded (reprocessing, not incoming):** migration `20260616180000_exclude_refeed_recook_and_alias_baguio_tipalan.sql` adds to the WHERE on all four views: `OR batch_code ILIKE '%REFEED%'/'%RECOOK%' OR supplier ILIKE '%refeed%'/'%re-feed%'/'%re feed%'/'%recook%'/'%re-cook%'/'%re cook%'`. Like sundried output, refeed (re-feeding the RC tank) and recook are the plant re-processing charcoal already counted as incoming. Combined sundried+refeed+recook exclusion leaves **1,508 incoming rows / 28,926,630.10 kg** (refeed/recook removed 4 rows / 46,629 kg).
- **Weighting (SQL):** `avg_price` volume-weighted over `cost_basis > 0` rows only (excludes the L-008 `cost_basis=0` placeholder); lab metrics volume-weighted with FILTER excluding nulls; volume/sacks/deliveries over all rows.
- **Price gating:** `canViewPrices()` (lib/auth.ts) nulls `phpPerKg`/`phpTotal` server-side for Production; the client hides ₱ columns/KPIs/panel stats when `canViewPrices === false`.

## Key Behaviors

### By Supplier view (`supplier-brief-client.tsx`)
- **Year dropdown** (main selector) over `years`; defaults to the latest. All sub-state derives from `byYear[year]`.
- **Granularity toggle** `Months | Quarters` + a **period multi-select** (Jan…Dec or Q1…Q4, default ALL) that scopes BOTH the table aggregation and the graph x-axis. Quarters map Q1=[0,1,2]…Q4=[9,10,11].
- **Graph:** overlays selected suppliers across the selected periods; each supplier one theme-aware hue, **price line + volume area share that hue**. Default = **top-3 by volume**. Graphed set capped at **6** (`MAX_GRAPHED`); managed via removable colored chips + a searchable "Add supplier" `Popover`+`cmdk` (avoids a 41-chip wall). The table's leading **checkbox column** also toggles graph membership.
- **Table:** rows = suppliers (volume DESC), RC IN columns (Supplier · Deliveries · Sacks · Weight · MC · Grit · VM · Ash · FC · BD ASTM · BD JIS · ₱/kg · ₱ Total), aggregated over the selected periods. Sticky glass header, opaque pinned totals `tfoot`, sortable, ₱ columns hidden when gated, null → "—". The **supplier-name cell is a clickable row header → opens the slide-out panel**; numeric cells join the Excel range selection.
- **Slide-out panel** (`components/ui/sheet`, right): the supplier's year stats (volume + rank + share, blended ₱/kg, min/max month ₱/kg, sacks, deliveries, weighted lab, vs-prior-year deltas) + their **own mini chart** (price line + volume area). ₱ stats gated.
- **Client-side rollup** (`rollMonths`): months→quarter / months→selected-span / table rows / footer / panel all re-weight the DB's **per-month weighted** figures by month volume (`Σ(value·monthVol)/Σ(monthVol)`, null months excluded). This rolls up pre-weighted monthly values — not a from-scratch TS average — so it respects the trust-the-DB rule.

### Shared patterns (mirrored from the period view — carry baked-in fixes)
- **`chartReady` mount-gate** on every recharts `ResponsiveContainer` (prevents an SSR `useId` hydration crash).
- **`stableRange`** cell-selection keyed on coords (prevents an infinite-render loop through the status-bar context).
- **`<colgroup>`** comments glued to `<col/>` (no whitespace text nodes).
- **Click-away `mousedown` deselect** that ignores `[data-floating-status-bar]` + `[data-radix-popper-content-wrapper]`.
- **Theme-aware palette** (bright in dark / deep in light) + `useChartChrome` re-reading on `.dark` flips.
- Excel cell-selection (`use-cell-selection` + `use-cell-aggregation`) pushes sum/avg/count to the app-wide `FloatingStatusBar` via `useStatusBar`.

## Dependencies
- `app/(app)/price-demos/demo4/` — the **period view** (`AnalystBriefClient`) + `fetchMonthlyDeliveryAnalytics` are imported from here (reuse, not duplicated). *Future cleanup: relocate the period view into this module so the permanent feature no longer imports from a `price-demos` folder.*
- `@/lib/hooks/use-cell-selection`, `@/lib/hooks/use-cell-aggregation`, `@/components/providers/status-bar-context` + `FloatingStatusBar` (mounted in `app/(app)/app-shell.tsx`).
- `@/components/ui/{sheet,select,popover,command}`, `recharts`, `@/lib/auth` (`canViewPrices`).
- SQL views (above) — owned by the supabase layer.

## See Also
- [Navbar](../../../components/NAVBAR.md) — `/summaries` breadcrumb + the ICTC "Summaries" module entry.
- [Auth Provider](../../../components/providers/AUTH.md) — price-gating model (`canViewPrices`).
