'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RcMovementMatrix } from './rc-movement-matrix';
import { fetchRcMovementMatrix, type RcMovementMatrix as RcMovementMatrixData } from './actions';
import type { BlockingDetailNavTarget } from '../_shared/blocking-detail-panel';

/**
 * Standalone-route host for the RC Movement matrix (`/inventory/rc-movement`). Repurposes
 * the old `rc-movement-matrix-lazy-tab` fetch + `?campaign=` URL logic, but is
 * SHELL-AGNOSTIC — it does NOT depend on the inventory tab system.
 *
 * The selected production campaign is driven by `?campaign=` (encoded key
 * "PRODUCTION_BATCH-YEAR", e.g. "JUNE-2026"). Absent param → the action resolves the most
 * recent campaign; the resolved value comes back on `data.campaign`. Switching the picker
 * writes the param (replace, no reload) and re-fetches.
 *
 * "Edit All" from the detail panel navigates via `router.push('/inventory?tab=…')` — wired
 * explicitly here since there's no in-shell tab provider listening on this route.
 */
export function RcMovementRouteView() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    // URL is the source of truth for the campaign. '' (absent) => server resolves default.
    const campaignParam = searchParams.get('campaign') ?? '';

    const [data, setData] = useState<RcMovementMatrixData | null>(null);
    // `loading` starts true and only ever flips to false after the first fetch resolves.
    // The spinner condition below also requires `!data`, so a campaign-change re-fetch
    // (data already present) never re-shows the spinner — meaning we don't need to set
    // loading back to true synchronously in the effect (which would trip
    // react-hooks/set-state-in-effect). The matrix just swaps to the new campaign's data.
    const [loading, setLoading] = useState(true);

    // Switching campaign is TWO waits stacked: the `?campaign=` write re-runs the
    // (dynamic) server page, then the effect below re-fetches the matrix via the
    // action. Neither showed anything, so the toolbar looked dead for seconds and
    // then the whole grid swapped. `isPending` covers the navigation half;
    // `switching` covers the action half (set on click, cleared when the rows land).
    // Together they dim the outgoing matrix and float a spinner over it.
    const [isPending, startTransition] = useTransition();
    const [switching, setSwitching] = useState(false);

    useEffect(() => {
        let mounted = true;
        fetchRcMovementMatrix(campaignParam || undefined).then((result) => {
            if (mounted) {
                setData(result);
                setLoading(false);
                setSwitching(false);
            }
        });
        return () => {
            mounted = false;
        };
    }, [campaignParam]);

    const handleCampaignChange = useCallback(
        (campaign: string) => {
            const params = new URLSearchParams(searchParams.toString());
            if (campaign) params.set('campaign', campaign);
            else params.delete('campaign');
            const qs = params.toString();
            setSwitching(true);
            startTransition(() => {
                router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
            });
        },
        [router, pathname, searchParams],
    );

    // `editView` discriminates WHICH always-mounted table consumes `editBatch`: on
    // /inventory both the Deliveries and Usage tables read `?editBatch=`, so without it
    // the first to run strips the param and the wrong editor opens. Pass it alongside.
    const handleNavigateToBatch = useCallback(
        (target: BlockingDetailNavTarget) => {
            const tab = target.view === 'usage' ? 'usage' : 'deliveries';
            router.push(
                `/inventory?tab=${tab}&search=${encodeURIComponent(target.batchCode)}&year=all&editBatch=${encodeURIComponent(target.batchCode)}&editView=${tab}`,
            );
        },
        [router],
    );

    if (loading && !data) {
        return (
            <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (!data) {
        return (
            <div className="h-full w-full flex items-center justify-center">
                <p className="text-sm text-muted-foreground">Failed to load movement data.</p>
            </div>
        );
    }

    // Compositor-only feedback (opacity + a spinner overlay) — the matrix stays
    // mounted and laid out, so nothing reflows and no row animates.
    const busy = isPending || switching;

    return (
        <div className="relative h-full w-full">
            <div
                aria-busy={busy}
                className={cn(
                    'h-full w-full transition-opacity duration-150',
                    busy && 'pointer-events-none opacity-50',
                )}
            >
                <RcMovementMatrix
                    data={data}
                    onCampaignChange={handleCampaignChange}
                    onNavigateToBatch={handleNavigateToBatch}
                />
            </div>
            {busy && (
                <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-24">
                    <div className="flex items-center gap-2 rounded-md border border-border bg-background/95 px-3 py-1.5 shadow-sm backdrop-blur supports-backdrop-filter:bg-background/60">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Loading campaign…</span>
                    </div>
                </div>
            )}
        </div>
    );
}
