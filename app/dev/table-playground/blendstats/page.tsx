import { notFound } from 'next/navigation';

import { BlendStatsFixture } from './blendstats-fixture';

// ─────────────────────────────────────────────────────────────────────────────
// /dev/table-playground/blendstats — the BLEND ACTION BAR's rig (live stats strip +
// the Modify session's save doors). DEV ONLY, gated exactly like its siblings.
//
// It mounts the REAL `BlendActionBar` and the REAL `useBlendLiveStats` hook, with the
// hook's `fetcher` port pointed at an in-memory fake that answers after ~300 ms — so the
// debounce, the signature guard, the "keep the last numbers while updating" dim, the
// watchdog and the Copy/Retry error strip can all be driven with no login and no
// database. `scripts/verify-blend-live-stats-ui.ts` drives it with Playwright.
//
//   http://localhost:3000/dev/table-playground/blendstats
//   ?prices=0          — the reader cannot see prices (the ₱ tiles must be ABSENT)
//   ?modify=1          — open a Modify session on "v2" of a 4-version proposal
//   ?slow=A-2A         — the selection whose signature is exactly this answers in 1.5 s
//   ?fail=A-9A         — any selection containing this block rejects
//   ?hang=A-8A         — any selection containing this block never answers
//   ?watchdog=<ms>     — the watchdog threshold (default: the shipped 12 s)
//
// It is gated TWICE, and the two locks are independent:
//   1. here — `notFound()` in production unless `TABLE_PLAYGROUND` is set;
//   2. in `middleware.ts` — `/dev/table-playground` is only added to `PUBLIC_PATHS`
//      under the same condition (a prefix match, so this nested route is covered).
//
// It holds NO data access of any kind: every figure is a literal the fixture makes up.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default function BlendStatsFixturePage() {
  if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
  return <BlendStatsFixture />;
}
