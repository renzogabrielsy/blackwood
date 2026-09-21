import { notFound } from 'next/navigation';

import { BlendAnalysisFixture } from './blendanalysis-fixture';

// ─────────────────────────────────────────────────────────────────────────────
// /dev/table-playground/blendanalysis — the BLEND ANALYSIS PAGES' look rig. DEV
// ONLY, and gated exactly like the Blackwood Table playground and the `pricelens` /
// `agelens` / `rcmprint` fixtures beside it.
//
// **WHY IT EXISTS** — the same reason its siblings do. `scripts/verify-blend-analysis-
// ui.ts` can ENFORCE that no subtotal is summed in TypeScript, that the price page is
// gated on the effective flag and that the options are parsed as untrusted — but Node
// has no renderer. It cannot tell you whether a group's tint still leaves a
// lab-highlighted MC figure legible, whether four stacked tables read as PAGES or as
// one long list, or whether the printed sheets break where they should. Those are the
// only questions this feature can get WRONG in a way a test would not notice.
//
// It mounts the REAL `BlendProposalDialog` — with its real header actions, its real
// Include-pages popover, its real print and its real PDF — and swaps only the two data
// PORTS (`analysisAdapter`, `factsAdapter`) for static payloads shaped like the
// contract. The analysis adapter answers after a REALISTIC ~300 ms, deliberately: a
// microtask-resolving stub hid a request race on this page's siblings last week, and a
// skeleton that never renders is a skeleton nobody can review.
//
//   http://localhost:3000/dev/table-playground/blendanalysis
//   ?saved=1        — render the SAVED-version viewer (title, remark, version rail)
//   ?prices=0       — a price-DENIED reader: no price page, no ₱ anywhere
//   ?pages=quality  — seed the Include-pages choice (comma list of price|quality|age)
//   ?unmeasured=1   — include blocks with no lab reading and no price
//   ?slow=2000      — a slower adapter, to look at the skeletons
//   ?stall=1        — an adapter that never answers, to see the watchdog banner
//
// It is gated TWICE, and the two locks are independent:
//   1. here — `notFound()` in production unless `TABLE_PLAYGROUND` is set;
//   2. in `middleware.ts` — `/dev/table-playground` is only added to `PUBLIC_PATHS`
//      under the same condition (a prefix match, so this nested route is covered).
//
// The gate lives in THIS server component because `process.env.TABLE_PLAYGROUND` is not
// `NEXT_PUBLIC_` and is therefore absent from the client bundle.
//
// It holds NO data access of any kind: every figure is a literal in the fixture file, it
// imports no Supabase client and no auth helper, and it can be driven with no
// credentials.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default function BlendAnalysisFixturePage() {
  if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
  return <BlendAnalysisFixture />;
}
