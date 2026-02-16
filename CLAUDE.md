# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Blackwood** is an industrial inventory management system for a charcoal processing plant. It follows a "Separate Inputs, Unified State" philosophy — each module (RC IN, RC OUT, PRODUCTION, etc.) captures data independently, while the database unifies state via triggers and views.

The UX goal is an **Industrial Spreadsheet**: dense, keyboard-navigable tables that feel like Excel but enforce data integrity underneath.

## Skills

This project uses the **`nextstack-design`** skill for UI and design guidance. When planning frontend features, designing UI components, or reviewing code quality, Claude will reference this skill for best practices on:
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
**Enums:** `batch_status` = `STORED | IN-USE | CLOSED | FEED`

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
- `app/(app)/inventory/rc-in/CONTEXT.md` — RC IN (Delivery Master Log)
- `app/(app)/inventory/rc-out/CONTEXT.md` — RC OUT (Inventory Usage)
- `app/(app)/admin/CONTEXT.md` — Admin Panel (User Management)
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

## Git Workflow

- **`main`** — protected, production-ready
- **`dev`** — staging/integration branch
- **`feat/*`** — feature branches, branched from `dev`
- Use **conventional commits**: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
