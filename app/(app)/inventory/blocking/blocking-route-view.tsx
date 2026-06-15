'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { BlockingGrid } from './blocking-grid';
import { fetchBlockingGridData } from './actions';
import type { BlockingGridData } from './types';
import type { BlockingDetailNavTarget } from '../_shared/blocking-detail-panel';

/**
 * Standalone-route host for the Blocking grid (`/inventory/blocking`). Owns the same
 * fetch / loading / error / retry behavior the old `blocking-lazy-tab` had — but it is
 * SHELL-AGNOSTIC: it does NOT use `useInventoryTab` or depend on the tab system.
 *
 * Selection lives in the URL as `?block=<block_loc>` (deep-linkable, refresh-safe,
 * browser Back closes the panel). The grid is driven controlled-style from that param.
 * "Edit All" from the detail panel navigates via `router.push('/inventory?tab=…')`.
 */
export function BlockingRouteView() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [data, setData] = useState<BlockingGridData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const hasFetchedRef = useRef(false);

    const loadData = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const result = await fetchBlockingGridData();
            // The action returns empty blocks on failure — treat no-data as an error.
            if (Object.keys(result.blocks).length === 0) {
                setError(true);
            } else {
                setData(result);
                hasFetchedRef.current = true;
            }
        } catch {
            setError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasFetchedRef.current) return;
        loadData();
    }, [loadData]);

    // ── URL-driven block selection (`?block=`) ──
    const selectedBlock = searchParams.get('block');

    const writeBlockParam = useCallback(
        (block: string | null) => {
            const params = new URLSearchParams(searchParams.toString());
            if (block) params.set('block', block);
            else params.delete('block');
            const qs = params.toString();
            router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
        },
        [router, pathname, searchParams],
    );

    // Toggle semantics: clicking the open block clears it; clicking another switches.
    const handleSelectBlock = useCallback(
        (locKey: string) => {
            writeBlockParam(selectedBlock === locKey ? null : locKey);
        },
        [selectedBlock, writeBlockParam],
    );

    // "Edit All" → deep-link into the logs page on the right tab + batch search.
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

    if (loading) {
        return (
            <div className="h-full w-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="h-full w-full flex flex-col items-center justify-center gap-3">
                <p className="text-sm text-muted-foreground">Failed to load blocking data.</p>
                <button
                    onClick={loadData}
                    className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted/50 transition-colors"
                >
                    Retry
                </button>
            </div>
        );
    }

    return (
        <div className="h-full w-full overflow-y-auto">
            <BlockingGrid
                data={data.blocks}
                canViewPrices={data.canViewPrices}
                selectedLocKey={selectedBlock}
                onSelectBlock={handleSelectBlock}
                onNavigateToBatch={handleNavigateToBatch}
            />
        </div>
    );
}
