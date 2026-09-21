import { notFound } from 'next/navigation';

import { BlockingHeadFixture } from './blockinghead-fixture';

// ─────────────────────────────────────────────────────────────────────────────
// /dev/table-playground/blockinghead — the BLOCKING CONTROL STRIP's look rig, and
// the blend table's SUPPLIER / OPENED / LAST PILED columns. DEV ONLY, gated exactly
// like the `pricelens` / `agelens` / `rcmprint` fixtures beside it.
//
// **WHY IT IS KEPT** — the same reason they are. Node can ENFORCE that the strip is a
// four-track grid with the documented minimums, but it cannot tell you whether a
// section MOVES when a mode is switched on, whether the strip scrolls rather than
// crushes at 1024px, or whether a supplier pill is legible in dark mode. Those are the
// only things this work can get wrong in a way an assertion would not notice, and this
// page is where they are answered — at any width, in both themes, with no login.
//
// It mounts the REAL `BlockingGrid` over a static `BlockingGridData`, so the strip, the
// lens bar, the cells and the blend modal are the page's own components. It holds NO
// data access: every figure is a literal here, it imports no Supabase client and no
// auth helper, and the blend modal's supplier/age read is supplied through the same
// `factsAdapter` port the lens fixtures use for theirs.
//
//   http://localhost:3113/dev/table-playground/blockinghead
//   ?prices=0     — a price-DENIED reader (no ₱ anywhere, no Prices toggle, Age only)
//   ?blend=1      — open the blend modal with green / orange / em-dash rows
//
// Gated TWICE and independently: `notFound()` here in production unless
// `TABLE_PLAYGROUND` is set, and `/dev/table-playground` is only added to
// `middleware.ts`'s `PUBLIC_PATHS` under the same condition (a prefix match, so this
// nested route is covered). The gate lives in THIS server component because
// `process.env.TABLE_PLAYGROUND` is not `NEXT_PUBLIC_` and would be `undefined` in a
// `'use client'` file, which would 404 always.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default function BlockingHeadFixturePage() {
  if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
  return <BlockingHeadFixture />;
}
