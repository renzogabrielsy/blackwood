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
