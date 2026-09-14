import { notFound } from 'next/navigation';

import { isPrivileged } from '@/lib/auth';

// ═════════════════════════════════════════════════════════════════════════════════
// WHO MAY SEE THE DRAFTS — ONE definition, called by all four pages.
//
// It is a shared function rather than four copies of the same three lines for the reason
// `isPrivileged()`'s own docstring gives: "a gate that is copied is a gate that gets
// forgotten, which is exactly what happened to Cenapro's delete path." A fifth draft page
// added later calls this and is covered; a fifth page that re-typed the check might not be.
//
// ── WHY IT IS AN AUTH GATE AND NOT AN ENV GATE ──────────────────────────────────
// These pages first shipped behind `process.env.TABLE_PLAYGROUND`, copied from
// `/dev/table-playground`. That is the right gate for a PLAYWRIGHT FIXTURE, which must run
// with no credentials and must never be reachable in production. It is the wrong gate for a
// DESIGN DRAFT, because the person the drafts exist for reviews on the live Vercel site —
// where `NODE_ENV` is `production` and `TABLE_PLAYGROUND` is not set, so every one of them
// would 404 on the only machine that matters.
//
// ── THE THREE LAYERS, AND WHAT EACH ONE ACTUALLY STOPS ──────────────────────────
//   1. `middleware.ts` — `/dev/ops-ledger` is NOT in `PUBLIC_PATHS`, so it sits behind the
//      ordinary login wall like every other page: an anonymous visitor is redirected to
//      `/login` and never reaches this function at all.
//   2. THIS GATE — a signed-in user who is not Owner / Admin / Dev gets `notFound()`. A 404
//      rather than a 403 on purpose: an unfinished draft should not advertise that it
//      exists to someone who may not open it.
//   3. The pages themselves read NOTHING — no Supabase client, no server action, no view.
//      So even a gate failure could leak no data; there is none behind it.
//
// `isPrivileged()` is the canonical server-side Owner/Admin/Dev gate (`lib/auth.ts`, the
// sibling of `canViewPrices()`). Two properties matter here and neither is incidental: it
// derives the EFFECTIVE role through `getUserRole()`, so an Owner "viewing as Production"
// via the dev-role switcher is correctly refused and the drafts behave the way the rest of
// the app does under impersonation; and it FAILS CLOSED, returning false when there is no
// authenticated user.
//
// ── DEV IS DELIBERATELY UNRESTRICTED ────────────────────────────────────────────
// Outside production this returns immediately: local work on a layout draft should not
// require a role, and the check would otherwise cost a Supabase round trip on every render
// of a page that has no data in it. Note the middleware's login wall still applies locally —
// removing the public-path entry removed it everywhere, which is the point.
// ═════════════════════════════════════════════════════════════════════════════════

/**
 * Refuse the request unless it may see the ops-ledger drafts.
 *
 * Returns normally when allowed; otherwise `notFound()` throws Next's own control-flow
 * signal and the caller never continues. Callers therefore `await` it and then render.
 */
export async function requireDraftAccess(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') return;
    if (await isPrivileged()) return;
    notFound();
}
