'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { RcOutGridV2 } from '../rc-out/rc-out-grid-v2';
import { fetchRcOutTabData } from '../rc-out/actions';
import { errorToast } from '@/lib/toast';
import type { RcOutRow } from '@/types/rc-out';
import type { PeriodMonth, PeriodYear } from '@/lib/table';

// ─────────────────────────────────────────────────────────────────────────────────
// The `?grid=v2` twin of `rc-out-lazy-tab.tsx`, mounting `RcOutGridV2`.
//
// It exists because RC OUT's rows do NOT arrive as props: unlike RC IN, whose payload is
// fetched by the server `page.tsx`, the Usage tab loads itself on first render through
// `fetchRcOutTabData()`. That action is READ-ONLY — it selects `rc_out`, resolves the
// canonical `lib/auth.canViewPrices()` gate and nulls `avg_price` / `avg_wtd_value` before
// the payload leaves the server — and it is the SAME call the live tab makes, not a second
// query written for this grid.
//
// A separate file rather than a flag on the existing one: `rc-out-lazy-tab.tsx` is on the
// production path and this migration does not edit it.
// ─────────────────────────────────────────────────────────────────────────────────

type Batch = {
    id: string;
    batch_code: string;
    location_ref: string;
};

interface RcOutTabData {
    records: RcOutRow[];
    batches: Batch[];
    destinations: string[];
    batchOptions: string[];
    yearOptions: number[];
    blockLocs: string[];
    /**
     * The canonical server-side price gate. The ₱ fields in `records` are ALREADY nulled
     * server-side when this is false; the flag drives the conditional render so what is
     * shown can never drift from what was sent.
     */
    canViewPrices: boolean;
}

export interface RcOutLazyTabV2Props {
    /**
     * The RESOLVED period the whole screen is showing, handed down from `page.tsx`.
     *
     * **This tab's fetch is NOT year-scoped** — `fetchRcOutTabData()` paginates every
     * `rc_out` row there has ever been, which is how it derives its own `yearOptions` —
     * so unlike RC IN, the year narrows here on the CLIENT too, not just the month. It is
     * a cut of a payload that was fetched either way, so picking a period costs no round
     * trip and the tab keeps loading exactly once.
     */
    periodYear: PeriodYear;
    periodMonth: PeriodMonth;
}

export function RcOutLazyTabV2({ periodYear, periodMonth }: RcOutLazyTabV2Props) {
    const [data, setData] = useState<RcOutTabData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    // Guards the initial-mount fetch against StrictMode double-invoke / re-mounts once we
    // already have good data.
    const hasFetchedRef = useRef(false);

    const loadData = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            const result = await fetchRcOutTabData();
            setData(result);
            hasFetchedRef.current = true;
        } catch (err) {
            setError(true);
            errorToast('Failed to load Usage data.', {
                description: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasFetchedRef.current) return;
        loadData();
    }, [loadData]);

    if (loading) {
        return (
            <div className="flex h-full w-full items-center justify-center">
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (error || !data) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                <p className="text-sm text-muted-foreground">Failed to load Usage data.</p>
                <button
                    onClick={loadData}
                    className="rounded border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted/50"
                >
                    Retry
                </button>
            </div>
        );
    }

    return (
        <RcOutGridV2
            data={data.records}
            batches={data.batches}
            destinations={data.destinations}
            batchOptions={data.batchOptions}
            yearOptions={data.yearOptions}
            blockLocs={data.blockLocs}
            canViewPrices={data.canViewPrices}
            periodYear={periodYear}
            periodMonth={periodMonth}
        />
    );
}
