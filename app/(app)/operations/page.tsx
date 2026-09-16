// No 'use client' — async Server Component.
//
// ═════════════════════════════════════════════════════════════════════════════════
// `/operations` — THE PLANT OPERATIONS LEDGER.
//
// Renzo's `Q3 2026` tab (one row per calendar day, on the production-batch clock,
// rest days included) and his `EOQ3 2026` tab (the rollup) — live, on the
// `view_ops_ledger_*` data layer.
//
// THIS FILE OWNS THREE THINGS AND NOTHING ELSE:
//
//  1. **The address → the payload.** `?campaigns=` is a comma-separated list of
//     campaign keys (`JULY-2026,AUGUST-2026,SEPTEMBER-2026`); absent means EVERY
//     CAMPAIGN OF THE LATEST QUARTER (2026-09-16), resolved from the same
//     `quarter_key` the picker's presets group on — the quarter containing the
//     MIDPOINT of each campaign's span, decided in SQL. An INCOMPLETE quarter is
//     still a quarter, which is the whole point: the current one is the one an
//     owner most wants and it used to be unreachable until its third campaign
//     opened. `?lens=` picks the right pane.
//  2. **The fetch.** `fetchOpsLedger` reads PER CAMPAIGN and folds —
//     `view_ops_ledger_day_block` is 2,148 rows over all history, so a
//     whole-history read would truncate at PostgREST's 1,000-row cap in silence.
//  3. **The ₱ gate, transitively.** The adapter resolves `canViewPrices()` ONCE and
//     nulls every ₱ field before the payload leaves the server; `canViewPrices`
//     rides along so the client drops those columns from its coordinate space
//     rather than rendering them blank. Nothing here re-derives price visibility.
//
// The navbar owns the page title and description (`getBreadcrumb()`), so this page
// renders no heading of its own.
//
// AN UNKNOWN CAMPAIGN KEY IS NOT AN ERROR. The group RPC returns it in
// `campaignsMissing` rather than dropping it, and the view says so in a notice —
// a mistyped or retired key must never render as a silently smaller quarter.
// ═════════════════════════════════════════════════════════════════════════════════

import { fetchOpsLedger, fetchOpsLedgerCampaignOptions } from '@/lib/operations/queries';
import { latestQuarterKeys, parseLens } from './ops-lens';
import { OperationsView } from './operations-view';

type Param = string | string[] | undefined;

function first(v: Param): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * `?campaigns=july-2026, AUGUST-2026` → `['JULY-2026', 'AUGUST-2026']`.
 *
 * Upper-cased and de-duplicated, because the key is `PRODUCTION_BATCH-YEAR` and the
 * database stores the batch upper-case; a lower-case link would otherwise resolve to
 * nothing and be reported as missing, which is a confusing way to say "wrong case".
 * Anything that still does not resolve comes back in `campaignsMissing`.
 */
function parseCampaigns(raw: Param): string[] {
  const v = first(raw);
  if (!v) return [];
  return [...new Set(v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, Param>>;
}) {
  const params = await searchParams;
  const lens = parseLens(params.lens);

  const options = await fetchOpsLedgerCampaignOptions();
  const requested = parseCampaigns(params.campaigns);
  // ── ABSENT `?campaigns=` → THE WHOLE LATEST QUARTER (2026-09-16) ─────────────
  // Renzo: *"It is not showing the current Q3 2026 group because it isn't complete
  // yet. It should show it and default to it since it is the latest. Quarters are
  // based on date, not on batch."* The old default was the single newest campaign,
  // which opened the EOQ tab on one month of a quarter the owner reads as a whole.
  //
  // The quarter comes from `view_ops_ledger_campaign_span.quarter_key` — the
  // MIDPOINT of each campaign's span — so this page does no date arithmetic and
  // cannot disagree with the picker's presets, which read the same field through
  // the same function. `latestQuarterKeys` returns the campaigns in their own
  // chronological order; the single-newest fallback survives only for the case
  // where no option carries a quarter at all.
  const defaultKeys = latestQuarterKeys(options);
  const keys =
    requested.length > 0
      ? requested
      : defaultKeys.length > 0
        ? defaultKeys
        : options[0]
          ? [options[0].key]
          : [];

  if (keys.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-[60ch] text-center text-sm text-muted-foreground">
          No production campaign has been recorded yet, so there is no ledger to draw. A
          campaign appears here as soon as the plant feeds or files a shift against a
          production batch.
        </p>
      </div>
    );
  }

  const data = await fetchOpsLedger(keys);

  if (data.campaigns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-[60ch] text-center text-sm text-muted-foreground">
          None of the requested campaigns resolved
          {data.campaignsMissing.length > 0 ? (
            <>
              {' '}
              (<span className="font-mono">{data.campaignsMissing.join(', ')}</span>)
            </>
          ) : null}
          . Open <span className="font-mono">/operations</span> with no query to read the
          latest quarter.
        </p>
      </div>
    );
  }

  return (
    <OperationsView
      data={data}
      options={options}
      // The keys the payload was actually resolved for, in the campaigns' own date
      // order — so the picker's chips and the ledger can never disagree about what
      // is in the group, even when the address carried a key nothing matched.
      selected={data.campaigns.map((c) => c.key)}
      lens={lens}
    />
  );
}
