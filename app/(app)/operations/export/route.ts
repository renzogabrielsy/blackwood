// ═════════════════════════════════════════════════════════════════════════════════
// GET /operations/export?campaigns=JULY-2026,AUGUST-2026 — the ledger as a workbook.
//
// Built in memory and streamed as an attachment. NO Storage bucket and NO stored
// artifact: the file is a VIEW OF THE LIVE DATA, exactly like the page, so there is
// nothing that can go stale and nothing whose price-gating has to be recorded as a
// fact about a stored file (contrast the sync report, which must carry
// `sync_run_reports.contains_prices` precisely because it is stored).
//
// IT READS THE ADDRESS THE SAME WAY THE PAGE DOES. `?campaigns=` is the identical
// comma-separated, upper-cased, de-duplicated key list `page.tsx` parses, and an
// absent param means the whole latest quarter, resolved through the SAME
// `latestQuarterKeys()` the page and the picker read. Export and screen therefore
// cannot describe different groups.
//
// ── TWO GATES, BOTH SERVER-SIDE ────────────────────────────────────────────────
//  1. A SIGNED-IN USER. The middleware already redirects an anonymous request, and
//     this asks again anyway: a download route is exactly the kind of thing that
//     later gets added to a PUBLIC_PATHS list by accident.
//  2. `canViewPrices()` — the ONE canonical gate (`lib/auth.ts`), which honours the
//     dev impersonation cookie. The adapter has already nulled every ₱ field; the
//     builder additionally OMITS the ₱ columns, so a Production workbook has no
//     price column to un-hide. Both flags are ANDed, so the workbook can only ever
//     be narrower than either gate allows — fail closed.
//
// Production IS allowed to export (plan §8 decision 4). The file is smaller, not
// censored.
// ═════════════════════════════════════════════════════════════════════════════════

import { canViewPrices } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { fetchOpsLedger, fetchOpsLedgerCampaignOptions } from '@/lib/operations/queries';
import { buildOpsWorkbook, toExcelInput } from '@/lib/operations/excel/workbook';
import { latestQuarterKeys, quarterPresets } from '../ops-lens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function GET(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return text('You need to be signed in to export the operations ledger.', 401);

  const raw = new URL(req.url).searchParams.get('campaigns');
  const requested = raw
    ? [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))]
    : [];

  let options: Awaited<ReturnType<typeof fetchOpsLedgerCampaignOptions>>;
  try {
    options = await fetchOpsLedgerCampaignOptions();
  } catch (e) {
    return text(`Could not read the campaign list: ${message(e)}`, 502);
  }

  const keys =
    requested.length > 0
      ? requested
      : latestQuarterKeys(options).length > 0
        ? latestQuarterKeys(options)
        : options[0]
          ? [options[0].key]
          : [];

  if (keys.length === 0) {
    return text('No production campaign has been recorded yet, so there is nothing to export.', 404);
  }

  const gate = await canViewPrices();

  let data: Awaited<ReturnType<typeof fetchOpsLedger>>;
  try {
    data = await fetchOpsLedger(keys);
  } catch (e) {
    return text(`Could not read the operations ledger: ${message(e)}`, 502);
  }

  if (data.campaigns.length === 0) {
    return text(
      `None of the requested campaigns resolved (${keys.join(', ')}). Open /operations with no query to read the latest quarter.`,
      404,
    );
  }

  // The group's NAME, resolved the way the print sheet resolves it: the quarter
  // preset whose key set is exactly the campaigns in the payload, else their labels
  // joined. No date arithmetic here — the quarter is a fact the database decided.
  const resolved = data.campaigns.map((c) => c.key);
  const preset = quarterPresets(options).find(
    (p) => p.keys.length === resolved.length && p.keys.every((k) => resolved.includes(k)),
  );
  const groupLabel = preset?.label ?? data.rollups.map((r) => r.label).join(' · ');

  try {
    const input = toExcelInput(
      // BOTH gates ANDed. The adapter already resolved the canonical gate; this can
      // only ever narrow it further, never widen it.
      { ...data, canViewPrices: data.canViewPrices && gate },
      groupLabel,
    );
    const { buffer, filename } = await buildOpsWorkbook(input);
    const ascii = filename.replace(/[^\x20-\x7e]/g, '-');
    return new Response(new Blob([buffer as unknown as BlobPart], { type: XLSX_MIME }), {
      status: 200,
      headers: {
        'Content-Type': XLSX_MIME,
        'Content-Length': String(buffer.byteLength),
        // RFC 5987 — the name carries an em dash, which a bare `filename=` cannot.
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return text(`Could not build the workbook: ${message(e)}`, 500);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A plain-text failure the Export button can put straight into `errorToast()`. */
function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
