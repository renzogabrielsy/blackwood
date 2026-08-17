import { createClient } from '@/lib/supabase/server';
import { UserRole, PRIVILEGED_ROLES } from '@/types/auth';
import { cookies } from 'next/headers';

export async function getUserRole(userId: string): Promise<UserRole> {
    const supabase = await createClient();
    const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single();

    const realRole = (data?.role as UserRole) || 'Production';

    // Only allow overrides for privileged users
    if (PRIVILEGED_ROLES.includes(realRole)) {
        const cookieStore = await cookies();
        const override = cookieStore.get('dev_mock_role');
        if (override?.value) {
            return override.value as UserRole;
        }
    }

    return realRole;
}

/**
 * Roles that may NOT see price/cost data (₱/kg, weighted-avg values, cost basis).
 * Mirrors the `view:prices` permission matrix in components/providers/AUTH.md:
 * every role sees prices EXCEPT Production.
 */
const PRICE_DENIED_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['Production']);

/**
 * Predicate form of the price gate — pure, no DB/cookie access. Owner / Admin / Dev /
 * Accounting may view prices; Production may NOT. Keep this in sync with the
 * `view:prices` row of the AUTH.md permission matrix and the client-side
 * `hasPermission('view:prices')` check in the auth context.
 */
export function roleCanViewPrices(role: UserRole): boolean {
    return !PRICE_DENIED_ROLES.has(role);
}

/**
 * CANONICAL server-side price gate. The ONE source of truth for whether the
 * current request may receive ₱/cost values in a server-action / server-component
 * payload. Derives the EFFECTIVE role via getUserRole(), so it respects the
 * dev-impersonation cookie (an Owner "viewing as Production" is correctly denied).
 *
 * Usage in a server action / RSC:
 *   const canSee = await canViewPrices();
 *   ...map rows, setting price fields to null when !canSee, BEFORE returning.
 *
 * Returns false (deny) when there is no authenticated user — fail closed.
 */
export async function canViewPrices(): Promise<boolean> {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const role = await getUserRole(user.id);
    return roleCanViewPrices(role);
}

/**
 * CANONICAL server-side privileged-role gate — Owner / Admin / Dev only.
 *
 * The sibling of `canViewPrices()` for capabilities that are not about money:
 * destructive actions, user management, anything the client hides behind
 * `hasPermission('delete:all')`. Like the price gate it derives the EFFECTIVE role via
 * `getUserRole()`, so an Owner "viewing as Production" is correctly denied, and it
 * fails CLOSED when there is no authenticated user.
 *
 * Use it in a server action *before* the write, and pass its result down as a prop
 * when a client component needs to hide a control:
 *   if (!(await isPrivileged())) return { ok: false, outcome: 'forbidden' };
 *
 * It exists because this check was being re-typed inline at every call site (see
 * `app/(app)/inventory/rc-in/actions.ts`, which repeats the
 * getUser → getUserRole → PRIVILEGED_ROLES sequence in four actions) — and a gate that
 * is copied is a gate that gets forgotten, which is exactly what happened to Cenapro's
 * delete path.
 */
export async function isPrivileged(): Promise<boolean> {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const role = await getUserRole(user.id);
    return PRIVILEGED_ROLES.includes(role);
}
