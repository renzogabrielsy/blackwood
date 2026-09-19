import { notFound } from 'next/navigation';

import { AgeLensFixture } from './agelens-fixture';

// ─────────────────────────────────────────────────────────────────────────────
// /dev/table-playground/agelens — the BLOCKING AGE LENS's look rig, and the
// TWO-LENS rig for the frame. DEV ONLY, gated exactly like the `pricelens` sibling.
//
// **WHY IT IS KEPT rather than deleted with the measurement** — the same reason
// `pricelens` and `rcmprint` are. `scripts/verify-blocking-lens-ui.ts` can ENFORCE
// that the seven `.lens-age-*` rules exist, sit after `.blocking-cell-occupied` and
// share no hue with the cost ramp, but Node has no renderer: it cannot tell you
// whether the age ramp reads fresh→old, whether a lab-highlighted MC figure is still
// legible over band 4's purple, whether the two tabs feel like one tool, or whether
// the docked column still lets the grid scroll at 375px. Those are the only questions
// this feature can get WRONG in a way a test would not notice.
//
// It mounts the REAL frame with the REAL `AgeLensPanel` and the REAL `PriceLensPanel`
// (each through its `adapter` port, with static payloads shaped like their data
// layers' contracts) and the REAL cell classes, so what you see is what
// `/inventory/blocking` puts there. It fetches nothing: the age action would return
// `not_signed_in` here and the price actions `prices_hidden`, which are precisely the
// states in which a lens cannot be looked at.
//
//   http://localhost:3000/dev/table-playground/agelens
//   ?bands=2|3|4|5|7   — how many age bands to draw (4 is the shipped default)
//   ?undated=1         — include blocks with no delivery date, to see them stay un-lensed
//   ?prices=0          — simulate a PRICE-DENIED reader: no tab strip, Age only
//
// It is gated TWICE, and the two locks are independent:
//   1. here — `notFound()` in production unless `TABLE_PLAYGROUND` is set;
//   2. in `middleware.ts` — `/dev/table-playground` is only added to `PUBLIC_PATHS`
//      under the same condition (a prefix match, so this nested route is covered).
//
// The gate lives in THIS server component because `process.env.TABLE_PLAYGROUND` is
// not `NEXT_PUBLIC_` and is therefore absent from the client bundle.
//
// It holds NO data access of any kind: every figure it renders is a literal in the
// fixture file, it imports no Supabase client and no auth helper.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default function AgeLensFixturePage() {
  if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
  return <AgeLensFixture />;
}
