# Auth Provider

## Purpose
Global authentication and permission context (180 lines, `components/providers/auth-context.tsx`). Every module consumes `useAuth()` for role checks and permission gating.

> **Platform Infrastructure:** Auth is platform infrastructure. Roles (`Owner`, `Admin`, `Dev`, `Production`, `Accounting`) and permissions are intentionally domain-neutral — they are general-purpose labels, not charcoal-specific. Any future tenant uses the same permission matrix unchanged.

## Exports
- `AuthProvider` — wraps app in auth context
- `useAuth()` — hook returning `{ user, role, dbRole, displayName, avatarUrl, setRole, hasPermission, signOut, isLoading }`
- `UserRole` type — `'Owner' | 'Admin' | 'Dev' | 'Production' | 'Accounting'`
- `Permission` type — `'view:all' | 'view:prices' | 'edit:all' | 'delete:all'`

## Permission Matrix
| Permission | Owner | Admin | Dev | Accounting | Production |
|-----------|-------|-------|-----|------------|------------|
| `view:all` | yes | yes | yes | yes | yes |
| `view:prices` | yes | yes | yes | yes | **NO** |
| `edit:all` | yes | yes | yes | yes | yes |
| `delete:all` | yes | yes | yes | **NO** | **NO** |

## Dev Override Mechanism
1. Only users with `dbRole` in `['Owner', 'Admin', 'Dev']` can override
2. `setRole(role)` writes to `localStorage('dev_mock_role')` + `document.cookie('dev_mock_role')`
3. `setRole('logged-in')` clears the override (restores `dbRole`)
4. Client: `useAuth().role` returns override if set, otherwise `dbRole`
5. Server: `getUserRole()` in `lib/auth.ts` reads `dev_mock_role` cookie for SSR parity

## Price Gating — `canViewPrices()` is the CANONICAL server-side gate

Price/cost data (₱/kg, weighted-avg values, `cost_basis`) is a security boundary. The **single source of truth** for whether a request may receive ₱ values is `lib/auth.ts`:

- **`canViewPrices(): Promise<boolean>`** — the gate to call in server actions / server components. Resolves the EFFECTIVE role via `getUserRole()`, so it **respects the `dev_mock_role` impersonation cookie** (an Owner "viewing as Production" is correctly denied). Fails CLOSED (returns `false`) when there's no authenticated user.
- **`roleCanViewPrices(role: UserRole): boolean`** — pure predicate form (no DB/cookie). Mirrors the `view:prices` matrix above: all roles `true` EXCEPT `Production`.

**Server boundary rule (mandatory):** when `!canViewPrices()`, OMIT/null every ₱ field **before the payload leaves the server** — never just hide it in the browser (the network response is the leak). Pass a `canViewPrices: boolean` back in the returned data so the client can render conditionally without re-deriving the role.

Server callers (canonical references):
- `app/(app)/inventory/page.tsx` (RC IN) — `cost_basis: showPrices ? d.cost_basis : undefined`
- `app/(app)/inventory/rc-out/actions.ts#fetchRcOutTabData` — nulls `avg_price` / `avg_wtd_value`, returns `canViewPrices`
- `app/(app)/inventory/rc-movement/actions.ts#fetchRcMovementMatrix` — nulls `avgFedPriceDay` / `avgFedPrice` / `campaignAvgFedPrice`, returns `canViewPrices`
- `app/(app)/inventory/blocking/actions.ts` — nulls `avg_price` per block

Client-side `hasPermission('view:prices')` remains for conditional RENDER only — it is a UX nicety, NOT the security boundary. The boundary is the server-side null-before-send.

## Status Gating Flow
On auth state change or profile fetch:
1. Fetch `profiles.status` for current user
2. If `status !== 'active'`:
   - Sign out the user
   - `'disabled'` → redirect to `/access-denied`
   - `'pending'` → redirect to `/login?error=not_invited`
3. If `'active'` → populate context with role, displayName, avatarUrl

## Related Files
- `lib/auth.ts` (26 lines) — `getUserRole(userId)` for server-side role resolution with cookie override
- `types/auth.ts` (3 lines) — `UserRole` type + `PRIVILEGED_ROLES` constant

## Data
- **Table:** `profiles` — `id`, `email`, `display_name`, `avatar_url`, `role`, `status`
- **Auth:** `supabase.auth.onAuthStateChange()` triggers profile fetch
- **Cookie:** `dev_mock_role` — stores dev override role for SSR

## See Also
- [Navbar](../NAVBAR.md) — consumes `useAuth()` for role switcher and conditional UI
- [Admin](../../app/(app)/admin/CONTEXT.md) — manages user roles and status
- [RC IN](../../app/(app)/inventory/rc-in/CONTEXT.md) — uses `hasPermission('view:prices')` for cost scrubbing
- [RC OUT](../../app/(app)/inventory/rc-out/CONTEXT.md) — uses `hasPermission('view:prices')` for price columns
