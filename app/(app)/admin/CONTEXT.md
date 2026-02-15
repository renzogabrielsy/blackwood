# Admin Module — User Management

## Purpose
Whitelist-based user invitation, role assignment, and soft-delete access control. Only accessible to Owner/Admin/Dev roles.

## Files
| File | Lines | Role |
|------|-------|------|
| `page.tsx` | 52 | Server component — auth check, fetches all profiles, passes to table |
| `actions.ts` | 201 | 4 server actions: `inviteUser`, `revokeUserAccess`, `reactivateUser`, `updateUserRole` |
| `layout.tsx` | 25 | Route guard — redirects non-privileged users to `/inventory/rc-in` |
| `loading.tsx` | 15 | Skeleton loading state |
| `components/UserManagementTable.tsx` | 168 | Dense data table with inline role dropdown + revoke/reactivate |
| `components/InviteUserDialog.tsx` | 113 | Modal form — email + role selection, calls `inviteUser()` |
| `components/RevokeAccessDialog.tsx` | 79 | Confirmation dialog — conditional revoke/reactivate messaging |
| `components/UserStatusBadge.tsx` | 23 | Green (active) / red (disabled) badge |

**Related files:**
- `lib/supabase/admin.ts` (26 lines) — Service role client factory, bypasses RLS
- `app/auth/callback/route.ts` (62 lines) — OAuth callback with whitelist verification + retries
- `app/access-denied/page.tsx` (25 lines) — Friendly "Access Revoked" page

## Data
- **Tables:** `profiles` (status, role), `user_invites` (email whitelist)
- **Triggers:** `handle_new_user()` — creates profile from `user_invites` on auth signup; `handle_invite_creation()` — activates pending profiles when invited
- **Admin client:** `createAdminClient()` uses `SUPABASE_SERVICE_ROLE_KEY` (env var, never exposed to browser)

## Key Behaviors
- **Whitelist invite flow:** Admin adds email to `user_invites` → Supabase sends magic link → user OAuth at `/auth/callback` → trigger creates profile with invited role → callback verifies status (retries 3x for trigger race condition)
- **Soft-delete access control:** `profiles.status` toggled between `active`/`disabled`. Auth context checks status on every navigation; disabled users auto-signed out and redirected to `/access-denied`.
- **Self-revocation protection:** `revokeUserAccess()` rejects if `userId === current_user.id`
- **Service role key:** Required in `.env.local`, used only in server actions. Error thrown if missing.
- **All actions** verify caller is `['Owner', 'Admin', 'Dev']` before executing.

## Dependencies
- `@/lib/supabase/admin` — `createAdminClient()` for RLS bypass
- `@/lib/auth` — `getUserRole()` with dev override check
- `@/types/auth` — `PRIVILEGED_ROLES`, `UserRole`
- `@/components/providers/auth-context` — `UserRole` type
- `date-fns`, `sonner`, `lucide-react`

## See Also
- [Auth Provider](../../../components/providers/AUTH.md) — permission matrix, status gating, dev override
- [Navbar](../../../components/NAVBAR.md) — Admin Panel in modules dropdown (privileged only)
- [Notifications](../../../components/NOTIFICATIONS.md) — notifications table used alongside admin
