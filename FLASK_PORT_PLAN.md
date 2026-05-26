# Blackwood — Flask Port + Offline/Online Sync Architecture

> **Purpose.** This document is the single source of truth for porting Blackwood from Next.js 16 + Supabase to a standalone Flask application. It captures every critical insight needed to begin the port without re-reading the entire codebase. Treat it as the entry document for the next session.
>
> **Generated:** 2026-05-25 · **Last revised:** 2026-05-26
> **Source codebase analyzed:** Next.js 16 app at `/Users/renzosy/blackwood` on branch `dev`, commit `aa1393d`
> **Status:** Architectural plan — no code has been written yet.

> ## ⚠️ ARCHITECTURAL PIVOT (2026-05-26)
>
> The original plan modeled Blackwood as a multi-user offline-capable app with bidirectional sync, CRDTs/LWW conflict resolution, outbox + tombstones, etc. **That has been replaced** with a dramatically simpler single-writer architecture after a deeper understanding of the actual operational reality (Renzo as sole data-entry operator; Joseph and owners as read-only audience; daily reports already arriving via Gmail and crying out for AI-driven ingestion).
>
> **New architecture in one sentence:** A local Flask app on Renzo's machine writes to SQLite; a continuous one-way push mirrors that data to hosted Postgres; owners view read-only KPI dashboards in the browser; an AI agent ingests daily email reports into the local app for Renzo to review and approve.
>
> **What changed:**
> - **Multi-writer concurrency is gone.** Only Renzo writes. No CRDTs, no LWW, no per-field versioning, no conflict resolution UI, no vector clocks, no `origin_device` columns.
> - **Sync is now one-way push (local → hosted), not bidirectional.** If local and hosted diverge, local always wins; just re-push. The hosted DB is a continuous backup, not a source of truth.
> - **Offline mode now means "internet is flaky at the plant" only**, not "Supabase is paused." Dev-environment problems get solved by a local Supabase stack (Workflow B), not by sync engine complexity.
> - **AI ingestion agent is the productivity multiplier.** Daily emails (Daily Production, RC IN, FB, etc.) → AI agent parses → proposes inserts → Renzo reviews/approves → commits. Replaces the manual Excel copy-paste workflow.
>
> **What stayed the same:**
> - The hexagonal widget/adapter architecture, the database schema, the role gating model, the audit log philosophy, the dense Industrial Spreadsheet tables, the Module-by-Module port plan
> - Tech stack (Flask 3, SQLAlchemy, Alembic, React+Vite SPA, Postgres for hosted, SQLite for local)
> - The eventual desktop packaging story (pywebview or browser-launched)
>
> Sections updated for the pivot: §1 (Executive Summary), §5 (Auth — simplified), §6 (Realtime — simplified), §7 (Flask Architecture — two-tier), §8 (Sync — heavy rewrite to push-only), §9b (NEW — AI ingestion agent overview), §10 (Roadmap — re-phased), §11 (Risks — simplified), §12 (Open Decisions — most resolved).
>
> See also: `AI_INGESTION_AGENT.md` at project root for the full design of the email-ingestion agent.

> **Audit (2026-05-25):** Cross-checked against the codebase. All major claims verified — the plan is sound. Three findings worth flagging upfront: (1) Section 3.4 — two objects (`user_dashboard_prefs`, `view_blocking_grid`) exist in live Supabase but have no tracked migration; Phase 1 must introspect the live DB. (2) Section 3.5 — `updated_at` is only on 3 of 11 tables; the new `last_modified_at` column we add for the push pipeline is the authoritative timestamp. (3) Section 5 — the Accounting role's permission helper falls through to "allowed" for everything except `delete:all`; scope limitation is UI-only and must be re-implemented as server-side route guards in Flask.

---

## 0. How to Read This Document

This document has three layers:

1. **Sections 1–6** describe the **current** system in depth — what exists, how it behaves, what the boundaries are. Read these first if you have no prior context.
2. **Sections 7–9** describe the **target** Flask architecture and the sync engine. This is the build plan.
3. **Sections 10–13** are the **roadmap, risks, and open decisions** — these are where the next session should resume.

Every claim about the current codebase cites a file path or table name so it can be verified directly.

---

## 1. Executive Summary

### What Blackwood Is
Blackwood is a general-purpose modular BI platform whose first tenant is a charcoal-processing plant. It has two coexisting UX paradigms:

- **Dashboard (`/`):** Composable widget grid — Bloomberg-terminal-style, drag/resize, add/remove widgets. This is **platform code** with zero tenant knowledge.
- **Inventory pages (`/inventory/...`):** Dense, keyboard-navigable spreadsheets (RC IN delivery log, RC OUT usage, Blocking warehouse grid). This is **tenant code** — charcoal-specific and stays specialized.

The architecture mirrors **Grafana's data source model**: widgets consume normalized, data-agnostic interfaces (called *ports*); whoever fills the port (called an *adapter*) can be a static mock or a live Supabase query — the widget never knows.

### What "Port to Flask" Means Here

Blackwood becomes a **two-tier personal business tool**:

1. **Local Flask app** running on Renzo's single machine (one writer). SQLite stores the canonical state. The AI ingestion agent parses daily Gmail reports and proposes inserts; Renzo reviews and commits.
2. **Hosted Flask + Postgres** running on Fly/Railway/Render. Mirror of the local DB. Serves a read-only browser dashboard to Joseph and other owners.
3. **One-way push** from local → hosted, queued when offline, drained when online. No bidirectional sync, no conflict resolution.

The port must:
1. Run the local Flask + SQLite reliably offline — internet flakiness at the plant is the failure mode being addressed (not dev-environment Supabase pauses)
2. Preserve the **hexagonal widget architecture**. Widgets and ports stay; adapters get rewritten to query the local Flask routes
3. Preserve the **Industrial Spreadsheet feel** of the inventory pages — dense tables, keyboard nav, paste support, cell selection, audit trails
4. Preserve **role-based access control** (Owner/Admin/Dev/Production/Accounting) and **audit logs** — but auth simplifies: local app is single-user (Renzo), hosted is read-only with a stub password until proper accounts are added
5. **Introduce the AI ingestion agent** as a first-class component (see `AI_INGESTION_AGENT.md`)

### Key Architectural Decisions (Revised 2026-05-26)

| Decision | Recommendation | Status |
|---|---|---|
| Backend | Flask 3 + SQLAlchemy 2 + Alembic | Locked |
| DB (local / canonical) | SQLite (single-writer source of truth) | Locked |
| DB (hosted / mirror) | PostgreSQL (Supabase or Fly/Railway managed) | Locked |
| Auth (local app) | None — single-user, machine-local | Locked |
| Auth (hosted dashboard) | Stub: single shared password env var (`OWNER_DASHBOARD_PASSWORD`). Replace with per-user accounts in a later phase. | Locked |
| Real-time | Owner dashboard polls every N seconds OR uses SSE for "new data" nudges. No WebSocket. | Locked |
| Frontend | Keep React + Vite SPA. Local Flask serves it for entry workflows; hosted Flask serves it read-only for owners. | Locked |
| Sync model | One-way push (local → hosted). No conflict resolution because there's only one writer. | Locked |
| Packaging | `pywebview` for distribution; `python launch.py` for personal use | Locked |
| Trigger logic | Move from SQL triggers to Python service layer | Locked |
| AI ingestion agent | Claude API + per-report-type extraction templates + human-in-the-loop review queue. See `AI_INGESTION_AGENT.md` | Locked (design) |

Section 12 lists the few decisions still open.

---

## 2. Current Architecture (Next.js + Supabase)

### 2.1 Stack
- **Next.js 16** App Router, React 19, TypeScript strict
- **Supabase** — Postgres + Auth + Realtime + Storage
- **Shadcn UI** (new-york style, zinc base) + Radix primitives
- **TanStack Table + TanStack Virtual** for dense data tables
- **react-grid-layout** for the dashboard
- **cmdk** for command menus, **date-fns** for dates, **recharts**, **sonner**, **next-themes**
- **Tailwind CSS v4** with dark-mode via CSS variables and `next-themes`

The build is small — see `package.json:11-47`. No test framework configured.

### 2.2 Module Inventory

**Auth surfaces**
- `app/login/page.tsx` + `app/login/components/LoginForm.tsx` — Google OAuth entry point
- `app/auth/callback/route.ts` — OAuth exchange, profile bootstrap, retries up to 3× to handle the new-user trigger race
- `app/access-denied/page.tsx` — soft-delete denial page
- `middleware.ts` — JWT validation, redirects unauthenticated requests except `/login`, `/auth`, `/access-denied`, `/api`

**Dashboard (platform layer)**
- `app/(app)/page.tsx` — async server component; runs four charcoal adapters and the dashboard-prefs loader in `Promise.allSettled` and passes results to the client shell
- `app/(app)/actions.ts` — `fetchKpiData(period)`, `loadDashboardPrefs()`, `saveDashboardPrefs()`
- `components/dashboard/DashboardShell.tsx` — SSR-safe client wrapper
- `components/dashboard/DashboardGrid.tsx` — layout state, edit mode, localStorage + Supabase persistence (debounced 1500 ms), per-widget settings
- `components/dashboard/WidgetShell.tsx` — generic frame: title bar, collapse, remove, `ResizeObserver` + `WidgetSizeContext`
- `components/dashboard/WidgetPicker.tsx` — "Add widget" modal, reads from `WIDGET_REGISTRY`
- `components/dashboard/WidgetError.tsx` — per-widget error panel with clipboard-copy diagnostic
- `lib/dashboard/types.ts` — `D6Prefs`, `LayoutItem`
- `lib/dashboard/profile-store.ts` — multi-profile localStorage store (key `bw_v1`, legacy `bw_d6_prefs` migrated)
- `lib/dashboard/migrate-prefs.ts` — pure migration helper

**Inventory wrapper** (`app/(app)/inventory/`)
- `layout.tsx` — `InventoryTabProvider` + sticky tabs (`sheet-tabs.tsx`)
- `page.tsx` — async server component; fetches RC IN deliveries, batches, suppliers, locations
- `components/inventory-tab-context.tsx` — tab state persisted to `localStorage`
- `components/inventory-view.tsx` — 150 ms crossfade between tabs
- `components/rc-out-lazy-tab.tsx` and `components/blocking-lazy-tab.tsx` — lazy-load on first click; component stays mounted afterward
- `components/DeliverySheetFooter.tsx` — month/year navigation

**RC IN — Delivery Master Log** (`app/(app)/inventory/rc-in/`)
- `actions.ts` — 15 server actions (bulk submit/update/delete deliveries, audit fetches, comments, resolve workflow, table settings)
- `bulk-delivery-input.tsx` — paste grid editor with autocomplete and rectangular cell selection
- `delivery-master-table.tsx` — virtual-scroll table, three header filters (STATE/Supplier/LOC), two density modes, lab-cell highlights, context menu
- `components/settings-dialog.tsx` — density, font size, per-lab-metric color thresholds
- `components/columns-popover.tsx` — column visibility (role-gated PHP/KG)
- `components/DeliveryHistoryDialog.tsx` — audit trail modal
- `components/audit-shared.tsx` — shared field labels, diffs, cost scrubbing
- `paste-utils.ts` — column mapping, Excel date parsing, currency stripping

**RC OUT — Inventory Usage** (`app/(app)/inventory/rc-out/`)
- `actions.ts` — `fetchRcOutTabData`, `createRcOutRecord`, `submitBulkUsage`, `bulkUpdateUsage`, `deleteRcOutRecord`, `bulkDeleteRcOut`
- `bulk-usage-input.tsx`, `components/rc-out-table.tsx` — same patterns as RC IN
- `paste-utils.ts` — column mapping

**Blocking — Warehouse Grid** (`app/(app)/inventory/blocking/`)
- `actions.ts` — `fetchBlockingGridData`, `fetchBlockingDetail`, `fetchSingleDelivery`, `updateBlockNotes`
- `blocking-grid.tsx` — CSS Grid heatmap across 4 warehouses (A/B/C/D = 220 slots total: 60/40/40/80)
- `blocking-detail-panel.tsx` — 520 px slide-over with metrics, inline notes editor, delivery/usage history
- `edit-delivery-dialog.tsx` — full-delivery edit form
- `types.ts`, `constants.ts` — warehouse config

**Admin** (`app/(app)/admin/`)
- `actions.ts` — `inviteUser`, `revokeUserAccess`, `reactivateUser`, `updateUserRole`
- `components/UserManagementTable.tsx` — inline role dropdown, revoke/reactivate
- `components/InviteUserDialog.tsx`, `components/RevokeAccessDialog.tsx`, `components/UserStatusBadge.tsx`

**Edit/Discussion** (`app/(app)/edit/[auditLogId]/`)
- Deep-linked discussion UI for resolving audit logs, with system messages on approve/deny/reopen

**Settings + Notifications**
- `app/(app)/settings/` — role display, simple `updateUserRole`
- `app/(app)/notifications/` — full notifications list page (mirrors the navbar bell)

**Navbar & global chrome**
- `components/navbar.tsx` — breadcrumbs via `getBreadcrumb()`, modules dropdown, dev role switcher (Shield), dark-mode toggle, notification bell, avatar
- `components/notification-bell.tsx` — realtime subscribe with polling fallback (30 s → 1.5× → 120 s max; tab-hidden pause)
- `components/floating-status-bar.tsx` — bottom-right cell selection + aggregates + connection status
- `components/providers/auth-context.tsx` — `useAuth()`, permission matrix, dev override via cookie + `localStorage`
- `components/providers/table-settings.tsx`, `components/providers/status-bar-context.tsx`, `components/providers/theme-provider.tsx`

### 2.3 Two Coexisting UX Paradigms

**Dashboard.** Composable, source-agnostic, drag-and-resize. The widget knows nothing about charcoal — it takes a typed prop and renders. This is the "platform layer" and is the design target for everything new.

**Inventory pages.** Dense Excel-style tables. Cell selection, paste, keyboard navigation (Arrow / Tab / Enter / F2 / Esc), TSV copy, header filters with STATE-exclusion vs Supplier/LOC-inclusion models, virtual scrolling, audit trail dialogs. These are tenant-specific and stay specialized — the value is the keyboard-first, spreadsheet-equivalent feel.

### 2.4 Hexagonal Boundary (CRITICAL — preserve in port)

The cleanest abstraction in the codebase is the **widget ↔ adapter boundary**.

**Platform code (zero domain knowledge):**
- `components/widgets/**` — every widget reads from typed ports
- `components/dashboard/**` — grid, shell, picker, error panel
- `lib/dashboard/**` — preference shape and storage

**Tenant code (charcoal-specific):**
- `lib/widgets/adapters/charcoal-*.ts` — four adapters: `charcoal-kpi`, `charcoal-chart`, `charcoal-warehouse`, `charcoal-special`
- `lib/widgets/adapters/tenant-config.ts` — `CHARCOAL_FIELD_CONFIG`, `CHARCOAL_CHART_CONFIG`, palettes
- `lib/widgets/mock-data.ts` — static charcoal-shaped fallback

**The ports themselves** (live in `components/widgets/<name>/types.ts`):
- `KPIData[]` — chip variants, thresholds, sparklines, comparisons, flow/progress/ratio modes
- `ChartConfig` — `xAxis`, `yAxis`, `seriesGroups`, `series`, `presets`, `fiscalCalendar`, `dataYears`
- `WarehouseData[]` — `{label, occupied, total, phpKg, mc, ash}`
- `SpecialChartData` — `{rows[], fields[]}` plus `SpecialChartSettings` (scatter/pie/donut with field-driven X/Y/colorBy)

**The adapter contract** (`lib/widgets/adapters/types.ts`):
```typescript
interface WidgetAdapter<TPort> {
  id: string
  fetch: (client: SupabaseClient) => Promise<TPort>
}
```

In the Flask port, only the **`client`** argument changes (from `SupabaseClient` to a Flask-aware data accessor). The widgets stay unchanged.

---

## 3. Database Schema Reference

The Supabase Postgres schema is the contract. Migrations live in `supabase/migrations/`. The port should keep the same logical schema with three additions (Section 8.3) for sync.

### 3.1 Core Tables

**`batches`** — physical inventory units. `id` UUID PK, `batch_code` text UNIQUE (this is the human-facing key — CSV/Excel parity), `location_ref` text (format `[A-Z]\d{2}-\d{3}` checked), `current_weight` numeric, `avg_cost` numeric, `status` enum `batch_status`, `quality_stats` JSONB, `notes` text, `created_at`, `updated_at`. Status is **always derived by trigger** from rc_out — never write it directly.

**`deliveries`** — RC IN log. `id` UUID PK, `transaction_date` date, `supplier` text, `truck_plate` text, `weight_kg` numeric, `sacks` int, `cost_basis` numeric (₱/kg), `batch_code` FK→`batches.batch_code`, `block_loc` text, `lab_results` JSONB (`{mc, grit, vm, ash, fc, bd_astm, bd_jis}`), `remarks` text, `created_at`.

**`rc_out`** — usage records. `id` UUID PK, `batch_id` UUID FK→`batches.id`, `transaction_date` date, `destination` text (`MAIN` or `SUNDRY`), `weight_kg` numeric, `production_batch` text, `block_loc` text, `remarks` text (may contain `CLOSED` keyword for status inference), `created_at`. Has two **stored-function-computed columns** accessed at query time: `rc_out_avg_price(row)` and `rc_out_avg_wtd_value(row)`.

**`profiles`** — user accounts. `id` UUID PK = `auth.users.id`, `email`, `display_name`, `avatar_url`, `role` text CHECK (`Owner`/`Admin`/`Dev`/`Production`/`Accounting`) default `Production`, `status` text CHECK (`active`/`pending`/`disabled`) default `pending`, timestamps.

**`user_invites`** — invite whitelist. `email` PK, `role`, `invited_by` FK→`profiles.id`, `created_at`. RLS: Owner/Admin only.

**`audit_logs`** — immutable change log. `id` UUID PK, `table_name`, `record_id` text, `operation` (`INSERT`/`UPDATE`/`DELETE`), `snapshot` JSONB (post-state), `diff` JSONB, `comment` text, `performed_at`, `performed_by` UUID, plus a resolve workflow (`resolve_requested`, `resolve_request_type`, `resolve_requested_by/at`, `resolved`, `resolved_by`, `resolved_at`).

**`audit_comments`** — threaded discussion on audit logs. `id`, `audit_log_id` FK→`audit_logs.id`, `user_id`, `body`, plus resolve fields, `created_at`.

**`notifications`** — user inbox. `id`, `user_id`, `type` enum `notification_type`, `title`, `body`, `source_user_id`, `metadata` JSONB, `read`, `read_at`, `archived`, `created_at`. RLS: own-row read/update; insert via function only.

**`notification_subscriptions`** — `id`, `user_id`, `audit_log_id` FK→`audit_logs.id`.

**`user_dashboard_prefs`** — `user_id` PK = `auth.users.id`, `prefs` JSONB (the `D6Prefs` shape), `updated_at`.

**`user_table_settings`** — `id`, `user_id`, `module` text (e.g. `'rc-in'`), `settings` JSONB, `updated_at`. Composite uniqueness on (`user_id`, `module`).

### 3.2 Views, Functions, Triggers, Enums

**Views**
- `view_rc_in_master` — LEFT JOIN of `deliveries` with `batches` on `batch_code`. Adds `state` from `batches.status` and `block_loc` falling back to `batches.location_ref`.
- `view_blocking_grid` — aggregates deliveries + rc_out per batch. Columns include `batch_id`, `batch_code`, `block_loc`, `status`, `total_in` = SUM(deliveries.weight_kg), `balance` = total_in − SUM(rc_out.weight_kg), `avg_php_kg` (weight-weighted), and weighted averages of all seven lab metrics.

**Functions (RPC)**
- `_insert_notification(p_user_id, p_title, p_body, p_type, p_source_user_id, p_metadata)` — security-definer helper used by audit triggers.
- `set_audit_comment(text)` — attaches a context comment to the current transaction's audit log row. Called before each `UPDATE` in `bulkUpdateDeliveries` and `bulkUpdateUsage`.
- `is_admin(user_id UUID) → boolean` — used in RLS policies.
- `rc_out_avg_price(row)`, `rc_out_avg_wtd_value(row)` — computed columns.

**Triggers**
- `tr_blackwood_usage` on `rc_out` (BEFORE INSERT/UPDATE/DELETE) — calls `fn_process_blackwood_usage()`. Updates `batches.current_weight` and recomputes `batches.status` based on all rc_out for that batch. Status priority: `FEED > CLOSED > SUNDRYING > IN-USE > STORED`.
- `handle_new_user` on `auth.users` (AFTER INSERT) — creates profile from `user_invites` whitelist if email present (status `active`), else default Production + status `pending`.
- `on_invite_created` on `user_invites` (AFTER INSERT) — activates any pending profile matching the invited email.

**Enums**
- `batch_status` = `STORED | IN-USE | CLOSED | FEED | SUNDRYING | SUNDRIED`
- `notification_type` = `resolve_request | resolve_approved | resolve_denied | delivery_created | delivery_edited | delivery_deleted | remarks_added | audit_comment_reply`

**RLS policies**
- `notifications`: `auth.uid() = user_id` for SELECT/UPDATE; INSERT allowed for any authenticated user (rate-limited via `_insert_notification`).
- `user_invites`: SELECT/INSERT/DELETE restricted to Owner/Admin.

### 3.3 Things to Note for the Port
- `batch_code` is **text-based linking**, not UUID. Preserve this — operators reference batch codes directly when typing into the bulk grid.
- The `view_*` views compute aggregates at query time. Reimplement as either SQL views or service-layer query helpers.
- Triggers maintain invariants the application depends on. In Flask, **move trigger logic into a Python service layer** (see Section 8.8) so it works identically on Postgres and SQLite.
- The audit `comment` flow uses a Postgres session variable set by `set_audit_comment(text)`. In Flask, pass the comment explicitly through the service function.
- **`view_rc_in_master.block_loc` is sourced from `batches.location_ref AS block_loc`**, not from `deliveries.block_loc`. The view's `state` column is `batches.status`. Confirmed at `supabase/migrations/20260214173709_rewrite_trigger_view_and_data_fix.sql:174–190`.

### 3.4 Schema Drift — Untracked Objects in Live Supabase (CRITICAL)

Code audit (2026-05-25) confirmed that the live Supabase project contains two objects whose definitions are **not** in `supabase/migrations/`:

| Object | Where it's used | Where it's missing |
|---|---|---|
| `user_dashboard_prefs` table | `app/(app)/actions.ts:27,44` (loadDashboardPrefs / saveDashboardPrefs) — also referenced in `TIMELINE.md` | Not in any migration file; not in `types/supabase.ts` |
| `view_blocking_grid` view | `app/(app)/inventory/blocking/actions.ts:29` (fetchBlockingGridData) | Present in `types/supabase.ts:449–466` but no `CREATE VIEW` in any migration |

**Implication for the port:** the `supabase/migrations/` directory is **not authoritative**. Before writing Alembic migrations, the next session must:
1. Run `supabase db dump --schema-only` (or `pg_dump --schema-only`) against the live project to capture the actual schema
2. Diff that against the tracked migrations to find every drift point
3. Reconcile by either (a) writing missing migrations or (b) using the live dump as the Alembic starting point

This is added as a sub-task to Phase 1 of the roadmap (Section 10).

### 3.5 `updated_at` Coverage (CRITICAL for sync design)

| Table | Has `updated_at`? |
|---|---|
| `batches` | yes |
| `profiles` | yes |
| `user_table_settings` | yes |
| `deliveries` | **no** |
| `rc_out` | **no** |
| `audit_logs` | no (has `performed_at` instead) |
| `audit_comments` | no |
| `notifications` | no (has `created_at`, `read_at`) |
| `notification_subscriptions` | no |
| `user_invites` | no |
| `user_dashboard_prefs` | yes (per `actions.ts` upsert; live-only — see Section 3.4) |

**Sync engine implication:** the LWW timestamp in Section 8 is **not** any existing `updated_at` column. It's the **new `last_modified_at` column** the migration in Section 8.3 adds to every domain table. This is the only timestamp the sync resolver looks at; existing `updated_at` data can be backfilled into `last_modified_at` during the schema migration but the new column is authoritative.

---

## 4. Server Actions / Business Logic Inventory

These are the mutations the port needs to expose as REST endpoints (or RPC functions). Cited locations are the existing Next.js server actions.

### Dashboard — `app/(app)/actions.ts`
- `fetchKpiData(period?: KPIStripSettings['period'])` → `KPIData[]` — refresh KPI strip on period change; `period` accepts `'today' | 'week' | 'month' | 'quarter' | 'year'` (default `'month'`)
- `loadDashboardPrefs()` → `D6Prefs | null` — read user's saved layout
- `saveDashboardPrefs(prefs)` → void — upsert on `user_id`

### Admin — `app/(app)/admin/actions.ts`
- `inviteUser(email, role)` — admin-only; validates email format; inserts into `user_invites`; uses service-role bypass
- `revokeUserAccess(userId)` — sets `profiles.status='disabled'`; rejects self-revocation
- `reactivateUser(userId)` — sets `profiles.status='active'`
- `updateUserRole(userId, role)` — updates `profiles.role`

All four require the caller's role to be in `['Owner', 'Admin', 'Dev']`.

### RC IN — `app/(app)/inventory/rc-in/actions.ts`
- `submitBulkDeliveries(rows)` — validates each `block_loc`, checks for duplicate active batches at target locations, upserts `batches` first, then bulk inserts into `deliveries`. Returns translated DB errors.
- `updateDelivery(id, data)` — single-row update with block-loc validation.
- `bulkUpdateDeliveries(updates)` — row-by-row update with optional per-row comment; calls `set_audit_comment` before each, then inserts an `audit_comments` row referencing the audit log just produced.
- `bulkDeleteDeliveries(ids)` — bulk delete.
- `getDeliveryHistory(deliveryId)` — fetches current delivery + audit log entries enriched with `profiles`; **scrubs `cost_basis` for Production role** in current/snapshot/diff.
- `deleteDelivery(id)` — single-row delete.
- `getAuditComments(auditLogId)` — fetch + enrich with author profile.
- `addAuditComment(auditLogId, body)` — insert comment.
- `resolveAuditLog(auditLogId)` — privileged toggle of `resolved` + system comment.
- `requestResolveAuditLog(auditLogId, type)` — any user proposes resolve/reopen; system comment posted.
- `approveResolveRequest(auditLogId)` — privileged approve; clears request flag, applies resolution.
- `denyResolveRequest(auditLogId, reason)` — privileged deny + reason in system comment.
- `getAuditLogEntry(auditLogId)` — single audit log + delivery; cost scrubbing per role.
- `getTableSettings(module)` — read merged table prefs from `user_table_settings`.
- `saveTableSettings(module, settings)` — partial-merge upsert.

### RC OUT — `app/(app)/inventory/rc-out/actions.ts`
- `getRcOutRecords(search, field, offset, limit, startDate, endDate)` — paged read with multi-field search (`'all' | 'batch_code' | 'production_batch' | ...`)
- `deleteRcOutRecord(id)`, `bulkDeleteRcOut(ids)`
- `createRcOutRecord(input)`, `submitBulkUsage(rows)`
- `bulkUpdateUsage(updates)` — same comment + audit pattern as RC IN
- `fetchRcOutTabData()` — fetches all `rc_out` + all `batches` (paged 1000) and computes dropdown options (batches, destinations, batchOptions, yearOptions, blockLocs natural-sorted)

### Blocking — `app/(app)/inventory/blocking/actions.ts`
- `fetchBlockingGridData()` — reads `view_blocking_grid`; returns `{ blocks: Record<block_loc, BlockData>, canViewPrices: boolean }`; `canViewPrices` false for Production role
- `fetchBlockingDetail(batchCode, batchId)` — parallel reads of deliveries (by `batch_code`) + rc_out (by `batch_id`) + the batches row; cost scrubbing per role
- `fetchSingleDelivery(deliveryId)` — full delivery with lab_results flattened
- `updateBlockNotes(batchId, notes)` — writes `batches.notes`

### Settings / Notifications
- `app/(app)/settings/actions.ts`: `updateUserRole(userId, role)` — duplicate of admin path
- `app/(app)/notifications/actions.ts`: `getNotifications(cursor, limit)`, `getUnreadCount()`, `markAsRead(id)`, `markAllAsRead()`, `archiveNotification(id)`

### Auth helpers — `lib/auth.ts`, `lib/supabase/{server,client,admin}.ts`, `middleware.ts`
- `getUserRole(userId)` checks profile role, then a `dev_mock_role` cookie override for privileged users
- `createAdminClient()` uses the service-role key (used only in `inviteUser`)
- `middleware.ts` validates JWT, allows `/login`, `/auth`, `/access-denied`, `/api`

### Validation
- `lib/validation.ts` — `validateBlockLoc`, `normalizeBlockLoc`
- `lib/rc-utils.ts` — `calculateWhse(blockLoc, batchCode?)` derives the warehouse letter

These all need direct Python equivalents. There is no obscure logic here — most of the complexity is in the audit/comment plumbing and the cost scrubbing for Production role.

---

## 5. Auth & Permissions Model

### Roles
`Owner | Admin | Dev | Production | Accounting` — strings stored in `profiles.role` with a CHECK constraint.

### Permission Matrix
| Permission | Owner | Admin | Dev | Accounting | Production |
|---|---|---|---|---|---|
| `view:all` | yes | yes | yes | yes | yes |
| `view:prices` | yes | yes | yes | yes | **no** |
| `edit:all` | yes | yes | yes | yes | yes |
| `delete:all` | yes | yes | yes | **no** | **no** |

Plus a separate privileged-role concept (`Owner | Admin | Dev`) for admin actions (invite, role change, resolve approval).

**Caveat from the audit (2026-05-25):** the permission helper at `components/providers/auth-context.tsx:142–165` blocks only `delete:all` for the Accounting role and **falls through to `return true` for every other permission**. The intended Accounting scope limitation ("Accounting only sees `/inventory/rc-in`") is enforced by UI-level role checks elsewhere, not by the permission helper. **The Flask port must add explicit server-side role checks per route** — do not rely solely on permission-helper equivalents. Treat the matrix above as the *intended* model and add `@require_role(...)` guards on every API endpoint that needs role-based scoping.

### Status
`profiles.status = 'active' | 'pending' | 'disabled'`. The auth context (`useAuth()`) signs the user out and redirects to `/access-denied` (disabled) or `/login?error=not_invited` (pending).

### Dev Role Override
Privileged users can impersonate any role via the navbar Shield icon. Storage:
- `localStorage.dev_mock_role` for client-side reactivity
- A cookie also named `dev_mock_role` so server-side `getUserRole()` sees the same value

In the Flask port, replicate via a `dev_mock_role` cookie read by the server and reflected in the session.

### Invite-Only Onboarding
1. Admin adds email to `user_invites`
2. Supabase sends a magic link
3. User signs in via Google OAuth
4. `handle_new_user` trigger creates a profile from the invite (or pending if not invited)
5. The `/auth/callback` route retries up to 3× to handle the trigger race

In Flask, this becomes: invite check happens in the OAuth callback handler before profile creation; profile is `active` if invite exists, else `pending`.

---

## 6. Real-time Features

The only persistent realtime surface today is the **notification bell** (`components/notification-bell.tsx`):

- Subscribes to `postgres_changes` on `notifications` (INSERT + UPDATE filtered by `user_id`)
- On `SUBSCRIBED`, sets status green and stops polling
- On error/timeout, falls back to adaptive polling: 30 s → 1.5× → 120 s max
- Pauses polling when the tab is hidden; resumes immediately when visible

The blocking grid, RC IN, RC OUT, and dashboard widgets are **all polled/refetched on revalidate** — no persistent socket. This is a significant simplifier for the port: realtime is contained to one feature.

For the Flask port, Flask-SocketIO (or SSE) on a `/ws/notifications/<user_id>` channel covers this. The same adaptive polling fallback survives unchanged.

---

## 7. Flask Port — Target Architecture

### 7.1 Tech Stack Decisions (Recommended)

**Core**
- **Python 3.12** — modern type hints, performance, `tomllib`
- **Flask 3.0** — application factory pattern
- **SQLAlchemy 2.0** — modern declarative ORM, async-friendly
- **Alembic** — migrations (port Supabase migrations 1:1)
- **Pydantic v2** — data validation and port type modeling (these mirror the TypeScript port interfaces)
- **python-dotenv** + `pydantic-settings` — config

**HTTP / Routing**
- Flask blueprints per module: `bp_dashboard`, `bp_inventory_rcin`, `bp_inventory_rcout`, `bp_inventory_blocking`, `bp_admin`, `bp_auth`, `bp_notifications`, `bp_audit`
- Each blueprint exposes JSON endpoints prefixed by `/api/<module>` (REST-ish; matches existing server-action mapping)

**Auth**
- **Flask-Login** for session management
- **Authlib** for Google OAuth (works for both local dev with redirect URIs and packaged desktop apps with custom URL schemes if needed)
- Roles & permissions resolved on each request and cached on `g.user`

**Real-time**
- **Flask-SocketIO** with the `eventlet` or `gevent` worker for WS
- Use a single namespace `/realtime`; rooms keyed by `user:<id>`
- SSE fallback (Flask streams `text/event-stream`) for environments where WS is blocked

**Frontend (Recommended Option B: Keep React)**
- Extract the existing `app/(app)/components/*` and `components/**` into a Vite-built React SPA
- Flask serves the built bundle as static files from `static/dist/`
- React queries `/api/...` routes; WebSocket for notifications
- Why keep React: the dense table interactions (cell selection, paste, keyboard nav, virtual scroll) are the single most expensive thing in the codebase. Rebuilding them in Jinja/HTMX is a multi-week project for no functional gain. Section 11 covers the trade-offs.

**State management on the client**
- React Query / TanStack Query for server cache (replaces revalidatePath)
- Keep TanStack Table + Virtual unchanged
- Zustand or context for cross-component state (RC IN status bar selection, etc.)

**Packaging for offline**
- **`pywebview`** (lightweight, single binary via PyInstaller) — opens a native window pointing at the bundled Flask + bundled SQLite, runs both in-process
- Alternative: **`Tauri`** if a smaller binary is wanted, but requires Rust toolchain
- Alternative (simplest): a **`launch.py`** script that starts Flask on `localhost:5000` and opens the default browser. No native shell. Works on any OS.

### 7.2 Application Structure (Proposed)

```
blackwood_flask/
├── pyproject.toml
├── alembic.ini
├── alembic/
│   └── versions/                # ported from supabase/migrations/
├── app/
│   ├── __init__.py              # create_app(); register blueprints
│   ├── extensions.py            # db, login_manager, socketio singletons
│   ├── config.py                # Settings via pydantic-settings
│   ├── models/                  # SQLAlchemy models
│   │   ├── batch.py
│   │   ├── delivery.py
│   │   ├── rc_out.py
│   │   ├── profile.py
│   │   ├── user_invite.py
│   │   ├── audit_log.py
│   │   ├── audit_comment.py
│   │   ├── notification.py
│   │   ├── user_dashboard_prefs.py
│   │   ├── user_table_settings.py
│   │   └── sync_outbox.py       # NEW — Section 8.4
│   ├── schemas/                 # Pydantic models (the "ports")
│   │   ├── kpi.py               # KPIData, KPIStripSettings
│   │   ├── chart.py             # ChartConfig, ChartSeries, ...
│   │   ├── warehouse.py         # WarehouseData
│   │   ├── special_chart.py     # SpecialChartData, FieldDef
│   │   ├── delivery.py
│   │   ├── rc_out.py
│   │   ├── audit.py
│   │   └── dashboard_prefs.py   # D6Prefs
│   ├── services/                # business logic — the trigger replacements
│   │   ├── batch_state.py       # replaces fn_process_blackwood_usage
│   │   ├── audit.py             # audit log writer; set_audit_comment context
│   │   ├── profile_bootstrap.py # replaces handle_new_user + handle_invite_creation
│   │   ├── notifications.py     # _insert_notification
│   │   ├── validation.py        # validate_block_loc, normalize_block_loc
│   │   ├── rc_utils.py          # calculate_whse
│   │   └── cost_scrub.py        # role-based field redaction
│   ├── adapters/                # tenant-specific (Grafana-style)
│   │   ├── charcoal_kpi.py
│   │   ├── charcoal_chart.py
│   │   ├── charcoal_warehouse.py
│   │   ├── charcoal_special.py
│   │   └── tenant_config.py     # CHARCOAL_FIELD_CONFIG, CHARCOAL_CHART_CONFIG
│   ├── blueprints/
│   │   ├── auth.py              # OAuth + session
│   │   ├── dashboard.py         # /api/dashboard/...
│   │   ├── rc_in.py             # /api/rc-in/...
│   │   ├── rc_out.py            # /api/rc-out/...
│   │   ├── blocking.py          # /api/blocking/...
│   │   ├── admin.py             # /api/admin/...
│   │   ├── notifications.py     # /api/notifications/...
│   │   └── sync.py              # /api/sync/...  (Section 8)
│   ├── realtime/
│   │   └── socketio_handlers.py # bell channel
│   ├── sync/                    # Section 8 — the engine
│   │   ├── outbox.py            # write to outbox after each mutation
│   │   ├── pull.py              # pull remote changes
│   │   ├── push.py              # push local outbox
│   │   ├── resolve.py           # LWW + tombstones
│   │   └── runner.py            # background worker (APScheduler or thread)
│   ├── auth/
│   │   ├── permissions.py       # has_permission, permission matrix
│   │   ├── decorators.py        # @require_role, @require_login
│   │   └── role.py              # role enum, dev_mock_role cookie handling
│   ├── static/dist/             # Vite-built React bundle
│   └── templates/               # Jinja shell (one root index.html)
├── frontend/                    # React + Vite — extracted from current app
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/                 # fetch wrappers for /api/...
│       ├── components/          # ported from current components/
│       ├── routes/              # client-side router
│       └── stores/              # zustand or context
├── scripts/
│   ├── seed_rc_in.py            # ported from scripts/seed_rc_in.ts
│   ├── port_supabase_to_pg.py   # one-shot import from existing Supabase
│   └── packaging/
│       ├── build_pywebview.py
│       └── pyinstaller.spec
└── tests/                       # pytest — Section 10 talks about this
```

### 7.3 Auth Replacement
**OAuth login flow**
1. User clicks "Sign in with Google" → Flask redirects to Google
2. Google → `/auth/callback?code=...`
3. Server exchanges code, gets email
4. Service `profile_bootstrap.ensure_profile(email)`:
   - If `user_invites.email` exists → profile created with role from invite, status `active`
   - Otherwise → profile created with role `Production`, status `pending`
5. Set `session['user_id']` via Flask-Login `login_user(profile)`
6. If `status != 'active'`, redirect to `/access-denied`

**Permission checks** are decorators or service-layer guards:
```python
@require_role('Owner', 'Admin', 'Dev')
def invite_user(): ...

@require_permission('view:prices')
def get_delivery_history(...): ...
```

The `cost_scrub.py` service handles role-based field redaction on read.

### 7.4 Real-time Replacement
**Notification bell**
- On connect, client joins room `user:<id>`
- After any mutation that creates a notification (in `services/notifications.py`), the service emits a `notification.created` event to that room
- Client listens, prepends to the list, animates the badge

**Connection-status fallback** mirrors the existing client: if the WS connection drops, fall back to polling `/api/notifications?since=...` every 30 s with exponential backoff. The status-bar dot turns yellow while degraded.

### 7.5 Frontend Strategy — Option B (Recommended)

**What gets reused as-is** (after small tweaks)
- All widget components (`components/widgets/**`) — they read from props, no Next.js dependency
- All UI primitives (`components/ui/**`) — Shadcn is React-only and doesn't need Next.js
- The dashboard shell (`components/dashboard/**`) — drag/drop, persistence shape unchanged
- The dense tables (`bulk-delivery-input.tsx`, `delivery-master-table.tsx`, `blocking-grid.tsx`) — TanStack Table/Virtual is framework-agnostic
- All providers (`components/providers/**`) — Auth provider hits a new `/api/auth/me` endpoint instead of Supabase

**What gets rewritten**
- Next.js server actions → fetch calls hitting Flask `/api/...`
- `revalidatePath` → TanStack Query cache invalidation
- Next.js routing → React Router (or TanStack Router) for SPA navigation
- `middleware.ts` JWT check → React Query loader that hits `/api/auth/me` on app boot
- Supabase realtime → Socket.IO client

**What gets dropped**
- Next.js App Router, server components, RSC streaming
- Supabase SDK (entirely)
- `next-themes` stays — it's framework-agnostic

### 7.6 Hexagonal Boundary Preservation

The widget/adapter boundary maps cleanly to Python:

**TypeScript port** → **Pydantic schema** in `app/schemas/`
**TypeScript adapter** → **Python module** in `app/adapters/` implementing `fetch(db_session) → PydanticModel`

The widget itself stays in React, consuming JSON. The Flask blueprint just calls the adapter and serializes:

```python
# app/blueprints/dashboard.py
@bp.get('/api/dashboard/kpi')
@require_login
def get_kpi():
    period = request.args.get('period', 'month')
    data = charcoal_kpi.fetch(db.session, period=period)
    return data.model_dump_json()
```

**To onboard a new tenant** (e.g. Acme): create `app/adapters/acme_*.py`, register at app startup via a tenant config string. The widget code never moves.

---

## 8. Sync Architecture (Single-Writer Push-Only)

> **Architectural pivot (2026-05-26):** the original plan modeled this as a multi-writer offline-capable sync with CRDTs/LWW conflict resolution, outbox + tombstones + vector clocks. **That has been replaced** with a single-writer push-only model after a deeper understanding of the operational reality (Renzo as sole data-entry operator; Joseph and other owners as read-only audience). This section is now ~80% shorter and ~95% simpler.

### 8.1 The model

Only Renzo's local Flask app writes. The hosted Postgres is a continuous mirror, served read-only to owners via a separate browser dashboard.

- **Source of truth:** local SQLite on Renzo's machine
- **Mirror:** hosted Postgres (Supabase or Fly/Railway managed)
- **Direction:** one-way push, local → hosted
- **Cadence:** push after every mutation (debounced 500 ms) when online; queued in a local outbox table when offline; drained when network returns
- **Conflict resolution:** none needed — there is only one writer

### 8.2 Why this works

- 100% of writes come from one machine, by construction
- The hosted DB only ever receives state from that one source
- If local and hosted disagree, local always wins (the mirror gets rebuilt from local on the next push)
- "Offline mode" reduces to "queue writes, drain when network returns" — a trivial pattern with a 50-year track record

### 8.3 Schema changes — minimal

Just two new tables. **No `sync_version`, no `origin_device`, no `last_modified_at`, no tombstones for sync purposes** — single-writer means none of these are needed.

```sql
-- Push outbox: every mutation appends here
CREATE TABLE sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,        -- monotonic sequence
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL,                     -- 'insert' | 'update' | 'delete'
    payload TEXT NOT NULL,                       -- JSON of full row state after op
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT                               -- NULL until pushed; set when hosted accepts
);
CREATE INDEX ix_sync_outbox_pending ON sync_outbox (synced_at) WHERE synced_at IS NULL;

-- Single-row sync state
CREATE TABLE sync_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_pushed_id INTEGER NOT NULL DEFAULT 0,
    last_pushed_at TEXT,
    last_online_at TEXT
);
INSERT INTO sync_state (id) VALUES (1);
```

The hosted Postgres has the **same outbox table** for symmetric replay if you ever need to rebuild local from hosted.

### 8.4 Topology

```
┌─────────────────────────────────────────┐
│  Renzo's machine                        │
│  ─────────────────────────────────────  │
│  React SPA + Local Flask                │
│        │                                │
│        ▼                                │
│  SQLite (canonical) + sync_outbox       │
│        │                                │
│        ▼                                │
│  Background push runner (thread)        │
│        │                                │
└────────┼────────────────────────────────┘
         │  POST /api/sync/push  (debounced 500 ms)
         │  Retries with exponential backoff on failure
         ▼
┌─────────────────────────────────────────┐
│  Hosted Flask + Postgres                │
│  ─────────────────────────────────────  │
│  /api/sync/push   → applies events      │
│  /api/*           → read-only API for   │
│                     owner dashboard     │
│                                         │
│  Postgres (mirror)                      │
└─────────────────────────────────────────┘
```

### 8.5 The push pipeline (Python)

Each mutation in the local Flask service layer writes data + outbox row in one transaction:

```python
def create_delivery(payload: DeliveryCreate) -> Delivery:
    with db.session.begin():
        delivery = Delivery(**payload.model_dump())
        db.session.add(delivery)
        db.session.flush()

        # Outbox append in same transaction
        db.session.add(SyncOutbox(
            table_name='deliveries',
            record_id=str(delivery.id),
            operation='insert',
            payload=json.dumps(delivery_to_dict(delivery)),
        ))

        # Audit log (existing convention, unchanged)
        audit_service.log('deliveries', delivery.id, 'INSERT', snapshot=...)

    push_runner.schedule()   # debounced
    return delivery
```

The **push runner** is a background thread:
1. Every 500 ms (debounced from the last mutation), checks `sync_outbox` for `synced_at IS NULL`
2. Batches up to ~100 events ordered by `id ASC`
3. POSTs to hosted `/api/sync/push` with HMAC-signed body
4. Hosted applies each event in order and returns `{accepted: [outbox.id, ...]}`
5. Local marks accepted rows `synced_at = NOW()`, advances `sync_state.last_pushed_id`
6. On network error: exponential backoff (1 s → 2 s → 4 s → ... → 5 min max), retries forever; outbox keeps growing

### 8.6 The hosted receiver (Python)

```python
@bp_sync.post('/api/sync/push')
@require_push_hmac
def receive_push():
    events = request.json['events']
    accepted = []
    for ev in events:
        with db.session.begin():
            apply_event(ev)
            accepted.append(ev['id'])
    return {'accepted': accepted}

def apply_event(ev):
    table, op, payload, rec_id = ev['table_name'], ev['operation'], ev['payload'], ev['record_id']
    if op == 'insert':
        # ON CONFLICT to make replays idempotent
        db.execute(upsert_sql(table, payload), payload)
    elif op == 'update':
        db.execute(update_sql(table, payload), {**payload, 'id': rec_id})
    elif op == 'delete':
        db.execute(f"DELETE FROM {table} WHERE id = :id", {'id': rec_id})
```

The hosted endpoint trusts the local — same schema, same row IDs. No conflict resolution because by definition the local is the source of truth. **Idempotent on replay** via `ON CONFLICT` upserts, so retries are safe.

### 8.7 Failure modes and recovery

| Scenario | Behavior | Recovery |
|---|---|---|
| Network drops mid-push | Local outbox keeps growing; push retries with backoff | Drains automatically when network returns |
| Hosted DB unreachable for hours | Same | Same |
| Hosted DB corrupted/lost | Local unaffected | Full re-push from local outbox (run a one-shot `python -m sync.full_resync`) |
| Local SQLite file lost (laptop dies) | Catastrophic, mitigated by mirror | Reverse-pull from hosted; lose only unpushed tail (typically <1 minute of work) |
| Auth tokens expire on hosted | Push fails 401, retries forever | User reauthenticates locally; resumes draining |
| Owner dashboard sees stale data | By design — eventual consistency | Polls every ~5 s; sees fresh data after next push |

### 8.8 Local-machine backup (laptop = single point of failure)

Three redundancies (any two suffice):

1. **Hosted DB as continuous backup** (free, automatic via the push pipeline)
2. **Local SQLite file in iCloud Drive / Dropbox** (free, OS-level file sync, point-in-time restore)
3. **Weekly cron dump to external drive or S3** (optional, scripted)

Combined RTO: <1 hour after a laptop failure. RPO: <1 minute (the unpushed outbox tail).

### 8.9 Trigger logic stays in Python (unchanged from original plan)

All Supabase triggers move into Python service modules:

- `services/batch_state.py` — `fn_process_blackwood_usage` equivalent. Recomputes `batches.status` and `batches.current_weight` from rc_out rows after every mutation. Same logic, runs in Python, works identically on SQLite and Postgres.
- `services/audit.py` — `set_audit_comment` becomes an explicit argument, not a session variable. Audit log entries are written directly by the service.
- `services/profile_bootstrap.py` — replaces `handle_new_user` and `handle_invite_creation`. On hosted, only used for first-time owner account creation under the deferred email+password scheme.

These services run inside the same transaction as the outbox writes, so derived state (status changes, weight recalcs) automatically flows to the mirror via the outbox.

### 8.10 What the original Section 8 covered that's now gone

For historical reference, the original (now-replaced) Section 8 included:
- Outbox with `origin_device` + per-device sequence
- Bidirectional pull + push protocol
- Per-field LWW with `last_modified_at` columns
- MVCC + manual conflict resolution UI for notes/remarks
- Tombstones with multi-device acknowledgment tracking
- Hybrid Logical Clock discussion
- CRDT vs OT analysis for inventory data

All of that is **engineering knowledge worth retaining** but **not needed for v1** under the single-writer architecture. If Blackwood ever grows to support multi-writer at the plant (e.g. Ivy and Pretchel also writing directly), revisit those concepts. Until then, keep it simple.

---

## 9. Module-by-Module Port Plan

### Dashboard
- Port `D6Prefs` → Pydantic model in `schemas/dashboard_prefs.py`
- Port `loadDashboardPrefs/saveDashboardPrefs` → `GET/PUT /api/dashboard/prefs`
- Port four adapters → `app/adapters/charcoal_*.py`, each implementing `fetch(session) -> PydanticModel`
- React side: replace `loadDashboardPrefs` server action with TanStack Query against the new endpoints

### RC IN
- Port 15 server actions to Flask routes under `/api/rc-in/*`
- Move the audit-comment-via-session-variable pattern to explicit comment arguments
- Reimplement cost scrubbing in `services/cost_scrub.py`; apply on every read endpoint
- Port `bulkUpdateDeliveries` audit comment chain — the service writes the audit log, gets back the audit log id, then writes the audit comment in the same transaction

### RC OUT
- Same shape as RC IN; thinner audit surface
- The computed columns `rc_out_avg_price` / `rc_out_avg_wtd_value` move into the Pydantic schema's `@computed_field`s, calling out to a `services/rc_out_pricing.py` helper

### Blocking
- `view_blocking_grid` → recreate as a SQL view (or a SQLAlchemy view) and select from it
- Or: rewrite as an explicit aggregation function in `services/blocking.py` (cleaner across SQLite/Postgres)
- The slide-over detail panel reads from the same `fetchBlockingDetail` shape — port as `/api/blocking/detail/<batch_code>/<batch_id>`

### Admin
- All four functions become role-gated endpoints
- The Supabase magic-link invite system gets replaced: in Flask, "invite" just adds a row to `user_invites` and emails the user a link to `/login` (with their pre-filled email if desired). On OAuth, the bootstrap service picks up the invite.

### Notifications
- Pull endpoint: `GET /api/notifications?cursor=...`
- Unread count: `GET /api/notifications/unread-count`
- Mark read: `PATCH /api/notifications/<id>/read`
- Mark all read, archive: same shape
- WS push: emit `notification.created` to `user:<id>` room

### Settings + Edit/Discussion
- `app/(app)/settings/` is essentially a duplicate of admin's `updateUserRole`; can share the service
- `app/(app)/edit/[auditLogId]/` becomes `/api/audit-logs/<id>` and a React route at `/edit/:id`

### Auth + Middleware
- Replace `middleware.ts` with Flask `@before_request` hook on each blueprint requiring auth
- Replace Supabase Auth with Flask-Login + Authlib
- Cookie names: keep `dev_mock_role` (server reads it via `request.cookies.get`)

---

## 9b. AI Ingestion Agent

A new first-class component introduced by the 2026-05-26 architectural pivot. The agent parses daily Excel reports from Gmail (`Work/ICTC Daily` label), proposes structured inserts into the local Flask app, and lets Renzo review/approve via a queue UI before they commit.

**This replaces ~45 minutes/day of manual Excel copy-paste** with ~5 minutes of review.

The agent handles 9 distinct daily report types (Daily Production, Waste, RC Deliveries, RC Movement, Flecon Bagged, Bagged Powder, QC reports for 3X50/6X50, Daily Maintenance) — see `AI_INGESTION_AGENT.md` for the full design including per-report extractors, validation rules, the `pending_review` table schema, the review UI, the Claude API fallback for ambiguous rows, and cost estimates (~$30/month operating).

Builds in **Phase 8** of the roadmap (Section 10). Approximately 5–7 working days.

**See:** `AI_INGESTION_AGENT.md` at project root.

---

## 10. Phased Migration Roadmap (Revised 2026-05-26)

The roadmap is re-phased for the single-writer architecture. Sync becomes trivial; the AI ingestion agent becomes a first-class phase. Total estimate drops from ~35–45 days to ~25–35 days.

### Phase 0 — Bootstrap (2–3 days)
- Create `blackwood_flask/` directory
- Set up Flask app factory, blueprints, SQLAlchemy, Alembic
- Set up Vite + React scaffold in `frontend/`, copy current `components/ui/` and `components/widgets/`
- Port `tailwind.config`, `globals.css`, theme provider
- Wire SQLAlchemy to a local `blackwood.db` SQLite file
- **Definition of done:** `python launch.py` starts Flask + opens browser to `localhost:5000` showing a Vite-rendered "hello"

### Phase 1 — Schema & Migrations (3–4 days)
- **Introspect the live Supabase schema first.** Run `supabase db dump --schema-only --linked > live_schema.sql` to capture the full live schema including `user_dashboard_prefs`, `view_blocking_grid`, `view_rc_movement`, and any other drifted objects
- Port every captured object to Alembic migrations (forward-only chain starting at `0001_initial.sql`)
- Add the two new sync tables — `sync_outbox`, `sync_state` (per Section 8.3 — minimal, no `sync_version` / `origin_device` / etc.)
- Define all SQLAlchemy models
- Write `scripts/port_supabase_to_sqlite.py` — one-shot data export from current Supabase to the new local SQLite (preserves all existing rows; auto-populates outbox with INSERT events for replay against the eventual hosted DB)
- **Definition of done:** `alembic upgrade head` works against SQLite; existing Blackwood data round-trips locally; outbox has the full backfill ready to push

### Phase 2 — Local-app auth (single-user, 0.5 day)
- No OAuth needed — local app has one user (Renzo)
- A simple machine-local lock file or environment variable identifies the operator user for audit-log attribution
- **Definition of done:** all audit log entries attribute to a single hard-coded "Renzo" user; no login screen

### Phase 3 — Core Read Endpoints + Static Adapters (3–4 days)
- Port the four dashboard adapters as **static implementations first** (mirror `lib/widgets/mock-data.ts`)
- Endpoints: `/api/dashboard/kpi|chart|warehouse|special-chart|prefs`
- React side: hook up TanStack Query, render the dashboard against the static endpoints
- **Definition of done:** the dashboard renders identically to the current one, served entirely by Flask

### Phase 4 — Live Adapters + RC IN Read Path (4–5 days)
- Convert adapters to live SQLAlchemy queries
- Port the RC IN read path: paged list, filters, audit log fetch, history dialog
- React side: replace the existing inventory page data fetching with API calls
- **Definition of done:** RC IN dense table renders against local Flask with all filters working

### Phase 5 — Writes + Audit + Trigger Replacement (5–7 days)
- Implement `services/batch_state.py`, `services/audit.py`
- Port `submitBulkDeliveries`, `bulkUpdateDeliveries`, `bulkDeleteDeliveries`, `addAuditComment`, the resolve workflow
- Every mutation writes to `sync_outbox` in the same transaction (Section 8.5)
- **Definition of done:** a bulk paste of 50 deliveries from Excel writes correctly, updates batches, produces audit logs, and outbox rows accumulate

### Phase 6 — RC OUT + Blocking + Movement (3–4 days)
- Port RC OUT, Blocking, RC Movement read+write endpoints
- Recreate the SQL views (`view_blocking_grid`, `view_rc_movement`, `view_rc_in_master`) as Alembic-tracked views
- **Definition of done:** the inventory page (all four tabs) is fully functional against local Flask

### Phase 7 — Hosted Flask + Postgres + Push Pipeline (3–4 days)
- Deploy the same Flask codebase to Fly.io / Railway with managed Postgres
- Stub auth on hosted: single `OWNER_DASHBOARD_PASSWORD` env var, single shared session
- Implement `/api/sync/push` endpoint on hosted (Section 8.6)
- Implement `sync/runner.py` background thread on local Flask (Section 8.5)
- Run the backfill: drain the historical outbox to populate hosted mirror
- **Definition of done:** local mutations replicate to hosted within ~1 s when online; hosted dashboard accessible at a public URL with the shared password

### Phase 8 — AI Ingestion Agent (5–7 days)
See `AI_INGESTION_AGENT.md` for the full design.

- Gmail API integration — poll `Work/ICTC Daily` label every N minutes
- Per-report-type extraction templates (Daily Production, RC IN, FB, etc.)
- Claude API integration with structured outputs
- `pending_review` table + review UI in local Flask
- One-click approve → commits to canonical tables → outbox → pushes to hosted
- **Definition of done:** a Daily Production Report email arrives → agent parses → review panel shows extracted rows → Renzo approves → data lands in Movement tab within 30 s

### Phase 9 — Packaging (3–4 days)
- `python launch.py` script for personal terminal use
- `pywebview` shell + PyInstaller spec for distribution
- First-run wizard: create local DB, configure hosted URL + push HMAC secret, set Gmail OAuth
- **Definition of done:** double-click a `.dmg` on a clean machine; opens; works offline; syncs to hosted when configured; AI agent ingests emails

### Phase 10 — Polish & Owner Dashboard (ongoing)
- Owner dashboard polish (Joseph's view): simplified KPI widgets, mobile responsive, share by URL
- Per-owner accounts (replace stub password) when needed
- Performance testing
- Documentation

**Revised total estimate:** ~25–35 working days. The schema port (Phase 1) and the AI ingestion agent (Phase 8) are the longest stretches. The sync engine — formerly Phase 9 at 5–7 days — is now a 3–4 day Phase 7 because it's a single-direction push with no conflict resolution.

---

## 11. Critical Risks & Trade-offs

### Risks
1. **Sync engine correctness** is the highest-risk component. A bug here corrupts data silently. Mitigation: extensive property-based tests with `hypothesis`; replay test harness that simulates random network partitions and verifies eventual consistency.
2. **Trigger logic in Python is slower than in Postgres.** The `fn_process_blackwood_usage` trigger is called on every rc_out write; moving it to Python adds a round-trip. For 1–10 rc_out writes per minute (current usage), this is irrelevant. If usage spikes, reintroduce a Postgres trigger that calls a function maintained in lockstep with the Python service.
3. **JSONB feature parity.** SQLite has JSON1 but lacks `->>'key'` in older versions. Use SQLAlchemy's `JSON` type and access via dict semantics, not raw SQL. Test the lab_results path on both backends.
4. **Auth cookies in packaged desktop app.** If the app runs as `localhost:5000` in a `pywebview` window, cookies work normally — but if the user opens the app on a phone and tries to connect to the desktop's Flask, CORS and cookie SameSite matter. Decision: the packaged app is single-user, single-device. Mobile access goes through the remote Flask, not the local one.
5. **Dense table on mobile.** The bulk input grid and master table are keyboard-first. Mobile usage will need rework — but the existing TIMELINE.md Phase 4 already plans for this.

### Trade-offs

**Frontend approach trade-offs**
- **Option A (Jinja + HTMX rebuild):** Smaller bundle, simpler stack, faster onboarding for new devs. But the dense tables (cell selection, paste, keyboard nav, virtual scroll) take weeks to rebuild and lose fidelity. **Verdict: not recommended unless the user explicitly accepts a slower table UX.**
- **Option B (Keep React, Flask serves SPA):** Reuses 80% of current code. Frontend dev workflow continues with Vite. Two-language codebase. **Recommended.**
- **Option C (Jinja + React islands):** Compromise. Inventory pages stay React; dashboard could go either way. Adds Jinja templating complexity for marginal benefit. **Not recommended unless there's a specific reason to ditch the SPA.**

**Sync approach trade-offs**
- **Hand-rolled outbox + LWW:** Full control, fits the existing audit philosophy. Bug surface non-trivial.
- **PowerSync:** Drop-in Postgres-to-SQLite. Adds vendor lock-in; doesn't naturally fit the audit/notification model.
- **ElectricSQL:** Strong story but requires their custom protocol and ops.
- **Verdict: hand-rolled.** The audit log is already an outbox; we're just adding push/pull endpoints around it.

**Packaging approach trade-offs**
- **`pywebview`:** Smallest binary, mature, works on macOS/Windows/Linux. Recommended.
- **`Tauri`:** Smaller still, web view is the OS native one. Requires Rust toolchain — adds setup friction.
- **`Electron`:** Heaviest. No reason to use it when `pywebview` exists.
- **Pure browser (`launch.py` opens default browser):** Zero packaging work; user runs Python. Best for the user's own use case if they're comfortable with a terminal. Decision: ship both — a `launch.py` for dev/personal use, and a `pywebview` build for distribution.

---

## 12. Open Decisions for the Next Session

Most of the original open decisions were resolved during the 2026-05-26 pivot conversation. Only a few remain.

### Resolved (2026-05-26)

| # | Decision | Resolution |
|---|---|---|
| 1 | Frontend approach | **Option B** — keep React + Vite. Confirmed. |
| 2 | Packaging target | `python launch.py` for personal use; `pywebview` for distribution. Confirmed. |
| 4 | Auth providers | **Local app:** none (single user on local machine). **Hosted dashboard:** stub with single `OWNER_DASHBOARD_PASSWORD` env var; replace with email+password later. |
| 5 | Multi-user vs single-user | **Single-writer** (Renzo only). Owners are read-only. Auth model simplified. |
| 6 | Conflict resolution UX | **Eliminated** — single writer means no conflicts. |
| 7 | Sync trigger frequency | Push debounced 500 ms after every mutation; backoff on failure. Owner dashboard polls every ~5 s. |

### Still open

1. **Remote backend deployment.** Recommended: deploy hosted Flask + managed Postgres to **Fly.io** (cheap, single-region, simple). Alternatives: Railway, Render, keep Supabase. Decide before Phase 7 (hosted deploy).
2. **Audit log retention.** Recommended: keep audit logs forever, purge soft-deletes after 90 days. Storage cost is negligible.
3. **Migration from existing Supabase data.** Recommended: write a one-shot Python script that pulls all data from Supabase via the existing client, writes to the new local SQLite (and from there pushes to hosted via the standard pipeline). The Supabase project then becomes read-only history. Decide whether to keep the Supabase project archived or shut it down.
4. **Cutover plan.** With the simplified architecture, parallel-run isn't really needed. Recommendation: build local Flask + ingestion agent in parallel with current Next.js stack; once it's working with your real daily data flow, retire the Next.js side. Confirm.
5. **AI ingestion agent provider.** Recommended: **Claude API** (Sonnet for parsing; structured outputs via tool calling). Alternatives: GPT-4. Decide before Phase 4.
6. **AI ingestion review threshold.** When should the agent auto-commit vs require Renzo's review? Recommended: always require review in v1, auto-commit only after a track record of zero corrections per report type. Confirm.

---

## 13. Quick-Start for the Next Session

If the next agent picks up this work, here's the **minimum reading list**:

1. This document, top to bottom (you're reading it).
2. `CLAUDE.md` (project root) — operating norms, especially the "Platform Vocabulary" and "Layer separation rule" sections.
3. `TIMELINE.md` (project root) — current sprint and recent completions; the Flask port becomes the next phase.
4. `components/widgets/CONTEXT.md` — the widget registry pattern; this is the core abstraction.
5. `app/(app)/inventory/rc-in/CONTEXT.md` — the highest-complexity module.
6. `lib/widgets/adapters/tenant-config.ts` — see how charcoal-specific config is isolated.

Then start at **Phase 0 in Section 10** of this document.

### First Concrete Action
```bash
mkdir blackwood_flask
cd blackwood_flask
python -m venv .venv && source .venv/bin/activate
pip install flask sqlalchemy alembic pydantic authlib flask-login flask-socketio
alembic init alembic
# scaffold app/ as described in Section 7.2
```

Then port the first Supabase migration to Alembic to verify the schema round-trips. Everything else flows from that.

---

## 14. Appendix — Glossary

| Term | Meaning |
|---|---|
| **Port** (hexagonal) | The typed interface a widget consumes — e.g. `KPIData[]`, `ChartConfig`. Synonym for Grafana's "data frame." |
| **Adapter** | A pure function that fills a port from a specific data source. `charcoal_kpi.fetch(session)` is an adapter. |
| **Platform layer** | Code under `components/widgets/`, `components/dashboard/`, `lib/dashboard/`. Zero tenant knowledge. |
| **Tenant layer** | Code under `lib/widgets/adapters/`, `app/(app)/inventory/`, `lib/widgets/mock-data.ts`. Charcoal-specific. |
| **D6Prefs** | The shape of dashboard preferences saved per user. Stored in `user_dashboard_prefs.prefs` JSONB and localStorage `bw_v1`. |
| **Outbox** | Local append-only log of mutations awaiting sync. Section 8.4. |
| **Tombstone** | A row marked `deleted_at` instead of physically removed, so deletes can replicate. Section 8.7. |
| **LWW** | Last-write-wins. Conflict resolution where the most recent `last_modified_at` wins per field. Section 8.6. |
| **Origin device** | The UUID of the device that authored a row's most recent edit. Used for sequence-based pulls. |
| **Sync sequence** | Per-device monotonically increasing integer. Replaces clock-based ordering. Section 8.5. |

---

*End of document. Next session: start at Section 13.*
