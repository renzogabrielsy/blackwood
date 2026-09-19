import { notFound } from 'next/navigation';

import { PriceLensFixture } from './pricelens-fixture';

// ─────────────────────────────────────────────────────────────────────────────
// /dev/table-playground/pricelens — the BLOCKING PRICE LENS's look rig. DEV ONLY,
// and gated exactly like the Blackwood Table playground and the `rcmprint` fixture
// beside it.
//
// **WHY IT IS KEPT rather than deleted with the measurement** — the same reason
// `rcmprint` is. `scripts/verify-blocking-lens-ui.ts` can ENFORCE that the seven
// `.lens-band-*` rules exist and sit after `.blocking-cell-occupied`, but Node has
// no renderer: it cannot tell you whether band 3's amber wash still leaves a
// lab-highlighted MC figure legible, whether the ramp reads cheap→expensive, or
// whether the docked column still lets the grid scroll at 375px. Those are the only
// questions this feature can get WRONG in a way a test would not notice, and this
// page is where they are answered — in both themes, at any width, with no login.
//
// It mounts the REAL `PriceLensPanel` (through its `adapter` port, with a static
// payload shaped like the data layer's contract) and the REAL cell classes, so what
// you see is what the page renders. It fetches nothing: the panel's two server
// actions would only ever return `prices_hidden` here with no session, which is
// precisely the state in which the lens cannot be looked at.
//
//   http://localhost:3000/dev/table-playground/pricelens
//   ?bands=3|4|5|7   — how many bands to draw
//   ?unpriced=1      — include unpriced blocks, to see them stay un-lensed
//
// It is gated TWICE, and the two locks are independent:
//   1. here — `notFound()` in production unless `TABLE_PLAYGROUND` is set;
//   2. in `middleware.ts` — `/dev/table-playground` is only added to `PUBLIC_PATHS`
//      under the same condition (a prefix match, so this nested route is covered),
//      so in production it is behind the login wall like every other page.
//
// The gate lives in THIS server component because `process.env.TABLE_PLAYGROUND` is
// not `NEXT_PUBLIC_` and is therefore absent from the client bundle — reading it
// from the `'use client'` fixture would evaluate to `undefined` and 404 always.
//
// It holds NO data access of any kind: every figure it renders is a literal in the
// fixture file, it imports no Supabase client and no auth helper, and it can be
// driven with no credentials.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default function PriceLensFixturePage() {
  if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
  return <PriceLensFixture />;
}
