# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Platform Philosophy

**Blackwood is a general-purpose modular BI platform, not a charcoal plant tool.** Charcoal plant operations (RC IN, RC OUT, Blocking) are the first tenant on the platform — a real-world proof of concept. The platform itself must remain genuinely open to any inventory or operational domain without a rewrite.

**Inspiration: Grafana's data source model.** Grafana itself does not store data. It acts as a visualization and interaction layer, pulling information from selected data sources. Every data source emits a normalized data frame. Visualizations consume frames, never raw queries. Blackwood follows the same model: widgets consume normalized, data-agnostic interfaces (`ChartConfig`, `KPIData`, etc.) — never raw Supabase queries.

**Architecture: Hexagonal (Ports & Adapters).** The widget is the application core. The "port" is the typed interface it declares (`ChartConfig`, `KPIData`, `ScatterPoint[]`). The "adapter" is whoever fills it — today a static mock adapter, tomorrow a live Supabase adapter. The widget is permanently isolated from the adapter. This vocabulary is canonical throughout the codebase.

**Layer separation rule:** If code lives in `components/shared/`, `components/ui/`, `components/providers/`, or the navbar/shell chrome, it is **platform code** — zero tenant knowledge allowed. If it lives in `app/(app)/inventory/`, `app/(app)/production/`, `app/(app)/cenapro/`, `components/digest/`, or `lib/digest/`, it is **tenant code** — domain-specific is expected and correct. Never add domain/tenant knowledge to platform-layer components.

**Two coexisting UX paradigms:**
- **Home Digest (`/`):** The Daily Sync Digest — a read-focused briefing page of dense bands (KPIs, charts, open blocks, bag inventory, sync activity). High information density, visual-first. **Tenant-shaped presentation** over the platform's SQL-view adapter pattern.
- **Inventory pages (`/inventory/...`):** Industrial Spreadsheet — dense, keyboard-navigable tables that feel like Excel but enforce data integrity underneath. These stay as dedicated pages forever. **Tenant/domain layer.**

## Platform Vocabulary

| Term | Meaning |
|------|---------|
| **Platform layer** | Source-agnostic, domain-neutral infrastructure: providers, the shared Blackwood Table grid primitive, navbar/shell. Zero tenant knowledge allowed. |
| **Domain module** | RC IN, RC OUT, Blocking, RC Movement, Production, Flecon Bags — charcoal-specific. The first tenant on the platform. |
| **Tenant** | An organization/domain using the platform. Blackwood/ICTC charcoal is Tenant #1; Cenapro (CI/Cebu) is Tenant #2 (own `cenapro` schema/module). Domain modules and business logic are always tenant-specific. |
| **Data-agnostic interface** | The typed contract a presentation component accepts (e.g. the digest's `DigestData` bands, or a future widget's `ChartConfig`). Equivalent to Grafana's "data frame." |
| **Adapter** | Pure function — transforms a data source's raw output (a Supabase view/query) into a normalized, presentation-ready shape. The digest's `lib/digest/queries.ts` (`getDigestData()`) is the live adapter today. |

> **Historical note:** the platform's first UX experiment was a composable **widget dashboard** (Grafana-style: `components/widgets/`, `components/dashboard/`, `lib/widgets/` mock/live adapters). That system is **archived at `_archived/dashboard-v1/`** and no longer live — `/` is now the Daily Sync Digest (see the **Home Digest** section below). The platform-vs-tenant philosophy and the Grafana data-source framing above still govern all future work; only the widget implementation was retired.

## Project Timeline (MANDATORY READ)

**Before starting any work session, read `TIMELINE.md` at the project root.** It is the single source of truth for what phase the project is in, what's been completed, and what's next. Update it whenever you complete a task, start a new phase, or the scope changes.

- **Current sprint** is always documented at the top of `TIMELINE.md`
- **Phase doneness** is tracked via checkboxes (`[x]` done, `[/]` in progress, `[ ]` not started)
- **Definition of Done** at the end of each phase defines completion criteria
- **Changelog** at the bottom records all timeline updates with dates

## Handoff Files (MANDATORY READ AT SESSION START)

**Session-handoff files live in `handoffs/` at the project root.** Each file captures what happened in one session — concrete deliverables, key learnings, the current state of the codebase, open decisions, and the next concrete action.

**When the user says "view latest handoff file", "where did we leave off", or "what's the current state":**
```bash
ls handoffs/ | sort -r | head -1
```
The YYYY-MM-DD prefix on each filename makes alphabetical sort equivalent to chronological. The first result is the most recent handoff — read it before doing anything else.

**Naming convention:** `handoffs/YYYY-MM-DD-<short-slug>.md` (e.g. `2026-05-26-rc-movement-backfill-jarvis-foundation.md`). One file per session. Never delete old handoffs — they form the project's session history.

**When ending a session,** create a new handoff file capturing: TL;DR, what shipped (with file paths), critical learnings, current state, open decisions, and the next concrete action. Use the most recent handoff as a template — same section structure.

## Skills

This project uses the **`frontend-design`** skill for UI and design guidance. When planning frontend features, designing UI components, or reviewing code quality, Claude will reference this skill for best practices on:
- Next.js App Router patterns and Server Components
- shadcn/ui component composition and Tailwind CSS
- Information-dense UI design (Notion/Raycast aesthetic)
- TypeScript and Supabase architecture patterns

**Reference the skill:** When working on frontend UI and design, Claude will automatically consult this skill for architectural decisions and component patterns.

## Commands

```bash
npm run dev      # Start dev server (Next.js)
npm run build    # Production build
npm run lint     # ESLint
npm run start    # Start production server
```

No test framework is configured.

## Stack

- **Next.js 16** (App Router) with React 19 and TypeScript (strict mode)
- **Supabase** (PostgreSQL) — clients in `lib/supabase/` (`client.ts` browser, `server.ts` per-request RSC/actions, `admin.ts` service-role), env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- **Shadcn UI** (new-york style, zinc base) with Radix primitives in `components/ui/`
- **TanStack Table** for data tables, **date-fns** for dates, **cmdk** for command menus
- **Tailwind CSS v4** with dark mode support via CSS variables
- **next-themes** for dark mode toggling and persistence

## Theming

- **Dark mode** is powered by `next-themes` (`ThemeProvider` in `components/providers/theme-provider.tsx`)
- CSS variables in `globals.css` — `:root` for light, `.dark` for dark
- `next-themes` adds/removes `.dark` class on `<html>` and persists the user's choice to **localStorage** automatically
- **Always use semantic tokens** (`bg-primary`, `text-muted-foreground`, `bg-card`, `border-border`, etc.) — not hardcoded colors like `bg-white` or `text-black`
- The navbar is always dark-themed: `bg-zinc-800` (light) / `dark:bg-zinc-700` (dark mode) — it intentionally stays dark in both modes but shifts one shade lighter in dark mode to maintain contrast against the `zinc-950` background
- Footer sliding indicators use `bg-zinc-800 dark:bg-zinc-200` to invert properly

## Architecture

**Data flow:** User Action → Client Component → Server Action → Supabase → `revalidatePath()` → Re-render

- **Server Components** (`page.tsx`) handle data fetching with direct Supabase queries
- **Client Components** (`'use client'`) handle interactivity (forms, tables)
- **Server Actions** (`actions.ts`) handle all mutations, always call `revalidatePath()` after writes
- **URL search params** drive filters, pagination, and navigation state (not React state)

**Path alias:** `@/*` maps to project root.

**Client/server module boundary trap:** a client-safe pure module (e.g. `components/sync/cases/grouping.ts`) must NEVER import from a server-heavy sibling — even for a single constant. Importing `lib/investigator/triage.ts` for `TRIAGE_KIND` drags the Anthropic SDK + admin client into the client bundle and breaks `npm run build`. Duplicate the constant locally and add a verify-script assertion that the copies match (see `scripts/verify-case-grouping.ts`).

**Two-layer data flow:**
- **Platform layer (widgets):** Widget → data-agnostic interface (`ChartConfig`, `KPIData`) → adapter fills interface → widget renders. Widget has zero knowledge of Supabase, charcoal, or any domain.
- **Domain layer (inventory modules):** User Action → Client Component → Server Action → Supabase → `revalidatePath()` → Re-render. This is the tenant-specific CRUD layer.

## Database Schema (Supabase)

Auto-generated TypeScript types live in `types/supabase.ts` — **never hand-edit this file**, regenerate with `/supabase` workflow or:
```bash
supabase gen types typescript --linked > types/supabase.ts
```

### Core inventory tables (`public`)
- **`batches`** — `id`, `batch_code` (unique), `location_ref`, `status` (`batch_status` enum), `avg_cost`, `current_weight`, `quality_stats` (JSONB), `notes`, `created_at`, `updated_at`
- **`deliveries`** — `id`, `transaction_date`, `supplier`, `batch_code` (FK→batches), `block_loc`, `truck_plate`, `sacks`, `weight_kg`, `cost_basis`, `remarks`, `lab_results` (JSONB: mc/ash/bd_astm/bd_jis/grit/vm/fc), `true_weight_kg` (nullable — physical/gross weight before ASH+wet deductions; display-only, NULL = no deduction, never used in any balance/view/trigger), `deduction_note` (nullable text — short human note, e.g. '−5.86% ASH; −1,009 wet'; display-only), `created_at`
- **`rc_out`** — `id`, `transaction_date`, `batch_id` (FK→batches), `production_batch`, `destination`, `weight_kg`, `block_loc`, `remarks`, `created_at`. (Replaced the legacy `usage` table; FK constraint keeps the historic `usage_batch_id_fkey` name.) Computed columns: `rc_out_avg_price`, `rc_out_avg_wtd_value`

### Production tables (`public`) — ingested by the `production-manager` employee
- **`production_shifts`** — parent; one row per `(transaction_date, production_batch, shift)`. `production_runs`/`production_downtime`/`production_waste` all FK to it via `shift_id`.
- **`production_runs`** — daily output by grade/shift. `customer`, `grade`, `ttl_kg`, `sacks_bags`, `remarks`, `shift_id`.
- **`production_downtime`** — per-shift downtime. `dt_hrs`, `dt_mins`, `dt_reason`, `shift_hrs`, `shift_id`.
- **`production_waste`** — 8-stream waste per shift. `bf_kg`, `grit_kg`, `rs1a_kg`/`rs1b_kg`/`rs23_kg`/`rs5_kg`, `trml1_kg`/`trml2_kg`, `remarks`, `shift_id`.
- **`electricity_readings`** — daily meter readings. Natural key `(reading_date, meter)`. `start_kwh`, `end_kwh`, `diff_kwh` (computed), `consumption_kwh`, `meter_multiplier`, `remarks`.
- **`truck_readings`** — daily odometer + fuel. Natural key `(reading_date, plate_no)`. `start_km`, `end_km`, `ttl_km` (computed), `fuel_liters`, `remarks`.

### FLECON bag inventory (`public`) — ingested by the `bagging-manager` employee
- **`flecon_bag_types`** — packaging-material SKU dimension. `code`, `label`, `nickname`, `material`, `capacity_kls`, `color`, `sort_order`, `active`, `source_column`, `source_label`, `notes`.
- **`flecon_bag_opening_balances`** — per-year opening (`year`, `bag_type_id` FK, `qty`). The 2026 opening folds in all pre-2026 stock.
- **`flecon_bag_movements`** — signed movements (`qty_delta`; negative = OUT/consumed, positive = IN). `transaction_date`, `bag_type_id` FK, `particular`, `remarks`, `source_row`. No natural-key UNIQUE — sync uses replace-by-date idempotency.

### Sync / ingestion infrastructure (`public`)
- **`ingestion_watermarks`** — per-report-type high-water mark. `report_type` (PK), `last_run_at`, `last_email_id`, `last_email_received_at`.
- **`pending_review`** — staged extractions awaiting human commit. `report_type`, `status`, `rows_json`/`final_rows_json`/`diagnostic_json` (JSONB), `overall_confidence`, source-email refs, `reviewed_by` (FK→profiles), `commit_audit_log_id` (FK→audit_logs).

### Jarvis AI assistant (`public`)
- **`jarvis_conversations`** — `id`, `user_id`, `title`, `last_message_at`, `archived`, `created_at`.
- **`jarvis_messages`** — `conversation_id` (FK), `role`, `content`, `position`, `tool_calls`/`tool_results` (JSONB), `created_at`.
- **`jarvis_learnings`** — `user_id`, `type`, `content`, `source_message_id` (FK→jarvis_messages), `last_used_at`, `created_at`.

### Platform / auth / audit tables (`public`)
- **`profiles`** — `id` (FK→auth.users), `email`, `display_name`, `avatar_url`, `role`, `status` (`'active'` | `'disabled'` | `'pending'`), `created_at`, `updated_at`
- **`audit_logs`** — `id`, `table_name`, `record_id`, `operation`, `diff` (JSONB), `snapshot` (JSONB), `comment`, `performed_by`, resolve fields
- **`audit_comments`** — `id`, `audit_log_id` (FK→audit_logs), `body`, `user_id`, `resolved`
- **`notifications`** — `id`, `user_id`, `type` (`notification_type` enum), `title`, `body`, `source_user_id`, `metadata` (JSONB), `read`, `read_at`, `archived`, `created_at`
- **`notification_subscriptions`** — `id`, `user_id`, `audit_log_id` (FK→audit_logs), `created_at`
- **`user_invites`** — `email` (PK), `role`, `invited_by` (FK→profiles), `created_at`. Whitelist for invite-only access.
- **`user_table_settings`** — per-user, per-module table prefs. `user_id`, `module`, `settings` (JSONB).
- **`user_dashboard_prefs`** — `user_id` (PK), `prefs` (JSONB), `updated_at`.

### Cenapro tenant (`cenapro` schema — Tenant #2, zero ICTC coupling)
Dimensions: `shift`, `grade`, `plant`, `warehouse`, `source_location`, `partner_equipment`. Facts: `production_event` (CI production spine, one row per workbook Production row), `warehouse_opening_balance` (APPEND-ONLY flec-count openings per warehouse/grade/side), `drift_log` (append-only drift/exclusion telemetry). See `cenapro/CENAPRO_PRODUCTION_ANALYSIS.md`.

**Enums:** `batch_status` = `STORED | IN-USE | CLOSED | FEED | SUNDRYING | SUNDRIED` (6 values) · `notification_type` = `resolve_request | resolve_approved | resolve_denied | delivery_created | delivery_edited | delivery_deleted | remarks_added | audit_comment_reply`

Batch upsert strategy: upsert by `batch_code` to prevent duplicates.

### Views (`public`, ~40 total)
- **RC IN / deliveries:** `view_rc_in_master`, `view_supplier_deliveries`, `view_delivery_monthly_analytics`, `view_delivery_yearly_analytics`, `view_delivery_supplier_monthly_analytics`, `view_delivery_supplier_yearly_analytics`, `view_delivery_supplier_subgroup_yearly_analytics`
- **Blocking / balance:** `view_blocking_grid`, `view_rc_out_closed_blocks`
- **RC Movement (feeding + campaign + yield):** `view_rc_movement`, `view_rc_movement_batch_price`, `view_rc_movement_day_price`, `view_rc_movement_month_price`, `view_rc_movement_campaign_cells`, `view_rc_movement_campaign_options`, `view_rc_movement_campaign_price`, `view_rc_movement_campaign_day_price`, `view_rc_movement_campaign_production`, `view_rc_movement_campaign_production_daily`, `view_rc_movement_campaign_production_daily_total`, `view_rc_movement_campaign_yield`, `view_rc_movement_production_daily`, `view_rc_movement_production_daily_total`, `view_rc_movement_production_monthly`, `view_rc_movement_yield_monthly`
- **Production / trucks:** `view_production_daily`, `view_trucks_monthly`
- **Home Digest (feed the `/` bands):** `view_digest_daily_flow`, `view_digest_daily_price`, `view_digest_daily_power`, `view_digest_daily_production`, `view_digest_grades`, `view_digest_rcin_daystats`, `view_digest_mtd`, `view_digest_operational_days`, `view_digest_stream_freshness`, `view_digest_unpriced_recent`, `view_digest_latest_sync`, `view_digest_latest_sync_by_employee`, `view_digest_audit_enriched`
- **FLECON:** `view_flecon_bag_balance`
- **Cenapro:** `cenapro_production_events`

### Functions (`public`)
- `fn_blend_proposal(p_block_locs text[])` — weighted-average blend metrics for selected blocks
- `fn_bulk_update_deliveries(rows jsonb)` / `fn_bulk_update_usage(rows jsonb)` — **transactional** bulk-edit RPCs (PERF-3). Each applies an array of `{id, data, comment}` partial updates to `deliveries` / `rc_out` in ONE transaction (all-or-nothing, no mid-loop partial commit). SECURITY INVOKER, `search_path=public` pinned, EXECUTE revoked from `anon`. They let the existing per-row AFTER triggers fire (so the `audit_logs` trail is byte-for-byte identical to the old loop) and reproduce the "attach edit remark to the record's latest audit_log" glue. Called by `bulkUpdateDeliveries` / `bulkUpdateUsage`.
- `set_audit_comment(comment text)`, `_insert_notification(...)`, `is_admin(user_id)`, `canonical_supplier(p_supplier)`, `rc_out_avg_price(...)`, `rc_out_avg_wtd_value(...)`
- `write_ingestion_audit(p_table_name text, p_record_id uuid, p_operation text, p_diff jsonb, p_snapshot jsonb, p_comment text) → uuid` — SECURITY DEFINER (owner `postgres`), `service_role`-only ingestion audit writer for the sync orchestrators / Run Sync button; inserts one `audit_logs` row (`performed_by=NULL`) and returns its id. Closes the L-009 grant gap without granting broad INSERT on `audit_logs`. Use for tables with no audit trigger (`rc_out`, `production_*`, `electricity_readings`, `truck_readings`, `flecon_bag_movements`); `deliveries` keeps its own audit trigger.
- Cenapro RPCs: `cenapro_flec_balance`, `cenapro_flec_ledger`, `cenapro_opening_balances`, `cenapro_opening_balance_history`, `cenapro_set_opening_balance`

**Triggers:**
- **`handle_new_user()`** — After INSERT on `auth.users`: creates profile from `user_invites` whitelist (role + status='active') or with default role + status='pending'
- **`handle_invite_creation()`** — After INSERT on `user_invites`: activates matching pending profiles

**Dev Role Override:** Privileged users (Owner/Admin/Dev) can impersonate any role via localStorage (`dev_mock_role`) + cookie. Server-side `getUserRole()` in `lib/auth.ts` reads the cookie. UI controlled via navbar Shield icon dropdown.

**Price gating (security boundary) — `canViewPrices()` is canonical.** All ₱/cost data (`cost_basis`, `avg_price`, `avg_wtd_value`, fed ₱/kg) is gated by the ONE helper `canViewPrices()` in `lib/auth.ts`. It derives the effective role from `getUserRole()`, so it respects the impersonation cookie (an Owner "viewing as Production" is denied). **Production is the only role that cannot see prices.** Server actions/components MUST null/omit ₱ fields BEFORE returning the payload when `!canViewPrices()` — never rely on hiding them client-side (the network response is the leak) — and pass a `canViewPrices` boolean down for conditional render. Never re-derive price visibility with an inline `profiles.select('role')` lookup (it ignores impersonation). See `components/providers/AUTH.md` → "Price Gating".

## Supabase CLI

The project is linked to Supabase. Common commands (see `/supabase` workflow for full details):
- `supabase gen types typescript --linked > types/supabase.ts` — regenerate types after schema changes
- `supabase migration new <name>` — create a migration file in `supabase/migrations/`
- `supabase db push` — push migrations to remote
- `supabase db diff` — see schema changes as SQL

## Database Rules

- **`batch_code` is text-based linking** — not UUID. This preserves CSV/Excel parity so operators can reference batch codes directly.
- **DB trigger `fn_update_blackwood_state`** may handle batch state updates automatically (verify in Supabase dashboard if behavior is unexpected).
- **Never calculate weighted averages or inventory balances in TypeScript** — trust the DB. Aggregations, running totals, and derived state belong in SQL views or triggers, not client code.
- **RLS posture (Phase-4 hardened, 2026-07-03):** RLS is enabled on every public table; the model is **single-org** — `authenticated` = org member = broad read + write (policies are intentionally permissive `USING/WITH CHECK (true)`). The **server actions + `canViewPrices()` are the enforcement layer** (roles, price boundary, delete gates), NOT row-level predicates. Do **not** add per-role row restrictions to the core tables. The Python sync writes with the **service-role key (bypasses RLS)**, so RLS never blocks ingestion. **Reporting views are `security_invoker`** — if you add a view, grant `SELECT` to `authenticated` AND ensure every underlying table has a permissive SELECT policy, or the view throws "permission denied" (the flecon-L trap). **`anon` has no data access** (all anon table/view SELECT + function EXECUTE revoked); `is_admin` is the one function `authenticated` must keep EXECUTE on (RLS policies call it). New functions: `SET search_path = public` and `REVOKE EXECUTE … FROM PUBLIC` (grant back only the roles that call it).

## UI Design System — The "Excel Standard"

All data tables must feel like dense spreadsheets:

- **Layout:** `table-fixed` with explicit pixel widths (e.g., `w-[120px]`)
- **Density:** `px-2 py-1` cell padding, `text-xs`/`text-sm` font sizes, `h-8` row height
- **Numerics:** `font-mono` for all numeric data, right-aligned
- **Spinners:** Hide number input spinners via global CSS (`appearance: textfield`)
- **Currency (Accounting format):** `flex justify-between` — ₱ symbol pinned left, number pinned right
- **Remarks:** Truncate with `max-w-[200px] truncate`, show full text via Tooltip or Popover on hover

## Error Toasts (HARD RULE)

Every error toast — and every inline error UI — MUST persist until the user manually dismisses it and MUST include a Copy button that copies the full error text to the clipboard.

- **Use `errorToast()` from `lib/toast.ts`** — never call sonner's `toast.error()` directly. The wrapper enforces `duration: Infinity`, a close button, and a Copy action.
- For inline errors (e.g., a banner inside a panel rather than a toast), include a small "Copy" button next to the message.
- Success/info/warning toasts can still auto-dismiss — this rule is for ERRORS only.

**Why:** users paste errors into Claude chats for debugging. Auto-dismissing toasts force a screenshot, which wastes tokens on OCR.

## Motion & Glass Design System

Blackwood uses selective animation and frosted glass effects for polish without sacrificing the Industrial Spreadsheet density.

**Principles:**
- **Functional, not decorative** — animations communicate state changes (reveals, entrances, feedback)
- **Duration budget:** 150ms micro-interactions, 250ms reveals, 300ms max
- **Compositor-only:** Only animate `transform`, `opacity`, `filter` — never `width`, `height`, `top`, `left`
- **Never animate table rows** — no stagger, no fade-in on 600+ cell data tables

**Canonical glass patterns** (by surface type):

| Surface | Pattern | Use case |
|---|---|---|
| Sticky table header/footer | `bg-muted/90 backdrop-blur-sm` | TableHeader, TableFooter in master tables and bulk inputs |
| Dialog/AlertDialog content | `bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80` | DialogContent, AlertDialogContent |
| Dialog/sheet headers | `bg-background/90 backdrop-blur-sm` | Sticky headers inside add/edit dialogs |
| Popovers & dropdowns | `bg-popover/95 backdrop-blur-lg` | PopoverContent, DropdownMenuContent |
| Floating bars | `bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60` | FloatingStatusBar, DeliverySheetFooter |

**Animation utilities** (defined in `globals.css`):

| Class | Duration | Use case |
|---|---|---|
| `animate-fade-up` | 250ms | Single element reveal (empty states, selection bars) |
| `animate-fade-in` | 150ms | Opacity-only fade (micro-interactions) |
| `animate-scale-in` | 200ms | Container entrance |
| `animate-blur-in` | 300ms | Page-level reveal, loading overlays |
| `animate-modal-enter` | 250ms | Dialog/AlertDialog spring entrance |
| `animate-badge-pop` | 250ms | Notification count |
| `stagger-children` | 250ms + 50ms stagger (6 slots) | Dashboard cards, activity feeds |
| `stagger-fast` | 200ms + 30ms stagger | Smaller groups, field change cards |
| `hover-lift` | 200ms | Cards — translateY(-1px) + shadow |
| `scroll-fade-bottom` | — | Gradient fade at scroll edge |
| `animate-status-grow` | 200ms | Status bar selection indicator entrance (scaleX/Y from right) |

**Row hover:** Use `transition-all duration-150` (not `transition-colors`) on table body rows for smooth hover effects.

**What NOT to animate:**
- Table rows, cells, or cell selection highlights
- Per-row entrance on virtual scroll tables (rows recycle — animation would re-fire)
- Filter changes or search results
- Bulk input grid cells
- Any element that renders 100+ instances

## Frozen Panes (sticky rows/columns)

For Excel-style tables that freeze left columns and/or the header row while the rest scrolls. **This is the OPPOSITE of the glass rule above.** Glass (`/<opacity>` + `backdrop-blur`) is for surfaces floating over EMPTY space. A frozen column, frozen header row, and especially the top-left corner sit ON TOP of scrolling content — so **any alpha lets the moving cells bleed THROUGH them.** Frozen surfaces that overlap scrolling content are **ALWAYS fully OPAQUE — never glass.**

**The rules (canonical — shared utilities live in `globals.css`):**

- **Opaque backgrounds only.** Use a SOLID theme token matched to the surface — body cells `bg-background`/`bg-card`, header cells `bg-muted` (solid, NOT `bg-muted/90`). No `/opacity`, no `backdrop-blur` on any sticky cell.
- **Strict z-scale**, applied consistently in every frozen table via the shared classes:

  | Surface | Utility class | z-index |
  |---|---|---|
  | Normal scrolling body cell | _(none)_ | base / auto |
  | Sticky LEFT column body cell | `.frozen-col` | 10 |
  | Sticky HEADER row cell | `.frozen-row` | 20 |
  | Sticky FOOTER row cell | `.frozen-row-bottom` | 20 |
  | Top-left CORNER (sticky-left **and** sticky-top) | `.frozen-corner` | 30 |
  | Bottom-left CORNER (sticky-left **and** sticky-bottom) | `.frozen-corner-bottom` | 30 |

- **Offsets:** sticky left columns use cumulative `left` offsets from each frozen column's explicit pixel width (a column's `left` = sum of widths to its left). The header row is `top: 0`; a sticky footer row is the mirror, `bottom: 0`. Top corner cells are BOTH sticky-left and sticky-top; bottom corner cells are BOTH sticky-left and sticky-bottom (highest z, 30).
- **Frozen FOOTER (bottom-pinned summary).** A sticky `<tfoot>` pinned to the container bottom is the exact mirror of the frozen header — same opaque-only discipline (solid `bg-muted`, never glass), same cumulative `left` offsets for the cells under the frozen left columns. Use `.frozen-row-bottom` for the scrolling footer cells and `.frozen-corner-bottom` for the bottom-left corner cells. Footer rows may be taller than data rows when they stack multiple values — keep them compact (`text-[10px]`/`text-[11px]`, tight leading).
- **Row state repaints opaquely.** Hover tint, zebra striping, and any row-status tint must be applied to the frozen cells too (e.g. `group-hover:bg-muted/50` layered over the opaque base) — otherwise the pinned cells diverge from the scrolling cells. The opaque base under the tint is what prevents bleed-through.
- **Kill the seam.** A 1px sliver can bleed at the frozen↔scroll boundary. Put `.frozen-edge` on the LAST frozen column (solid inset right border + soft shadow) and `.frozen-edge-top` on a sticky footer row (solid inset top border + upward shadow) — both hide the seam and visually separate the pinned region.

This is platform-level presentational guidance, tenant-neutral. Reference implementations: RC Movement matrix (`app/(app)/inventory/rc-movement/rc-movement-matrix.tsx`) and the Cenapro production ledger (`app/(app)/cenapro/production/production-ledger-grid.tsx`).

## RC IN Column Config

Strict left-to-right order for the delivery input/table:

| Column | Format |
|---|---|
| Date | `yyyy-MM-dd` |
| Supplier | text |
| Batch Code | text |
| Block/Loc | text |
| Truck Plate | text |
| Sacks | integer |
| Weight (kg) | 0 decimal |
| MC, Grit, VM, Ash, FC | 2 decimal |
| BD ASTM, BD JIS | 3 decimal |
| PHP/KG | accounting (₱) |
| PHP Total | accounting (₱) |
| Remarks | truncated text |

## Navbar & Page Titles

The persistent navbar (`components/navbar.tsx`) owns all page titles and descriptions — **pages must not render their own title/description headers**. Instead, add entries to `getBreadcrumb()` in the navbar component.

- **Left side:** Breadcrumb — `← Back to {parent} / {Page Title}` + muted description
- **Center:** "Blackwood" (always visible, links to `/`)
- **Right side:** Dev role switcher (Owner/Admin/Dev only), dark mode toggle, notifications, profile dropdown
- On the dashboard (`/`), the left side is empty — no redundant "Dashboard" label
- The navbar is dark-themed (`bg-zinc-800 dark:bg-zinc-700`) and uses `ssr: false` dynamic import to avoid Radix hydration mismatches

When adding a new page/module, register it in `getBreadcrumb()` with `backLabel`, `backHref`, `pageTitle`, and optionally `pageDescription`.

## Module Pattern (RC IN as reference)

Each module follows this structure in `app/<module>/`:
- `page.tsx` — Server component, fetches data, passes to client components
- `actions.ts` — Server actions for CRUD operations
- Client components for UI (bulk input forms, data tables)

**Key business logic** in `lib/rc-utils.ts`:
- `calculateWhse()` derives warehouse from block location first letter (F→FEED, A→WHSE A, etc.)

## Conventions

- Shadcn components live in `components/ui/` — use `cn()` from `lib/utils.ts` for class merging
- Month-based pagination: each "page" represents a calendar month
- Lab results are stored as nested JSONB, not flat columns
- Seeding script at `scripts/seed_rc_in.ts` for CSV import of legacy data

## Component Context Files

Each major module has a co-located `.md` context file documenting its files, data, behaviors, and cross-references. These eliminate redundant codebase exploration.

### Reading Rule (MANDATORY)
Before exploring or modifying any module, agents **MUST** read its `CONTEXT.md` first. Check for `CONTEXT.md` in the working directory and parent directories.

**Context file locations:**
- `app/(app)/CONTEXT.md` — Home Daily Sync Digest (`/`, server-rendered bands)
- `app/(app)/inventory/CONTEXT.md` — Inventory route map (submodule catalog)
- `app/(app)/inventory/rc-in/CONTEXT.md` — RC IN (Delivery Master Log)
- `app/(app)/inventory/rc-out/CONTEXT.md` — RC OUT (Inventory Usage)
- `app/(app)/inventory/blocking/CONTEXT.md` — Blocking (Warehouse Grid Visualization)
- `app/(app)/inventory/rc-movement/CONTEXT.md` — RC Movement (feeding matrix)
- `app/(app)/inventory/flecon-bags/CONTEXT.md` — FLECON Bags (packaging-material inventory)
- `app/(app)/production/CONTEXT.md` (+ `daily/`, `electricity/`, `trucks/`) — Production module
- `app/(app)/summaries/CONTEXT.md` — Summaries
- `app/(app)/review-queue/CONTEXT.md` — Sync review queue
- `app/(app)/jarvis/CONTEXT.md` — Jarvis route (UI lives in `components/jarvis/`)
- `app/(app)/cenapro/CONTEXT.md` — Cenapro tenant (CI/Cebu)
- `app/(app)/admin/CONTEXT.md` — Admin Panel (User Management)
- `components/digest/CONTEXT.md` — Home Digest bands (the `/` presentation components)
- `components/jarvis/CONTEXT.md` — Jarvis chat UI (mounted via `app-shell.tsx`)
- `components/shared/grid/CONTEXT.md` — Blackwood Table (universal cell selection, inline editing, keyboard nav, context menu — the agnostic grid primitive all data grids share)
- `components/NAVBAR.md` — Navbar (page titles, breadcrumbs)
- `components/providers/AUTH.md` — Auth Provider (permissions, dev override)
- `components/NOTIFICATIONS.md` — Notifications (realtime bell)

### Update Rule (STRICT)
Every code change **MUST** update the relevant `CONTEXT.md` in the same changeset. This includes: adding/removing files, changing server actions, adding DB tables/columns, changing cross-module imports, adding new pages.

### Creation Rule
Create a new `CONTEXT.md` when a module reaches 3+ files AND 200+ total lines. Use the standard template: **Purpose > Files > Data > Key Behaviors > Dependencies > See Also**.

**Naming convention:**
- Modules (directories): `CONTEXT.md`
- Standalone components (single file in shared dir): `<NAME>.md` (e.g., `NAVBAR.md`)

## Home Digest (`/`)

The home page at `/` is the **Daily Sync Digest** — a read-only, top-to-bottom operational briefing rendered as a Server Component (`app/(app)/page.tsx`). It replaced the archived widget dashboard (`_archived/dashboard-v1/`). It never talks to Supabase from the client: one server-side **adapter**, `getDigestData()` in `lib/digest/queries.ts`, queries the `view_digest_*` views (plus blocking + flecon balance) and returns a single normalized `DigestData` object (`lib/digest/types.ts`). Each band is a presentation component in `components/digest/` that consumes one slice of that object — the same port/adapter discipline the widget dashboard used, minus the composable grid.

### Bands (render order, top → bottom in `page.tsx`)

| # | Band component | `DigestData` slice | Purpose |
|---|---|---|---|
| — | `DigestHeader` | `meta` | Operational date, last-sync time, per-stream freshness |
| 1 | `OpenBlocks` | `openBlocks` | Currently **IN-USE** blocks (balance + lab stats), surfaced at the very top |
| 2 | `KpiHero` | `kpis` | Today's headline KPIs with sparklines |
| 3 | `DigestCharts` | `flow`, `price`, `grades` | Daily RC-in/out flow, ₱/kg price (price-gated), production grades |
| 4 | `TrucksSummary` | `trucks` | Trucks with a trip on the operational date (skips if none) |
| 5 | `BagInventory` | `fleconBags` | FLECON bag balance snapshot |
| 6 | `SyncSummary` + `ActivityFeed` | `latestSync`, `activity` | What the last sync brought in |
| 7 | `DigestFooterBand` | `flags`, `monthToDate` | Data-quality flags + month-to-date totals |

### Rules
- The digest is **presentation-only** — all aggregation happens in the `view_digest_*` SQL views, never in TypeScript.
- **Price gating:** ₱/kg data in `DigestCharts` and `openBlocks[].phpKg` must be nulled server-side in `getDigestData()` when `!canViewPrices()`. See the Price gating boundary above.
- See `components/digest/CONTEXT.md` and `app/(app)/CONTEXT.md` for the full band-by-band architecture.

## Blocking Module

Blocking is a **standalone route** at `/inventory/blocking` — a warehouse grid visualization of 220 block locations across 4 warehouses (A/B/C/D). Uses `view_blocking_grid` SQL view for pre-computed data, CSS Grid heatmap cells, slide-over detail panel with delivery/usage history. See `app/(app)/inventory/blocking/CONTEXT.md` for full architecture. Key patterns: role-gated cost data, heatmap coloring by balance percentage, spotlight status filter with dim/glow effect.

## Agent Model

When spawning subagents via the `Task` tool, always use `model: 'opus'` (maps to the latest Opus, currently Opus 4.8). All project implementation subagent definitions in `.claude/agents/` (frontend-design, backend, etc.) are pinned to `model: opus`. Do not default to sonnet or haiku for implementation work in this project.

**Carve-out — the four ICTC sync employees run on Sonnet for routine daily runs.** `gsheet-sync`, `deliveries-manager`, `rc-out-manager`, and `production-manager` are pinned to `model: sonnet`. Their daily PROPOSE/EXECUTE path is deterministic-Python-heavy (extract → classify → diff happens in Python; the agent only orchestrates + judges), so Sonnet is the daily driver. **Escalate an individual sync run to Opus ONLY for genuine conflict adjudication** — a flagged conflict, an ambiguous batch mapping, or a ledger-HOLD decision — by re-launching that agent (or that one row) on Opus, never by the agent self-upgrading. The "always Opus" rule still holds for every implementation agent; this carve-out applies exclusively to the four sync ingestion employees.

## Agent Prompts

All prompts written for Claude Code are saved as `.md` files in `.agents/prompts/`. This is canonical project behavior.

**Why:** Pasting multi-step prompts directly into the terminal breaks formatting when they contain code fences, backticks, TypeScript, or SQL. A file sidesteps this entirely.

**How to invoke a saved prompt in Claude Code:**
```
Read .agents/prompts/<filename>.md and follow the instructions.
```

**Naming convention:** Use kebab-case describing the task, e.g., `wire-supabase-adapters.md`, `kpi-strip-customization.md`.

**When writing a prompt:**
- No nested code fences — use indented prose to describe code shapes instead
- Always start with: read TIMELINE.md, CLAUDE.md, and the relevant CONTEXT.md(s) before starting
- Always include: enter plan mode first, get approval, then execute
- Always end with: give me a summary of what was built, what files changed, and any decisions made

**Prompt archive:** Every prompt lives permanently in `.agents/prompts/`. Do not delete old prompts — they serve as a history of intent and a reference for future agents.

## Git Workflow

- **`main`** — protected, production-ready
- **`dev`** — staging/integration branch
- **`feat/*`** — feature branches, branched from `dev`
- Use **conventional commits**: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
