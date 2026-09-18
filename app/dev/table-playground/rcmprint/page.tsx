import { notFound } from 'next/navigation';

import { RcmPrintFixture } from './rcmprint-fixture';

// ─────────────────────────────────────────────────────────────────────────────────
// /dev/table-playground/rcmprint — the RC MOVEMENT PRINTED SHEET's measurement rig.
// DEV ONLY, and gated exactly like the Blackwood Table playground beside it.
//
// **WHY IT IS KEPT rather than deleted with the measurement.** The one-page promise is
// ARITHMETIC over a glyph advance that Node cannot derive (no font engine), so
// `scripts/verify-rc-movement-grid.ts` §4 can only ENFORCE the constants — it cannot
// re-measure them, and it cannot render a page. This fixture is the other half: it mounts
// the real sheet in a real print box, re-measures the mono advance live and publishes it
// as `data-fixture-advance`, and is what headless Chrome renders to a PDF whose PAGE COUNT
// is the assertion. A page-fitting promise verified by estimating the page is not verified
// at all — and the day the app's mono face or the margin changes, this is the only way to
// find out what actually happened to the paper.
//
//   npx …/Google\ Chrome --headless --print-to-pdf=out.pdf --no-pdf-header-footer \
//     'http://localhost:3000/dev/table-playground/rcmprint?days=33&blocks=25&grades=2&prices=1&actual=1'
//   pdfinfo out.pdf | grep Pages     # → 1
//
//   ?days= ?blocks= ?grades= ?prices=0|1 ?actual=0|1   — the shape to render
//   ?control=1                                         — mount the REAL toolbar button
//                                                        instead, to drive the click →
//                                                        stage → window.print() wiring
//
// It is gated TWICE, and the two locks are independent — the sibling page's contract,
// restated here because a fixture that reads nothing still must not be a live URL:
//   1. here — `notFound()` in production unless `TABLE_PLAYGROUND` is set;
//   2. in `middleware.ts` — `/dev/table-playground` is only added to `PUBLIC_PATHS` under
//      the same condition, so in production it is behind the login wall like everything else.
//
// The gate lives in THIS server component because `process.env.TABLE_PLAYGROUND` is not
// `NEXT_PUBLIC_` and is therefore absent from the client bundle — reading it from the
// `'use client'` fixture would silently evaluate to `undefined` and 404 unconditionally.
//
// It holds NO data access of any kind: every row it renders is generated in memory, it
// imports no Supabase client and no auth helper, and it can be driven with no credentials.
// ─────────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default function RcmPrintFixturePage() {
    if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
    return <RcmPrintFixture />;
}
