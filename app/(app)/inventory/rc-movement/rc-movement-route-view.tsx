'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
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

    useEffect(() => {
        let mounted = true;
        fetchRcMovementMatrix(campaignParam || undefined).then((result) => {
            if (mounted) {
                setData(result);
                setLoading(false);
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
            router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
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

    return (
        <RcMovementMatrix
            data={data}
            onCampaignChange={handleCampaignChange}
            onNavigateToBatch={handleNavigateToBatch}
        />
    );
}
