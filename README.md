# Blackwood

Industrial inventory management system for a charcoal processing plant. Tracks inbound deliveries, outbound usage, batch state, and user access through dense, spreadsheet-style interfaces.

## Tech Stack

- **Next.js 16** (App Router) with **React 19** and **TypeScript** (strict mode)
- **Supabase** (PostgreSQL) with Row Level Security
- **Tailwind CSS v4** with **Shadcn UI** (new-york style, zinc base)
- **TanStack Table** + TanStack Virtual for virtualized data grids
- **date-fns** for date formatting, **cmdk** for command menus
- **next-themes** for dark mode

## Modules

### Inventory (`/inventory`)

- **Deliveries (RC IN)** — Inbound delivery logging with bulk grid input, quality tracking (lab results as JSONB), audit trail with resolve workflow
- **Usage (RC OUT)** — Outbound consumption tracking, batch depletion, DB-computed pricing columns, infinite scroll
- **Shared** — Tab-based navigation, DeliverySheetFooter with year/month selection, cell selection + clipboard copy

### Admin (`/admin`)

- User management — invite, revoke, reactivate
- Role-based access — Owner, Admin, Dev, Employee
- Supabase Auth integration with invite-only whitelist (`user_invites` table)

### Notifications

- Realtime notification bell (polling-based)
- Audit trail subscriptions
- Resolve request workflow notifications

### Settings (`/settings`)

- Profile management (display name, avatar)
- Sign out

## Architecture

    User Action -> Client Component -> Server Action -> Supabase -> revalidatePath() -> Re-render

- **Server Components** (`page.tsx`) handle data fetching
- **Client Components** (`'use client'`) handle interactivity
- **Server Actions** (`actions.ts`) handle all mutations
- DB triggers derive batch state (`status`, `avg_cost`, `current_weight`) automatically
- URL search params for RC IN filters; internal React state for RC OUT
- **"Separate Inputs, Unified State"** — each module captures data independently, the database unifies state via triggers and views

## Database

**Tables:** `batches`, `deliveries`, `rc_out`, `profiles`, `audit_logs`, `audit_comments`, `notifications`, `notification_subscriptions`, `user_invites`

**Key triggers:**
- `fn_update_blackwood_state` — delivery inserts/updates → batch cost recalculation
- `fn_process_blackwood_usage` — usage inserts → batch status and weight updates
- `handle_new_user` — auth signup → profile creation from invite whitelist

**Generated columns** on `rc_out` for `rc_out_avg_price` and `rc_out_avg_wtd_value`.

**Views:** `view_rc_in_master` — joined delivery + batch data for the RC IN table.

## Project Structure

```
app/
  (app)/                    # Auth-protected routes
    inventory/              # Inventory module
      components/           # Shared inventory components
      rc-in/                # Deliveries (inbound)
      rc-out/               # Usage (outbound)
    admin/                  # User management
    settings/               # Profile & preferences
    notifications/          # Notification center
  login/                    # Public auth page
  auth/callback/            # OAuth callback
components/
  ui/                       # Shadcn primitives
  providers/                # Context providers (auth, theme)
lib/
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
