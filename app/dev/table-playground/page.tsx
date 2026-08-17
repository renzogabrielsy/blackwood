import { notFound } from 'next/navigation';

import { PlaygroundGrid } from './playground-grid';

// ─────────────────────────────────────────────────────────────────────────────────
// /dev/table-playground — the Blackwood Table's test harness. DEV ONLY.
//
// **It lives OUTSIDE the `(app)` route group on purpose.** That group's layout calls
// `supabase.auth.getUser()` and redirects to `/login` without a session, and the
// middleware does the same before the layout is even reached — so a playground inside it
// could only be driven by a suite that holds real credentials. The whole point of this
// page is that `e2e/table/parity.spec.ts` needs no login, no Supabase and no tenant
// module: the grid is mounted on an in-memory array.
//
// It is gated TWICE, and the two locks are independent:
//   1. here — `notFound()` in production unless `TABLE_PLAYGROUND` is set;
//   2. in `middleware.ts` — the path is only added to `PUBLIC_PATHS` under the same
//      condition, so in production it is not merely a 404, it is behind the login wall
//      like everything else.
//
// It reads nothing, writes nothing, and imports no tenant code.
// ─────────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default function TablePlaygroundPage() {
    if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
    return <PlaygroundGrid />;
}
