# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Platform Philosophy

**Blackwood is a general-purpose modular BI platform, not a charcoal plant tool.** Charcoal plant operations (RC IN, RC OUT, Blocking) are the first tenant on the platform — a real-world proof of concept. The platform itself must remain genuinely open to any inventory or operational domain without a rewrite.

**Inspiration: Grafana's data source model.** Grafana itself does not store data. It acts as a visualization and interaction layer, pulling information from selected data sources. Every data source emits a normalized data frame. Visualizations consume frames, never raw queries. Blackwood follows the same model: widgets consume normalized, data-agnostic interfaces (`ChartConfig`, `KPIData`, etc.) — never raw Supabase queries.

**Architecture: Hexagonal (Ports & Adapters).** The widget is the application core. The "port" is the typed interface it declares (`ChartConfig`, `KPIData`, `ScatterPoint[]`). The "adapter" is whoever fills it — today a static mock adapter, tomorrow a live Supabase adapter. The widget is permanently isolated from the adapter. This vocabulary is canonical throughout the codebase.

**Layer separation rule:** If code lives in `components/widgets/` or `components/dashboard/`, it is **platform code** — zero tenant knowledge allowed. If it lives in `app/(app)/inventory/`, `lib/widgets/adapters/`, or `lib/widgets/mock-data.ts`, it is **tenant code** — domain-specific is expected and correct. Never add domain/tenant knowledge to platform-layer components.

**Two coexisting UX paradigms:**
- **Dashboard (`/`):** Composable widget grid — drag/resize/add, like a Bloomberg terminal. High information density, visual-first, no page reloads. **Platform layer.**
- **Inventory pages (`/inventory/...`):** Industrial Spreadsheet — dense, keyboard-navigable tables that feel like Excel but enforce data integrity underneath. These stay as dedicated pages forever (too specialized for generic widgets). **Tenant/domain layer.**

## Platform Vocabulary

| Term | Meaning |
|------|---------|
| **Platform layer** | Widgets, dashboard shell, widget registry — source-agnostic by design, domain-neutral |
| **Domain module** | RC IN, RC OUT, Blocking — charcoal-specific. The first tenant on the platform. |
| **Tenant** | An organization/domain using the platform. Blackwood charcoal is Tenant #1. Adapters, domain modules, and business logic are always tenant-specific. |
| **Data-agnostic interface** | The typed contract a widget accepts: `ChartConfig`, `KPIData`, `ScatterPoint[]`, etc. Equivalent to Grafana's "data frame." |
| **Adapter** | Pure function — transforms any data source's raw output into the widget's data-agnostic interface. Lives in `lib/widgets/adapters/`. |
| **Static adapter** | `lib/widgets/mock-data.ts` — a hardcoded adapter used for development, demos, and fallback. Not the charcoal data; a charcoal-shaped static implementation of the platform's widget interfaces. |
| **Live adapter** | Future: `lib/widgets/adapters/charcoal-chart.ts`, etc. — fetches from Supabase and transforms to widget interfaces. |

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
- **Supabase** (PostgreSQL) — client in `lib/supabase.ts`, env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
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

**Two-layer data flow:**
- **Platform layer (widgets):** Widget → data-agnostic interface (`ChartConfig`, `KPIData`) → adapter fills interface → widget renders. Widget has zero knowledge of Supabase, charcoal, or any domain.
- **Domain layer (inventory modules):** User Action → Client Component → Server Action → Supabase → `revalidatePath()` → Re-render. This is the tenant-specific CRUD layer.

## Database Schema (Supabase)

Auto-generated TypeScript types live in `types/supabase.ts` — **never hand-edit this file**, regenerate with `/supabase` workflow or:
```bash
supabase gen types typescript --linked > types/supabase.ts
```

**Tables:**
- **`batches`** — `id`, `batch_code` (unique), `location_ref`, `status` (`batch_status` enum: STORED/IN-USE/CLOSED/FEED), `avg_cost`, `current_weight`, `quality_stats` (JSONB)
- **`deliveries`** — `id`, `transaction_date`, `supplier`, `batch_code` (FK→batches), `block_loc`, `truck_plate`, `sacks`, `weight_kg`, `cost_basis`, `remarks`, `lab_results` (JSONB: mc/ash/bd_astm/bd_jis/grit/vm/fc)
- **`usage`** — `id`, `batch_id` (FK→batches), `destination`, `transaction_date`, `weight_kg`, `snapshot_location`, `snapshot_price`
- **`profiles`** — `id` (FK→auth.users), `email`, `display_name`, `avatar_url`, `role`, `status` (`'active'` | `'disabled'` | `'pending'`), `created_at`, `updated_at`
- **`audit_logs`** — `id`, `table_name`, `record_id`, `operation`, `diff` (JSONB), `snapshot` (JSONB), `comment`, `performed_by`, resolve fields
- **`audit_comments`** — `id`, `audit_log_id` (FK→audit_logs), `body`, `user_id`, `resolved`

**Views:** `view_rc_in_master`
**Functions:** `set_audit_comment(comment text)`
**Enums:** `batch_status` = `STORED | IN-USE | CLOSED | FEED | SUNDRYING | SUNDRIED`

Batch upsert strategy: upsert by `batch_code` to prevent duplicates.

**Additional Tables:**
- **`rc_out`** — `id`, `transaction_date`, `batch_id` (FK→batches), `production_batch`, `destination`, `weight_kg`, `block_loc`, `remarks`, `created_at`. Computed columns: `rc_out_avg_price`, `rc_out_avg_wtd_value`
- **`notifications`** — `id`, `user_id`, `type` (`notification_type` enum), `title`, `body`, `source_user_id`, `metadata` (JSONB), `read`, `read_at`, `archived`, `created_at`
- **`notification_subscriptions`** — `id`, `user_id`, `audit_log_id` (FK→audit_logs), `created_at`
- **`user_invites`** — `email` (PK), `role`, `invited_by` (FK→profiles), `created_at`. Whitelist for invite-only access.

**Additional Functions:** `_insert_notification(p_user_id, p_title, p_body, p_type, p_source_user_id, p_metadata)`, `is_admin(user_id)`
**Additional Enums:** `notification_type` = `resolve_request | resolve_approved | resolve_denied | delivery_created | delivery_edited | delivery_deleted | remarks_added | audit_comment_reply`

**Triggers:**
- **`handle_new_user()`** — After INSERT on `auth.users`: creates profile from `user_invites` whitelist (role + status='active') or with default role + status='pending'
- **`handle_invite_creation()`** — After INSERT on `user_invites`: activates matching pending profiles

**Dev Role Override:** Privileged users (Owner/Admin/Dev) can impersonate any role via localStorage (`dev_mock_role`) + cookie. Server-side `getUserRole()` in `lib/auth.ts` reads the cookie. UI controlled via navbar Shield icon dropdown.

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
- `app/(app)/CONTEXT.md` — Dashboard (modular widget grid, localStorage prefs)
- `app/(app)/inventory/rc-in/CONTEXT.md` — RC IN (Delivery Master Log)
- `app/(app)/inventory/rc-out/CONTEXT.md` — RC OUT (Inventory Usage)
- `app/(app)/inventory/blocking/CONTEXT.md` — Blocking (Warehouse Grid Visualization)
- `app/(app)/admin/CONTEXT.md` — Admin Panel (User Management)
- `components/widgets/CONTEXT.md` — Widget System (registry, size tiers, how to add a widget)
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

## Widget System

Blackwood's dashboard at `/` is a composable grid of widgets. Each widget is a self-contained display component — it never imports from Supabase directly. Data flows in via a **static adapter** (`lib/widgets/mock-data.ts`) today — a charcoal-shaped static implementation of the platform's data-agnostic widget interfaces. Real **live adapters** (`lib/widgets/adapters/`) will drop in alongside without any changes to widgets.

### Widget Interface Contract

```typescript
// Every widget component accepts these props at minimum:
interface WidgetProps<TSettings> {
  instanceId: string
  settings: TSettings
  onSettingsChange: (partial: Partial<TSettings>) => void
}

// Registry entry (components/widgets/index.ts):
interface WidgetDefinition {
  type: string
  displayName: string
  description: string
  defaultSize: { w: number; h: number; minW?: number; minH?: number }
  createDefaultSettings: () => unknown
  component: React.ComponentType<any>
}
```

### Current Widget Catalog

| Widget | Component | Description |
|--------|-----------|-------------|
| `chart` | `ChartWidget` | Multi-series price/quality chart with comparison slices, X/Y builder, font scale |
| `kpi-strip` | `KPIStripWidget` | Responsive KPI chips — adapts layout by size tier |
| `quality-scatter` | `QualityScatterWidget` | SVG scatter (PHP/KG vs MC/ASH) |
| `warehouse-occupancy` | `WarehouseOccupancyWidget` | WHSE A/B/C/D occupancy bars |

### How to Add a New Widget Type

1. Create `components/widgets/<name>/<Name>Widget.tsx` — export a named React component
2. Call `useWidgetSize()` from `@/components/widgets/chart/utils` for responsive behavior
3. Add an entry to `WIDGET_REGISTRY` in `components/widgets/index.ts`
4. Widget receives no required props beyond what `WidgetShell` provides via `WidgetSizeContext`

### Widget Size Tier System

`WidgetShell` measures the content area via `ResizeObserver` and provides `WidgetSize` via `WidgetSizeContext`. Tiers: `xs` (<160px) | `sm` (160–280px) | `md` (280–440px) | `lg` (440–640px) | `xl` (>640px). Apply the same breakpoints to height for `heightTier`.

### Dashboard Shell

| Component | File | Responsibility |
|-----------|------|----------------|
| `DashboardGrid` | `components/dashboard/DashboardGrid.tsx` | Layout state, localStorage prefs, edit mode, ReactGridLayout |
| `WidgetShell` | `components/dashboard/WidgetShell.tsx` | Generic frame: title bar, collapse, remove, ResizeObserver |
| `WidgetPicker` | `components/dashboard/WidgetPicker.tsx` | "Add widget" modal — reads from WIDGET_REGISTRY |

Layout and per-widget settings persist to localStorage key `bw_d6_prefs`. CSS imports for ReactGridLayout (`react-grid-layout/css/styles.css`, `react-resizable/css/styles.css`) live in `DashboardGrid.tsx`.

## Adapter Layer

Adapters translate any data source's raw output into the data-agnostic interface a widget declares. They are the only place where tenant/domain knowledge meets the platform layer.

**Current adapter:**
- `lib/widgets/mock-data.ts` — static adapter. Exports `CHARCOAL_UNIVERSAL_CONFIG`, `LEDGER`, `USAGE_LEDGER`, etc. These are charcoal-shaped implementations of platform interfaces — not the "real" data, but structurally identical to what a live adapter would produce.

**Future adapters (to be built per user approval):**
- `lib/widgets/adapters/charcoal-chart.ts` — queries Supabase views and transforms to `ChartConfig`
- `lib/widgets/adapters/charcoal-kpi.ts` — queries KPI aggregates and transforms to `KPIData[]`

**Rules:**
- Widgets consume normalized interfaces — never raw data or Supabase queries
- Adapters are pure functions — no React, no rendering logic, no knowledge of which widget will consume their output
- When a live adapter replaces a static adapter, the widget requires zero changes

## Blocking Module

The Blocking tab is the **primary tab** in the Inventory page — a warehouse grid visualization of 220 block locations across 4 warehouses (A/B/C/D). Uses `view_blocking_grid` SQL view for pre-computed data, CSS Grid heatmap cells, slide-over detail panel with delivery/usage history. See `app/(app)/inventory/blocking/CONTEXT.md` for full architecture. Key patterns: lazy-loaded via tab context (same as RC OUT), role-gated cost data, heatmap coloring by balance percentage, spotlight status filter with dim/glow effect.

## Agent Model

When spawning subagents via the `Task` tool, always use `model: 'opus'` (maps to the latest Opus, currently Opus 4.8). All project subagent definitions in `.claude/agents/` are pinned to `model: opus`. Do not default to sonnet or haiku for implementation work in this project.

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
