'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { RcMovementMatrix } from '../rc-movement/rc-movement-matrix';
import { fetchRcMovementMatrix, type RcMovementMatrix as RcMovementMatrixData } from '../rc-movement/actions';

/**
 * Lazy-mounting host for the RC Movement MATRIX inside the inventory tab system.
 *
 * Owns the selected production CAMPAIGN, driven by the `?campaign=` URL search param
 * (per the project's search-param convention, mirroring the RC IN table). The param
 * value is the encoded campaign key "PRODUCTION_BATCH-YEAR" (e.g. "JUNE-2026").
 *
 * When the param is absent the first fetch lets the server action resolve its default
 * (the most recent campaign); the resolved value comes back on `data.campaign` and the
 * toolbar Select reflects it. Picking a campaign writes the param via `router.replace`
 * (scroll-preserving, no page reload) which re-runs the effect and re-fetches.
 *
 * Mirrors the rc-out-lazy-tab pattern: fetch on first render, show a spinner while
 * loading, and stay mounted so tab switches preserve state.
 */
export function RcMovementMatrixLazyTab() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    // The URL is the source of truth for the selected campaign. '' (param absent)
    // => server action resolves the default (most recent) campaign.
    const campaignParam = searchParams.get('campaign') ?? '';

    const [data, setData] = useState<RcMovementMatrixData | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let mounted = true;
        setLoading(true);
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

    return <RcMovementMatrix data={data} onCampaignChange={handleCampaignChange} />;
}
