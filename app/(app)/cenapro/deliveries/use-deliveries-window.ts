'use client';

import * as React from 'react';

import { errorToast } from '@/lib/toast';
import { fetchDeliveryPage, type DeliveryAnchor } from './actions';
import { cursorFrom, type DeliveryRecord } from './types';
import type { DeliveryLens } from './ledger-url';

// ─── useDeliveriesWindow ─────────────────────────────────────────────────────────
//
// A self-contained bidirectional keyset pager for the endless RC Deliveries sheet —
// the same instrument as `production/use-ledger-window.ts`, and for the same reason:
// the repo does not use TanStack Query, and standing up a global QueryClientProvider
// for one surface isn't justified. It models the parts of `useInfiniteQuery` this
// screen needs — a flat, oldest-first `records` window, `fetchOlder` / `fetchNewer`,
// `hasOlder` / `hasNewer`, per-direction loading flags, and `reset(anchor)`.
//
// The window is SEEDED from a server-prefetched first page, so the very first paint is
// already anchored: the month picker is a jump-to input BEFORE any client query, never
// a "load from the beginning, then teleport".
//
// The hook OWNS react-virtuoso's `firstItemIndex` so a prepend and its matching index
// decrement land in the SAME synchronous state batch. Split across two renders,
// virtuoso would briefly see prepended rows without the index shift — a one-frame
// scroll jump. Keeping both inside `fetchOlder` is what avoids it.

/** Seed for `firstItemIndex`, decremented by each backward page's row count. */
const FIRST_ITEM_BASE = 100_000;

export interface InitialDeliveryPage {
    records: DeliveryRecord[];
    hasOlder: boolean;
    hasNewer: boolean;
    /** How many receipts the lens+filters match in total — NOT how many are loaded. */
    totalCount?: number | null;
    notice?: string;
}

export interface DeliveriesWindow {
    records: DeliveryRecord[];
    /** Pass straight to `<TableVirtuoso firstItemIndex>`. */
    firstItemIndex: number;
    hasOlder: boolean;
    hasNewer: boolean;
    loadingOlder: boolean;
    loadingNewer: boolean;
    /**
     * The size of the MATCHING set, from the server's own `count`. Held separately from
     * `records.length`, which is only ever the loaded window — a filtered ledger that
     * reported the window as the total would be exactly the lie this whole feature is
     * built to avoid.
     */
    totalCount: number | null;
    notice?: string;
    fetchOlder: () => Promise<void>;
    fetchNewer: () => Promise<void>;
    reset: (anchor: DeliveryAnchor) => Promise<void>;
    /**
     * Re-pull the CURRENTLY-loaded window fresh from the server after a save. Inline
     * edits land on committed rows that can live on ANY loaded page, and a date edit can
     * even relocate a row in canonical order — so an append-only refresh isn't enough.
     * A fresh server read, never an in-memory merge of stale overlays: a relocated row
     * simply lands in its new spot without corrupting the pager.
     */
    refreshWindow: () => Promise<void>;
    /** Splice one receipt OUT of the window after a confirmed delete. */
    dropRecord: (id: string) => void;
}

export function useDeliveriesWindow(
    initial: InitialDeliveryPage,
    lens: DeliveryLens,
): DeliveriesWindow {
    const [records, setRecords] = React.useState<DeliveryRecord[]>(initial.records);
    const [firstItemIndex, setFirstItemIndex] = React.useState(FIRST_ITEM_BASE);
    const [hasOlder, setHasOlder] = React.useState(initial.hasOlder);
    const [hasNewer, setHasNewer] = React.useState(initial.hasNewer);
    const [loadingOlder, setLoadingOlder] = React.useState(false);
    const [loadingNewer, setLoadingNewer] = React.useState(false);
    const [totalCount, setTotalCount] = React.useState<number | null>(initial.totalCount ?? null);
    const [notice, setNotice] = React.useState<string | undefined>(initial.notice);

    // The lens — the data-quality cut, the free-text search AND the per-column filters —
    // is applied SERVER-SIDE, so every page this hook pulls must carry the whole bundle
    // or the keyset walk would silently drift back to unfiltered history halfway down
    // the sheet. Held in a ref so the stable callbacks below never need to re-bind.
    const lensRef = React.useRef(lens);
    lensRef.current = lens;

    // Refs mirror state so the callbacks read fresh values without re-binding, and so
    // the concurrent-fetch guard flips synchronously, before React re-renders.
    const recordsRef = React.useRef(records);
    recordsRef.current = records;
    const hasOlderRef = React.useRef(hasOlder);
    hasOlderRef.current = hasOlder;
    const hasNewerRef = React.useRef(hasNewer);
    hasNewerRef.current = hasNewer;
    const loadingOlderRef = React.useRef(false);
    const loadingNewerRef = React.useRef(false);

    const fetchOlder = React.useCallback(async (): Promise<void> => {
        if (loadingOlderRef.current || !hasOlderRef.current) return;
        const current = recordsRef.current;
        if (current.length === 0) return;

        loadingOlderRef.current = true;
        setLoadingOlder(true);
        try {
            const page = await fetchDeliveryPage({
                mode: 'cursor',
                cursor: cursorFrom(current[0].row),
                direction: 'older',
                issue: lensRef.current.issue,
                query: lensRef.current.query,
                filters: lensRef.current.filters,
            });
            if (page.error) {
                errorToast(page.error);
                setHasOlder(false); // stop hammering a failing edge
                return;
            }
            // Strict keyset can't overlap, but de-dup defensively so React keys stay unique.
            const existing = new Set(recordsRef.current.map((r) => r.row.id ?? ''));
            const fresh = page.records.filter((r) => !existing.has(r.row.id ?? ''));
            if (fresh.length > 0) {
                // Prepend AND decrement in the SAME batch — this is what pins the viewport.
                setRecords((prev) => [...fresh, ...prev]);
                setFirstItemIndex((prev) => prev - fresh.length);
            }
            setHasOlder(page.hasOlder);
        } finally {
            loadingOlderRef.current = false;
            setLoadingOlder(false);
        }
    }, []);

    const fetchNewer = React.useCallback(async (): Promise<void> => {
        if (loadingNewerRef.current || !hasNewerRef.current) return;
        const current = recordsRef.current;
        if (current.length === 0) return;

        loadingNewerRef.current = true;
        setLoadingNewer(true);
        try {
            const page = await fetchDeliveryPage({
                mode: 'cursor',
                cursor: cursorFrom(current[current.length - 1].row),
                direction: 'newer',
                issue: lensRef.current.issue,
                query: lensRef.current.query,
                filters: lensRef.current.filters,
            });
            if (page.error) {
                errorToast(page.error);
                setHasNewer(false);
                return;
            }
            const existing = new Set(recordsRef.current.map((r) => r.row.id ?? ''));
            const fresh = page.records.filter((r) => !existing.has(r.row.id ?? ''));
            if (fresh.length > 0) setRecords((prev) => [...prev, ...fresh]);
            setHasNewer(page.hasNewer);
        } finally {
            loadingNewerRef.current = false;
            setLoadingNewer(false);
        }
    }, []);

    const reset = React.useCallback(async (anchor: DeliveryAnchor): Promise<void> => {
        loadingOlderRef.current = true;
        loadingNewerRef.current = true;
        setLoadingOlder(true);
        setLoadingNewer(true);
        try {
            const page = await fetchDeliveryPage({
                mode: 'anchor',
                anchor,
                issue: lensRef.current.issue,
                query: lensRef.current.query,
                filters: lensRef.current.filters,
            });
            if (page.error) {
                errorToast(page.error);
                return;
            }
            setRecords(page.records);
            setFirstItemIndex(FIRST_ITEM_BASE);
            setHasOlder(page.hasOlder);
            setHasNewer(page.hasNewer);
            // An anchor fetch carries the server's own exact count; a cursor page does
            // not (it cannot change by scrolling), so `undefined` keeps the old number.
            if (page.totalCount !== undefined) setTotalCount(page.totalCount);
            setNotice(page.notice);
        } finally {
            loadingOlderRef.current = false;
            loadingNewerRef.current = false;
            setLoadingOlder(false);
            setLoadingNewer(false);
        }
    }, []);

    const refreshWindow = React.useCallback(async (): Promise<void> => {
        const seed = recordsRef.current;
        if (seed.length === 0) {
            await reset({ kind: 'latest' });
            return;
        }
        // Anchor the fresh read on the current TOP row's month so the viewport stays
        // near where the operator was editing, rather than teleporting to global latest.
        const top = seed[0].row;
        const targetCount = seed.length;
        const anchor: DeliveryAnchor = top.delivery_date
            ? {
                  kind: 'period',
                  year: Number(top.delivery_date.slice(0, 4)),
                  month: Number(top.delivery_date.slice(5, 7)),
              }
            : { kind: 'latest' };

        loadingOlderRef.current = true;
        loadingNewerRef.current = true;
        setLoadingOlder(true);
        setLoadingNewer(true);
        try {
            const firstPage = await fetchDeliveryPage({
                mode: 'anchor',
                anchor,
                issue: lensRef.current.issue,
                query: lensRef.current.query,
                filters: lensRef.current.filters,
            });
            if (firstPage.error) {
                errorToast(firstPage.error);
                return;
            }
            const seen = new Set<string>();
            const all: DeliveryRecord[] = [];
            for (const r of firstPage.records) {
                const id = r.row.id ?? '';
                if (seen.has(id)) continue;
                seen.add(id);
                all.push(r);
            }
            const hasOlderLocal = firstPage.hasOlder;
            let hasNewerLocal = firstPage.hasNewer;

            // Restore the prior loaded depth so scrolling isn't stuck on one page.
            // Bounded so a pathological run can never spin forever.
            for (let guard = 0; guard < 50 && all.length < targetCount && hasNewerLocal; guard++) {
                const page = await fetchDeliveryPage({
                    mode: 'cursor',
                    cursor: cursorFrom(all[all.length - 1].row),
                    direction: 'newer',
                    issue: lensRef.current.issue,
                    query: lensRef.current.query,
                    filters: lensRef.current.filters,
                });
                if (page.error) {
                    errorToast(page.error);
                    break;
                }
                for (const r of page.records) {
                    const id = r.row.id ?? '';
                    if (seen.has(id)) continue;
                    seen.add(id);
                    all.push(r);
                }
                hasNewerLocal = page.hasNewer;
            }

            setRecords(all);
            setFirstItemIndex(FIRST_ITEM_BASE);
            setHasOlder(hasOlderLocal);
            setHasNewer(hasNewerLocal);
            if (firstPage.totalCount !== undefined) setTotalCount(firstPage.totalCount);
        } finally {
            loadingOlderRef.current = false;
            loadingNewerRef.current = false;
            setLoadingOlder(false);
            setLoadingNewer(false);
        }
    }, [reset]);

    const dropRecord = React.useCallback((id: string) => {
        setRecords((prev) => prev.filter((r) => (r.row.id ?? '') !== id));
        // The matching set really did shrink by one — a stale total would then over-count
        // the very row the operator just watched disappear.
        setTotalCount((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
    }, []);

    return {
        records,
        firstItemIndex,
        hasOlder,
        hasNewer,
        loadingOlder,
        loadingNewer,
        totalCount,
        notice,
        fetchOlder,
        fetchNewer,
        reset,
        refreshWindow,
        dropRecord,
    };
}
