# Prompt: Sync Dashboard Preferences to Supabase

## Goal

Dashboard widget settings (layout, comparison slices, Y series config, KPI period, collapsed state, sticky KPI) are currently stored only in localStorage (`bw_v1`). This means they are lost when the user switches browsers or devices. Make them **account-bound** — stored in Supabase, keyed by user ID — so they survive sign-out/sign-in on any device.

## Before Starting

Read these files first:
- `TIMELINE.md` — current sprint and phase status
- `CLAUDE.md` — platform architecture rules, DB schema, conventions
- `app/(app)/CONTEXT.md` — dashboard architecture
- `components/widgets/CONTEXT.md` — widget system overview
- `lib/dashboard/profile-store.ts` — current localStorage-only persistence
- `lib/dashboard/types.ts` — D6Prefs type definition
- `components/dashboard/DashboardGrid.tsx` — how savePrefs/loadPrefs are called
- `app/(app)/page.tsx` — server component that renders DashboardGrid

Enter plan mode first. Get approval before writing any code.

## Design

### Storage Strategy: Supabase-primary, localStorage as cache

- **On load:** Server component reads preferences from Supabase and passes them as a prop to DashboardGrid. DashboardGrid hydrates from this server-supplied value instead of (or in addition to) localStorage. localStorage remains as a fast local cache.
- **On save:** Every `savePrefs` call writes to localStorage immediately (existing behavior, kept for speed), then fires a debounced write to Supabase (e.g. 1500ms debounce). No loading spinners — it's a background sync.
- **Conflict resolution:** Supabase wins on load (it's the source of truth). localStorage is just a perf optimization.

### Database

Add a `user_dashboard_prefs` table:

```sql
create table user_dashboard_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  prefs    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- RLS: users can only read/write their own row
alter table user_dashboard_prefs enable row level security;

create policy "user_dashboard_prefs: own row only"
  on user_dashboard_prefs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

Apply via Supabase MCP (`apply_migration`), name it `add_user_dashboard_prefs`.

### Server Action

In `app/(app)/actions.ts` (or a new `app/(app)/dashboard-prefs-actions.ts`), add:

- `loadDashboardPrefs(): Promise<D6Prefs | null>` — fetches from `user_dashboard_prefs` for the current user. Returns null if no row exists (first visit).
- `saveDashboardPrefs(prefs: D6Prefs): Promise<void>` — upserts the prefs row for the current user. Uses `{ onConflict: 'user_id' }`.

Both actions use the standard server Supabase client (not admin). Do NOT call `revalidatePath()` in `saveDashboardPrefs` — we don't want a full page reload on every save.

### DashboardGrid changes

- Accept a new optional prop: `serverPrefs?: D6Prefs`
- In the load `useEffect`, if `serverPrefs` is provided, use it as the initial value instead of `DEFAULT_PREFS` (still run through `loadPrefs()` migration logic, but seed it from `serverPrefs`)
- After the local `savePrefs` write, also call a debounced `saveDashboardPrefs(prefs)` server action. Use a `useRef` to hold the debounce timer (clear on each call, fire after 1500ms).

### page.tsx changes

In `app/(app)/page.tsx` (server component), call `loadDashboardPrefs()` and pass the result as `serverPrefs` to `DashboardGrid`.

## Scope

- Single prefs object per user (no multi-profile complexity for cloud sync — the existing multi-profile localStorage behavior can stay as-is for local use, but only the active profile's prefs are synced to Supabase)
- No UI changes needed — the sync is invisible to the user
- No migration of existing localStorage data to Supabase is required (users just start fresh on new devices; existing local prefs still load on their current device)

## Definition of Done

- [ ] Migration applied: `user_dashboard_prefs` table exists with RLS
- [ ] `loadDashboardPrefs` server action returns saved prefs or null
- [ ] `saveDashboardPrefs` server action upserts correctly
- [ ] DashboardGrid hydrates from server-supplied prefs on load
- [ ] DashboardGrid debounces writes to Supabase (1500ms) after every settings change
- [ ] Signing in on a new browser loads the same widget layout and settings
- [ ] No visible latency or loading states introduced
- [ ] TypeScript clean, no new lint errors

## Summary

Give a summary of: what was built, all files changed, the migration name, any decisions made.
