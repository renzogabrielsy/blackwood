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
- **`profiles`** — `id` (FK→auth.users), `email`, `display_name`, `avatar_url`, `role`
- **`audit_logs`** — `id`, `table_name`, `record_id`, `operation`, `diff` (JSONB), `snapshot` (JSONB), `comment`, `performed_by`, resolve fields
- **`audit_comments`** — `id`, `audit_log_id` (FK→audit_logs), `body`, `user_id`, `resolved`

**Views:** `view_rc_in_master`
**Functions:** `set_audit_comment(comment text)`
**Enums:** `batch_status` = `STORED | IN-USE | CLOSED | FEED`

Batch upsert strategy: upsert by `batch_code` to prevent duplicates.

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

## Git Workflow

- **`main`** — protected, production-ready
- **`dev`** — staging/integration branch
- **`feat/*`** — feature branches, branched from `dev`
- Use **conventional commits**: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
