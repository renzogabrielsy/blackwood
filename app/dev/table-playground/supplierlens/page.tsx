import { notFound } from 'next/navigation';

import { SupplierLensFixture } from './supplierlens-fixture';

// ─────────────────────────────────────────────────────────────────────────────
// /dev/table-playground/supplierlens — the BLOCKING SUPPLIER LENS's look rig, and the
// THREE-LENS rig for the frame. DEV ONLY, gated exactly like its `pricelens` and
// `agelens` siblings.
//
// **WHY IT EXISTS rather than being folded into `agelens`** — the frame's tab strip is
// itself a thing to look at, and a THREE-tab strip is not a two-tab strip with one more
// button: it changes how much room the active lens's bar has before its chips start to
// scroll. This page mounts all three REAL panels through their `adapter` ports so that
// question can be answered at 1512 and at 375.
//
// `scripts/verify-blocking-lens-ui.ts` can ENFORCE that the thirteen `.lens-cat-*` rules
// exist, sit after `.blocking-cell-occupied`, match `LENS_RAMP_RGB.category` and avoid the
// supplier search's emerald and orange. Node has no renderer: it cannot tell you whether
// twelve categorical hues are actually TELLABLE APART at 22% alpha over a zinc cell,
// whether the dashed MIXED outline reads as "some of it" rather than as a selection, or
// whether seven supplier chips fit the bar. Those are the only questions this feature can
// get WRONG in a way a test would not notice.
//
//   http://localhost:3000/dev/table-playground/supplierlens
//   ?top=1|3|6|12       — how many suppliers to name (6 is the shipped default)
//   ?unattributed=1     — include blocks whose batch has NO delivery, to see them stay un-lensed
//   ?prices=0           — simulate a PRICE-DENIED reader: Age + Supplier, no Price tab
//   ?pca=1              — put stock in PCA/PCB, so the PRINTED YARD MAP includes them
//                         (14 cell rows instead of 11 — its worst-case cell size)
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

export default function SupplierLensFixturePage() {
  if (process.env.NODE_ENV === 'production' && !process.env.TABLE_PLAYGROUND) notFound();
  return <SupplierLensFixture />;
}
