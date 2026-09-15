'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight, Info, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { OpsCampaignOption, OpsLedgerData } from '@/lib/operations/types';
import { fetchBlockDataForBatch } from '../inventory/blocking/actions';
import type { BlockData } from '../inventory/blocking/types';
import {
  BlockingDetailPanel,
  type BlockingDetailNavTarget,
} from '../inventory/_shared/blocking-detail-panel';
import { TONE } from './ops-color';
import { DEFAULT_LENS, OPS_LENSES, lensSpec, type OpsLensId } from './ops-lens';
import { OpsGroupPicker } from './ops-group-picker';
import { OpsKpiStrip } from './ops-kpi-strip';
import { OpsLedgerTable } from './ops-ledger-table';

// ═════════════════════════════════════════════════════════════════════════════════
// `/operations` — the client half. It owns the CONTROLS and the block drawer; the
// server page owns the data and the ₱ gate.
//
// ── THE URL IS THE STATE ───────────────────────────────────────────────────────
// `?campaigns=` (comma-separated campaign keys, chronological) and `?lens=` are
// written with `router.replace`, so the server page re-reads and the payload comes
// back already folded — no client fetch, no second copy of the resolution logic, and
// a link to a quarter under a particular lens opens on the same figures for whoever
// receives it. That is CLAUDE.md's "URL search params drive filters and navigation
// state", and it is why the campaign switch dims the sheet rather than spinning: the
// outgoing ledger stays mounted and laid out while the new one resolves.
//
// THE LEDGER IS **ONE TABLE WITH ONE SCROLLBAR** (2026-09-15). The two scroll-synced
// panes, the draggable divider and the phone pane toggle are gone; the day spine is
// now a block of FROZEN COLUMNS inside the same `<table>` as the lens. See the header
// comment in `ops-ledger-table.tsx`.
//
// THE EXPANDED DAY IS DELIBERATELY **NOT** IN THE URL. It is a disclosure inside one
// reading of one payload — the same category as the block drawer, which RC Movement
// also keeps in local state — and putting it in the address would re-run the server
// on every chevron click to change nothing the server computes.
// ═════════════════════════════════════════════════════════════════════════════════

export interface OperationsViewProps {
  data: OpsLedgerData;
  options: readonly OpsCampaignOption[];
  /** The campaign keys the server actually resolved the payload for. */
  selected: string[];
  lens: OpsLensId;
}

export function OperationsView({ data, options, selected, lens }: OperationsViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = React.useTransition();

  const writeParams = React.useCallback(
    (patch: { campaigns?: string[]; lens?: OpsLensId }) => {
      const params = new URLSearchParams(searchParams.toString());
      if (patch.campaigns) params.set('campaigns', patch.campaigns.join(','));
      if (patch.lens) {
        // The default lens is spelled as ABSENCE, so the plain address stays clean
        // and the param's presence always means something.
        if (patch.lens === DEFAULT_LENS) params.delete('lens');
        else params.set('lens', patch.lens);
      }
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [router, pathname, searchParams, startTransition],
  );

  // ── The block drawer, opened OPTIMISTICALLY ────────────────────────────────
  // Same contract the digest's Open Blocks band uses: set the key on the click
  // frame, show the skeleton, guard the reply against staleness, and on failure
  // keep the drawer open with a persistent copyable banner (the project's HARD RULE
  // on error surfaces) rather than an empty panel.
  const [blockKey, setBlockKey] = React.useState<string | null>(null);
  const [blockData, setBlockData] = React.useState<BlockData | null>(null);
  const [blockLoading, setBlockLoading] = React.useState(false);
  const [blockError, setBlockError] = React.useState<string | null>(null);
  const [blockPrices, setBlockPrices] = React.useState(false);
  const pendingBatch = React.useRef<string | null>(null);

  const loadBlock = React.useCallback((batchId: string) => {
    pendingBatch.current = batchId;
    setBlockLoading(true);
    setBlockError(null);
    setBlockData(null);
    fetchBlockDataForBatch(batchId)
      .then((result) => {
        if (pendingBatch.current !== batchId) return; // a later click already won
        if (!result.blockData) {
          setBlockError(`No block record resolved for batch id ${batchId}.`);
        } else {
          setBlockData(result.blockData);
        }
        setBlockPrices(result.canViewPrices);
        setBlockLoading(false);
      })
      .catch((err: unknown) => {
        if (pendingBatch.current !== batchId) return;
        setBlockError(
          err instanceof Error ? err.message : `Failed to load batch id ${batchId}.`,
        );
        setBlockLoading(false);
      });
  }, []);

  const handleOpenBlock = React.useCallback(
    (batchId: string, batchCode: string, blockLoc: string | null) => {
      // The panel's header badge shows the block_loc when there is one, else the
      // batch code — FEED columns have no loc, and `parseLocKey` tolerates both.
      setBlockKey(blockLoc ?? batchCode);
      loadBlock(batchId);
    },
    [loadBlock],
  );

  const handleCloseBlock = React.useCallback(() => {
    pendingBatch.current = null;
    setBlockKey(null);
    setBlockData(null);
    setBlockError(null);
    setBlockLoading(false);
  }, []);

  // "Edit All" from the drawer. There is no inventory tab provider on this route,
  // so the push is wired explicitly — exactly as `/inventory/rc-movement` does it.
  const handleNavigateToBatch = React.useCallback(
    (target: BlockingDetailNavTarget) => {
      const tab = target.view === 'usage' ? 'usage' : 'deliveries';
      router.push(
        `/inventory?tab=${tab}&search=${encodeURIComponent(target.batchCode)}&year=all&editBatch=${encodeURIComponent(target.batchCode)}&editView=${tab}`,
      );
    },
    [router],
  );

  const [rollupOpen, setRollupOpen] = React.useState(true);
  const spec = lensSpec(lens);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Controls ──────────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <OpsGroupPicker
            options={options}
            selected={selected}
            onChange={(next) => writeParams({ campaigns: next })}
            disabled={isPending}
          />

          <div className="ml-auto flex items-center gap-2">
            {isPending ? (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Loading…
              </span>
            ) : null}
            <div
              role="tablist"
              aria-label="Lens"
              className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-input bg-muted/50 p-0.5"
            >
              {OPS_LENSES.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="tab"
                  aria-selected={l.id === lens}
                  onClick={() => writeParams({ lens: l.id })}
                  title={l.hint}
                  className={cn(
                    'flex h-7 items-center gap-1.5 whitespace-nowrap rounded px-2.5 text-xs font-medium transition-colors duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    // The tab carries the same hue its columns are drawn in, so the
                    // control and the sheet below it say the same thing.
                    l.id === lens
                      ? cn(TONE[l.tone].head, 'shadow-sm')
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full transition-opacity duration-150',
                      TONE[l.tone].dot,
                      l.id === lens ? 'opacity-100' : 'opacity-40',
                    )}
                  />
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="max-w-[92ch] text-[11px] leading-snug text-muted-foreground">
          {spec.hint}
        </p>

        {data.campaignsMissing.length > 0 ? (
          // NOT an error — the group RPC reports unknown keys rather than dropping
          // them, so a mistyped or retired key is said out loud and the rest of the
          // group still renders.
          <p className="flex items-start gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
            <Info className="mt-px size-3.5 shrink-0" />
            <span>
              No campaign matched{' '}
              <span className="font-mono">{data.campaignsMissing.join(', ')}</span> — those keys
              were ignored and everything below covers the {data.campaigns.length} campaign
              {data.campaigns.length === 1 ? '' : 's'} that did resolve.
            </span>
          </p>
        ) : null}
      </div>

      {/* ── The EOQ rollup ────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-border px-3 py-2 sm:px-4">
        <button
          type="button"
          onClick={() => setRollupOpen((v) => !v)}
          aria-expanded={rollupOpen}
          className="mb-1.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {rollupOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          EOQ rollup
          {!rollupOpen ? (
            <span className="ml-1 font-normal normal-case text-muted-foreground/70">
              {data.rollups.length} campaign{data.rollups.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </button>
        {rollupOpen ? (
          <OpsKpiStrip
            rollups={data.rollups}
            group={data.group}
            canViewPrices={data.canViewPrices}
          />
        ) : null}
      </div>

      {/* ── The ledger ────────────────────────────────────────────────────────── */}
      <div
        aria-busy={isPending}
        className={cn(
          'flex min-h-0 flex-1 flex-col transition-opacity duration-150',
          isPending && 'pointer-events-none opacity-50',
        )}
      >
        <OpsLedgerTable data={data} lens={lens} onOpenBlock={handleOpenBlock} />
      </div>

      <BlockingDetailPanel
        locKey={blockKey}
        blockData={blockData}
        loading={blockLoading}
        error={blockError}
        onRetry={() => {
          if (pendingBatch.current) loadBlock(pendingBatch.current);
        }}
        onClose={handleCloseBlock}
        canViewPrices={blockPrices}
        onNavigateToBatch={handleNavigateToBatch}
      />
    </div>
  );
}
