'use client';

import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { BlockingGrid } from './blocking-grid';
import {
    fetchBlockingGridData,
    fetchBlockingSupplierMap,
    fetchBlendProposalVersion,
    fetchBlendProposalVersions,
} from './actions';
import type {
    BlockingGridData,
    BlockingSupplierMap,
    BlendProposalVersionSummary,
    SavedBlendProposal,
} from './types';
import { errorToast } from '@/lib/toast';
import type { BlockingDetailNavTarget } from '../_shared/blocking-detail-panel';

/**
 * Standalone-route host for the Blocking grid (`/inventory/blocking`). Owns the same
 * fetch / loading / error / retry behavior the old `blocking-lazy-tab` had — but it is
 * SHELL-AGNOSTIC: it does NOT use `useInventoryTab` or depend on the tab system.
 *
 * Selection lives in the URL as `?block=<block_loc>` (deep-linkable, refresh-safe,
 * browser Back closes the panel). The grid is driven controlled-style from that param.
 * "Edit All" from the detail panel navigates via `router.push('/inventory?tab=…')`.
 *
 * PENDING UI: this route is dynamic, so writing `?block=` costs a server round-trip
 * (~1-3s) even though the grid data is already client-side — which meant a cell click
 * did NOTHING visible until the payload landed. The param write is wrapped in a
 * `useTransition` and the selection is mirrored in `useOptimistic`, so the cell
 * highlights and the detail panel open on the SAME frame as the click. React reverts
 * the optimistic value to the URL's once the navigation settles, so Back/refresh and
 * an abandoned navigation both stay correct.
 */
/** Stable empty map — used before the fetch lands and when the read fails. */
const EMPTY_SUPPLIER_MAP: BlockingSupplierMap = { suppliers: [], byBlock: {} };

export function BlockingRouteView() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [data, setData] = useState<BlockingGridData | null>(null);
    const [supplierMap, setSupplierMap] = useState<BlockingSupplierMap>(EMPTY_SUPPLIER_MAP);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const hasFetchedRef = useRef(false);

    const loadData = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            // PARALLEL — the supplier map is an independent read of a different view;
            // serializing it would add its round-trip to the grid's time-to-paint.
            const [result, suppliers] = await Promise.all([
                fetchBlockingGridData(),
                fetchBlockingSupplierMap(),
            ]);
            // The action returns empty blocks on failure — treat no-data as an error.
            if (Object.keys(result.blocks).length === 0) {
                setError(true);
            } else {
                setData(result);
                // A failed supplier read returns an empty map by contract — the grid
                // still works, the search just has nothing to suggest. Never fatal.
                setSupplierMap(suppliers);
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

    // ── URL-driven block selection (`?block=`), optimistically mirrored ──
    const urlBlock = searchParams.get('block');
    const [, startTransition] = useTransition();
    const [selectedBlock, setOptimisticBlock] = useOptimistic(urlBlock);

    const writeBlockParam = useCallback(
        (block: string | null) => {
            const params = new URLSearchParams(searchParams.toString());
            if (block) params.set('block', block);
            else params.delete('block');
            const qs = params.toString();
            startTransition(() => {
                setOptimisticBlock(block);
                router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
            });
        },
        [router, pathname, searchParams, setOptimisticBlock],
    );

    // ── URL-driven supplier spotlight (`?supplier=<canonical key>`) ──
    // Same shape as `?block=` above, and for the same reason: this route is dynamic, so
    // a bare `router.replace` would leave the grid un-highlighted for the length of a
    // server round-trip after the operator hits Enter. Deep-linkable + refresh-safe.
    const urlSupplier = searchParams.get('supplier');
    const [selectedSupplier, setOptimisticSupplier] = useOptimistic(urlSupplier);

    const handleSupplierChange = useCallback(
        (supplier: string | null) => {
            const params = new URLSearchParams(searchParams.toString());
            if (supplier) params.set('supplier', supplier);
            else params.delete('supplier');
            const qs = params.toString();
            startTransition(() => {
                setOptimisticSupplier(supplier);
                router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
            });
        },
        [router, pathname, searchParams, setOptimisticSupplier],
    );

    // ── URL-driven SAVED blend proposal (`?proposal=<id>&v=<n>`) ──
    // Same shape again, with one difference: `proposal` and `v` are written TOGETHER, so
    // switching proposals can never leave a version number from the previous one behind
    // (which would ask the server for a version that does not exist on this proposal).
    const urlProposal = searchParams.get('proposal');
    const urlVersionRaw = searchParams.get('v');
    const [selectedProposal, setOptimisticProposal] = useOptimistic(urlProposal);
    const [selectedVersion, setOptimisticVersion] = useOptimistic(urlVersionRaw);

    const handleProposalLinkChange = useCallback(
        (proposalId: string | null, versionNo?: number | null) => {
            const params = new URLSearchParams(searchParams.toString());
            if (proposalId) params.set('proposal', proposalId);
            else params.delete('proposal');
            if (proposalId && versionNo != null) params.set('v', String(versionNo));
            else params.delete('v');
            const qs = params.toString();
            startTransition(() => {
                setOptimisticProposal(proposalId);
                setOptimisticVersion(proposalId && versionNo != null ? String(versionNo) : null);
                router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
            });
        },
        [router, pathname, searchParams, setOptimisticProposal, setOptimisticVersion],
    );

    // A junk `?v=` is treated as ABSENT (open the current version instead) rather than as
    // version 0 — a deep link someone hand-edited should still show something.
    const parsedVersion = selectedVersion === null ? null : Number.parseInt(selectedVersion, 10);
    const proposalVersion =
        parsedVersion !== null && Number.isFinite(parsedVersion) && parsedVersion > 0 ? parsedVersion : null;

    // ── Resolving `?proposal=&v=` into a saved version ──
    // The route owns the params, so the route owns turning them into data — the same
    // division `?block=` and the supplier map already follow. It keeps the grid a
    // component that RENDERS a saved proposal rather than one that goes and finds it.
    const [savedProposal, setSavedProposal] = useState<SavedBlendProposal | null>(null);
    const [savedVersions, setSavedVersions] = useState<BlendProposalVersionSummary[]>([]);
    const [savedLoading, setSavedLoading] = useState(false);

    // The writer lives in a ref, NOT in the effect's deps: it is rebuilt whenever ANY
    // search param moves, so depending on it would refetch the proposal every time an
    // unrelated param changed.
    const proposalLinkRef = useRef(handleProposalLinkChange);
    useEffect(() => {
        proposalLinkRef.current = handleProposalLinkChange;
    }, [handleProposalLinkChange]);

    useEffect(() => {
        if (!selectedProposal) {
            setSavedProposal(null);
            setSavedVersions([]);
            return;
        }
        let cancelled = false;
        (async () => {
            setSavedLoading(true);
            try {
                // Versions first: they are the rail AND the fallback when `?v=` is absent.
                const versions = await fetchBlendProposalVersions(selectedProposal);
                if (cancelled) return;
                const target =
                    proposalVersion ??
                    versions.find((v) => v.isCurrent)?.versionNo ??
                    (versions.length ? Math.max(...versions.map((v) => v.versionNo)) : 1);
                // THE ONE price-bearing read in the feature — gated server-side.
                const res = await fetchBlendProposalVersion(selectedProposal, target);
                if (cancelled) return;
                if (!res.ok) {
                    errorToast('Could not open that proposal', { description: res.message });
                    proposalLinkRef.current(null);
                    return;
                }
                setSavedVersions(versions);
                setSavedProposal(res.proposal);
            } finally {
                if (!cancelled) setSavedLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selectedProposal, proposalVersion]);

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
                supplierMap={supplierMap}
                supplierFilter={selectedSupplier}
                onSupplierFilterChange={handleSupplierChange}
                proposalId={selectedProposal}
                savedProposal={savedProposal}
                savedVersions={savedVersions}
                savedLoading={savedLoading}
                onProposalLinkChange={handleProposalLinkChange}
            />
        </div>
    );
}
