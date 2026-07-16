# Blackwood

General-purpose modular business intelligence platform built around a composable widget dashboard. Charcoal plant operations (RC IN, RC OUT, Blocking) ship as the first tenant — a real-world proof of concept. The platform is designed to host any inventory or operational domain without a rewrite.

## Architecture Philosophy

**Ports & Adapters (Hexagonal Architecture).** Widgets declare typed data contracts ("ports") and are permanently isolated from whoever fills them. An adapter — today a static mock, tomorrow a live Supabase query — transforms raw data into the widget's data-agnostic interface. The widget sees no difference between sources.

**Layer separation:**
- **Platform layer** (`components/widgets/`, `components/dashboard/`) — source-agnostic, domain-neutral. Zero tenant knowledge allowed.
- **Domain layer** (`app/(app)/inventory/`, `lib/widgets/adapters/`) — tenant-specific. Domain knowledge is expected and correct here.

**Inspiration:** Grafana's data source model — the visualization layer consumes normalized data frames, never raw queries. Every widget interface (`ChartConfig`, `KPIData`, etc.) is Blackwood's equivalent of a data frame.

## Tech Stack

- **Next.js 16** (App Router) with **React 19** and **TypeScript** (strict mode)
- **Supabase** (PostgreSQL) with Row Level Security
- **Tailwind CSS v4** with **Shadcn UI** (new-york style, zinc base)
- **TanStack Table** + TanStack Virtual for virtualized data grids
- **ReactGridLayout** for the composable widget dashboard
- **Recharts** for charting in widgets
- **date-fns** for date formatting, **cmdk** for command menus
- **next-themes** for dark mode

## Modules

### Dashboard (`/`)

Composable widget grid — drag, resize, add, like a Bloomberg terminal. Widgets are source-agnostic display components; data flows in via adapters. Current widgets:

- **ChartWidget** — Multi-series price/quality chart with comparison slices and X/Y builder
- **KPIStripWidget** — Responsive KPI chips adapting layout by size tier
- **QualityScatterWidget** — SVG scatter plot (PHP/KG vs MC/ASH)
- **WarehouseOccupancyWidget** — WHSE A/B/C/D occupancy bars

### Inventory (`/inventory`) — Charcoal Tenant

Domain-specific modules for charcoal plant operations. Industrial Spreadsheet UX — dense, keyboard-navigable tables that feel like Excel.

- **Deliveries (RC IN)** — Inbound delivery logging with bulk grid input, quality tracking (lab results as JSONB), audit trail with resolve workflow
- **Usage (RC OUT)** — Outbound consumption tracking, batch depletion, DB-computed pricing columns
- **Blocking** — Warehouse grid visualization of 220 block locations across 4 warehouses (A/B/C/D) with heatmap coloring, spotlight filters, and slide-over detail panel

### Admin (`/admin`)

Platform-level infrastructure — domain-neutral access control for all tenants.

- User management — invite, revoke, reactivate
- Role-based access — Owner, Admin, Dev, Accounting, Production
- Supabase Auth integration with invite-only whitelist (`user_invites` table)

### Notifications

- Realtime notification bell (polling-based)
- Audit trail subscriptions
- Resolve request workflow notifications

## Data Flow

**Platform layer (widgets):**

    Adapter → Data-Agnostic Interface (ChartConfig, KPIData, etc.) → Widget → Render

**Domain layer (inventory modules):**

    User Action → Client Component → Server Action → Supabase → revalidatePath() → Re-render

DB triggers derive batch state (`status`, `avg_cost`, `current_weight`) automatically. Weighted averages and inventory balances are computed in SQL — never in TypeScript.

## Database

**Tables:** `batches`, `deliveries`, `rc_out`, `profiles`, `audit_logs`, `audit_comments`, `notifications`, `notification_subscriptions`, `user_invites`, `user_dashboard_prefs` (per-user dashboard layout/settings, Supabase-primary persistence), `user_table_settings` (per-user per-module table display settings)

**Views:** `view_rc_in_master`, `view_blocking_grid`

**Key triggers:**
- `fn_update_blackwood_state` — delivery inserts/updates → batch cost recalculation
- `fn_process_blackwood_usage` — usage inserts → batch status and weight updates
- `handle_new_user` — auth signup → profile creation from invite whitelist

**Generated columns** on `rc_out`: `rc_out_avg_price`, `rc_out_avg_wtd_value`.

## Project Structure

```
app/
  (app)/                    # Auth-protected routes
    page.tsx                # Dashboard (platform layer)
    inventory/              # Charcoal tenant domain modules
      components/           # Shared inventory components
      rc-in/                # Deliveries (inbound)
      rc-out/               # Usage (outbound)
      blocking/             # Warehouse grid visualization
    admin/                  # User management (platform infrastructure)
    settings/               # Profile & preferences
    notifications/          # Notification center
  login/                    # Public auth page
  auth/callback/            # OAuth callback
components/
  ui/                       # Shadcn primitives
  widgets/                  # Widget registry + all widget components (platform layer)
  dashboard/                # Dashboard shell: DashboardGrid, WidgetShell, WidgetPicker
  providers/                # Context providers (auth, theme)
lib/
  widgets/
    mock-data.ts            # Static adapter (charcoal-shaped, fallback for dev/demo)
    adapters/               # Live Supabase adapters: charcoal-kpi, charcoal-chart, charcoal-warehouse, charcoal-scatter
  dashboard/                # Shared dashboard types (D6Prefs, LayoutItem) + profile-store (multi-profile localStorage)
  hooks/                    # Reusable hooks (cell selection, clipboard)
  supabase/                 # Client, server, admin Supabase clients
types/                      # TypeScript type definitions
supabase/migrations/        # Database migrations
scripts/                    # Data seeding scripts
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm
- Supabase project (with linked CLI)

### Environment Variables

Create `.env.local` in the project root:

```bash
NEXT_PUBLIC_SUPABASE_URL=<your_supabase_url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your_anon_key>
SUPABASE_SERVICE_ROLE_KEY=<your_service_role_key>
```

### Install & Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Development

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run lint         # ESLint

# Supabase
supabase gen types typescript --linked > types/supabase.ts   # Regenerate types
supabase migration new <name>                                 # New migration
supabase db push                                              # Push migrations
```

## Git Workflow

- **`main`** — production-ready
- **`dev`** — staging/integration
- **`feat/*`** — feature branches from `dev`
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
