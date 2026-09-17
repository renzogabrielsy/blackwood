'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';
import { fetchRcMovementMatrix } from '../inventory/rc-movement/actions';
import type { RcMovementMatrix as RcMovementMatrixData } from '../inventory/rc-movement/actions';
import { ActualPriceToggle } from '../inventory/rc-movement/actual-price-toggle';
import type { BlockingDetailNavTarget } from '../inventory/_shared/blocking-detail-panel';
import { OPS_MODAL_MAX_WIDTH, opsModalWidth } from './ops-modal-size';

// ═════════════════════════════════════════════════════════════════════════════════
// RC FED OPENS THE RC MOVEMENT MATRIX — the unification thesis, made clickable.
//
// Renzo, 2026-09-16: *"RC Fed should pop up to a modal of RC movement. I don't know
// how you would make it efficient and not heavy for the page, but rendering the RC
// Movement table in a modal based on which campaign RC Fed you click just makes so
// much sense."*
//
// It does, and this module's CONTEXT.md has said so since the day it shipped: this
// screen and `/inventory/rc-movement` are **one screen showing two column groups
// over the same row spine** — `view_ops_ledger_day_block` *is*
// `view_rc_movement_campaign_cells`, re-keyed. The ledger's RC FED cell is the Σ of
// exactly the cells that matrix prints. Clicking it opens them.
//
// ── THE MATRIX IS NOT FORKED, NOT COPIED AND NOT RE-IMPLEMENTED ────────────────
// `RcMovementMatrix` (the Classic matrix) turned out to be embeddable **as it
// stands**: its props are `{ data, onCampaignChange?, onNavigateToBatch? }` and it
// calls no `useRouter`, no `usePathname` and no `useSearchParams` — every route
// concern lives in `rc-movement-route-view.tsx`, which is its HOST, not part of it.
// So this file is a second host. Not one character of the matrix is edited.
//
// (The v2 Blackwood-Table grid, `rc-movement-grid-v2.tsx`, is NOT embeddable: it
// takes the page's `searchParams` and writes `?campaign=` with `router.replace`, so
// inside a modal on `/operations` it would rewrite THIS page's address. The Classic
// matrix is the smaller, cleaner embeddable surface, which is why it is the one
// used.)
//
// ── THREE THINGS THAT KEEP IT OFF THE `/operations` CRITICAL PATH ──────────────
//
//  1. **The component is `next/dynamic` with `ssr: false`**, so ~100 KB of matrix
//     is a chunk that is fetched on the FIRST click and never before. `/operations`
//     first-load JS is unchanged by this feature.
//  2. **The data is fetched ON DEMAND**, by calling the SAME server action the RC
//     Movement page calls — `fetchRcMovementMatrix(campaignKey)`. The ops payload is
//     not enlarged by one field, and the two screens cannot disagree about a
//     campaign's cells because they read one query.
//  3. **Each campaign is fetched ONCE.** The reply is cached per key for the life of
//     the dialog, so the GROUP row's campaign tabs switch instantly after the first
//     visit to each.
//
// ── ₱ ──────────────────────────────────────────────────────────────────────────
// Nothing is gated HERE and nothing needs to be. `fetchRcMovementMatrix` resolves the
// canonical `canViewPrices()` itself and nulls every ₱ field before returning — and
// goes further for the three ACTUAL FED ₱/kg views, which it does not query at all
// for a denied caller. The matrix then drops its `Fed ₱/kg` column from the frozen
// pane's coordinate space. This host passes the payload straight through, so a
// Production reader gets byte-identically what `/inventory/rc-movement` gives them.
// ═════════════════════════════════════════════════════════════════════════════════

/**
 * THE MATRIX, LAZILY. `ssr: false` because it is a client-only, scroll-measuring
 * grid that no server render can usefully produce — and because that is what keeps
 * its chunk out of the route's first load.
 */
const RcMovementMatrix = dynamic(
  () => import('../inventory/rc-movement/rc-movement-matrix').then((m) => m.RcMovementMatrix),
  {
    ssr: false,
    loading: () => <MatrixPending label="Loading the matrix…" />,
  },
);

function MatrixPending({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center gap-2">
      <Loader2 className="size-4 animate-spin text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** One campaign the modal can show, with the RC FED figures the strip published. */
export interface OpsRcCampaignTab {
  /** `JULY-2026` — identical on both screens, so no translation exists to get wrong. */
  key: string;
  label: string;
  /**
   * `RC Fed = Σ MAIN feedings · 781.2 t · 24 feed days · 19 blocks` — assembled by
   * the strip from PUBLISHED rollup fields. Nothing here computes it.
   */
  note: string;
}

export interface OpsRcMovementModalProps {
  title: string;
  /** One entry for a campaign cell; the group's campaigns for the GROUP row. */
  campaigns: readonly OpsRcCampaignTab[];
  initialKey: string;
  /** The GROUP's own RC FED line, printed above the tabs. Absent on a campaign cell. */
  groupNote?: string;
  onClose(): void;
}

export function OpsRcMovementModal({
  title,
  campaigns,
  initialKey,
  groupNote,
  onClose,
}: OpsRcMovementModalProps) {
  const router = useRouter();
  const [key, setKey] = React.useState(initialKey);
  const [cache, setCache] = React.useState<Record<string, RcMovementMatrixData>>({});
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);
  // ── THE `Actual ₱` SWITCH — LOCAL STATE, NOT THE URL (2026-09-17) ─────────────
  // `/operations`' address describes which CAMPAIGNS and which LENS the ledger is
  // showing; a disclosure inside one dialog over one campaign's matrix is the same
  // category as the expanded day and the block drawer, both of which this screen
  // deliberately keeps out of the address. Writing it would also re-run the server
  // page to change nothing the server computes. It is deliberately NOT reset when
  // the campaign tab changes: a reader who asked to see actual prices asked about
  // the report, not about one month.
  const [showActualPrice, setShowActualPrice] = React.useState(false);

  const data = cache[key];

  // ON DEMAND, ONCE PER CAMPAIGN. `cache` is in the dependency list and the first
  // line is the guard, so the `setCache` that ends a fetch re-runs this effect
  // exactly once more and it returns immediately.
  React.useEffect(() => {
    if (cache[key] || failed === key) return;
    let live = true;
    setLoading(true);
    fetchRcMovementMatrix(key)
      .then((result) => {
        if (!live) return;
        setCache((c) => ({ ...c, [key]: result }));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoading(false);
        setFailed(key);
        // The project's HARD RULE on errors: persistent, copyable.
        errorToast(`Could not load the RC Movement matrix for ${key}.`, {
          description: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      live = false;
    };
  }, [key, cache, failed]);

  const retry = React.useCallback(() => setFailed(null), []);

  /**
   * "Edit All" from the block drawer INSIDE the matrix. `/operations` mounts no
   * inventory tab provider (neither does `/inventory/rc-movement`), so the deep
   * link is pushed explicitly — the same four params, in the same order, as
   * `operations-view.tsx` and `rc-movement-route-view.tsx` both use.
   */
  const handleNavigateToBatch = React.useCallback(
    (target: BlockingDetailNavTarget) => {
      const tab = target.view === 'usage' ? 'usage' : 'deliveries';
      onClose();
      router.push(
        `/inventory?tab=${tab}&search=${encodeURIComponent(target.batchCode)}&year=all&editBatch=${encodeURIComponent(target.batchCode)}&editView=${tab}`,
      );
    },
    [router, onClose],
  );

  const active = campaigns.find((c) => c.key === key) ?? campaigns[0];

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className={cn(
          'flex flex-col gap-2 overflow-hidden p-4 transition-none sm:p-5',
          // ── OPAQUE, NOT GLASS — AND IT IS NOT A STYLE PREFERENCE ─────────────
          // `backdrop-filter` (the `backdrop-blur-xl` in the canonical dialog
          // glass) makes an element the CONTAINING BLOCK for every `position:
          // fixed` descendant. The matrix renders `BlockingDetailPanel`, a fixed
          // slide-over that is NOT portalled — so with the glass on, clicking a
          // block header pinned the drawer to the dialog box instead of the
          // viewport: measured at 1920×1080 it landed at x=1299 · right=1819 ·
          // y=44 instead of flush right and full height. Opaque, it is exactly the
          // viewport. Nothing is lost: at 1720×92vh this surface covers the screen,
          // so there was no ground showing through to frost, and `DialogOverlay`
          // still supplies the dimmed, blurred backdrop behind it.
          'bg-background backdrop-blur-none supports-[backdrop-filter]:bg-background',
        )}
        style={{
          ...opsModalWidth(OPS_MODAL_MAX_WIDTH),
          // ── CENTRED WITHOUT A TRANSFORM, FOR THE SAME REASON ────────────────
          // A transform is the OTHER way to become that containing block, so the
          // primitive's `translate(-50%,-50%)` centring has to go too. `inset: 0` +
          // `margin: auto` over a definite width and height centres identically
          // and leaves `transform: none`.
          inset: 0,
          margin: 'auto',
          transform: 'none',
          translate: 'none',
          // ── AND NO ENTRANCE ANIMATION, WHICH IS THE THIRD WAY IN ────────────
          // `animate-in ... zoom-in-95` has only a `from` keyframe, so under its
          // fill mode the browser can HOLD `scale3d(.95)` after the animation ends
          // — measured: the drawer came back 494×1026 at x=1776 (0.95 of 520×1080,
          // pushed off-screen) even with `transform: none` in this very style
          // attribute, because a running or filled animation outranks inline
          // styles. `animation: none` stops the keyframes existing at all, so the
          // inline reset is the only thing left to win. `filter` is reset for the
          // same reason `backdrop-filter` is: any value but `none` is a containing
          // block. The overlay keeps its own fade, so the dialog still arrives.
          animation: 'none',
          filter: 'none',
          height: '92vh',
          maxHeight: '92vh',
        }}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <span className="size-2 shrink-0 rounded-full bg-sky-500" />
            {title}
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px] tabular-nums">
            {groupNote ?? active?.note ?? ''}
          </DialogDescription>
        </DialogHeader>

        {/* ── The campaign switcher. ONE TAB PER CAMPAIGN IN THE GROUP ─────────
            Three matrices at once would be three tall grids fighting for one
            viewport; a group reads one campaign at a time, which is also the only
            grain the RC Movement views publish a matrix for. A single-campaign
            cell renders no tablist at all — a tab strip of one is chrome. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
        {campaigns.length > 1 ? (
          <div
            role="tablist"
            aria-label="Campaign"
            className="flex shrink-0 flex-wrap items-center gap-0.5 rounded-md border border-input bg-muted/50 p-0.5"
          >
            {campaigns.map((c) => (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={c.key === key}
                title={c.note}
                onClick={() => setKey(c.key)}
                className={cn(
                  'flex h-7 items-center gap-1.5 whitespace-nowrap rounded px-2.5 text-xs font-medium transition-colors duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  c.key === key
                    ? 'bg-sky-100 text-sky-900 shadow-sm dark:bg-sky-950 dark:text-sky-200'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full bg-sky-500 transition-opacity duration-150',
                    c.key === key ? 'opacity-100' : 'opacity-40',
                  )}
                />
                {c.label}
              </button>
            ))}
          </div>
        ) : null}

        {/* THE `Actual ₱` SWITCH, beside the campaign tabs — the SAME component the
            RC Movement route renders in the matrix's own toolbar, so the two
            surfaces cannot drift. The matrix here is given no
            `onShowActualPriceChange`, so it renders no second control of its own.
            ABSENT for a price-denied payload: `fetchRcMovementMatrix` does not even
            query the actual-price views for that reader, so there is nothing to
            reveal and a disabled switch would claim otherwise. */}
        {data?.canViewPrices ? (
          <ActualPriceToggle value={showActualPrice} onChange={setShowActualPrice} />
        ) : null}
        </div>

        {/* The active campaign's own RC FED line — always visible, even on the
            GROUP view where the header carries the group's. */}
        {campaigns.length > 1 && active ? (
          <p className="shrink-0 font-mono text-[11px] tabular-nums text-sky-700 dark:text-sky-300">
            {active.note}
          </p>
        ) : null}

        {/* ── The matrix. The only flexible child; it owns its own scrolling. ── */}
        <div className="min-h-0 flex-auto">
          {data ? (
            <RcMovementMatrix
              data={data}
              onNavigateToBatch={handleNavigateToBatch}
              showActualPrice={showActualPrice}
            />
          ) : failed === key ? (
            // A failed fetch keeps the dialog open with a persistent, copyable
            // surface — the toast above — plus a retry, never an empty frame.
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
              <p className="max-w-[60ch] text-xs text-muted-foreground">
                The RC Movement matrix for{' '}
                <span className="font-mono">{active?.label ?? key}</span> could not be loaded.
                The error was copied into a toast you can paste.
              </p>
              <button
                type="button"
                onClick={retry}
                className="rounded-md border border-input px-2.5 py-1 text-xs font-medium transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Retry
              </button>
            </div>
          ) : (
            <MatrixPending label={loading ? 'Loading the matrix…' : 'Preparing…'} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
