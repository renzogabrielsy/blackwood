'use client';

import * as React from 'react';
import { fetchDailyPivotWindow, type LedgerAnchor } from './actions';
import type { PlantView } from './production-sources';
import type { ProductionEventRow } from '../types';
import { errorToast } from '@/lib/toast';

// ─── useDailyPivotWindow ─────────────────────────────────────────────────────────
// The day-granular sibling of `useLedgerWindow`. Where the ledger pager accumulates a
// flat, oldest-first ROW window and anchors react-virtuoso's `firstItemIndex` in ROW
// units, this pager accumulates a flat, oldest-first EVENT window (`prod_date ASC` across
// loaded whole-day pages) and anchors `firstItemIndex` in DAY-BLOCK units — because the
// endless W6/W7 pivot renders one virtualized item PER PRODUCTION DAY, not per row.
//
// The renderer pivots the accumulated events with `buildDateGroups` into day-blocks; this
// hook only manages the event window + the day-block prepend anchor. Because the server
// paginates by WHOLE days and filters the plant source set SERVER-SIDE, every distinct
// `prod_date` in a fetched page yields exactly one rendered day-block — so a backward
// (older) fetch decrements `firstItemIndex` by the number of distinct prepended days, and
// the prepend + decrement land in the SAME synchronous batch (no one-frame scroll jump),
// exactly as the ledger pager does for rows.
//
// Seeded from a server-prefetched initial window so the first paint is already anchored at
// the selected period / newest days — the dropdown is a jump-to input, never a
// load-from-the-beginning-then-teleport.

const FIRST_ITEM_BASE = 100_000;

export interface InitialDailyPivotWindow {
    events: ProductionEventRow[];
    hasOlder: boolean;
    hasNewer: boolean;
    notice?: string;
}

export interface DailyPivotWindowState {
    /** Accumulated events, ALWAYS oldest-first (prod_date asc). Pivot these with buildDateGroups. */
    events: ProductionEventRow[];
    /** react-virtuoso prepend anchor in DAY-BLOCK units — pass to <TableVirtuoso firstItemIndex>. */
    firstItemIndex: number;
    hasOlder: boolean;
    hasNewer: boolean;
    loadingOlder: boolean;
    loadingNewer: boolean;
    notice?: string;
    /** Loads the whole-day page before the window (prepends events + decrements firstItemIndex by prepended DAYS). */
    fetchOlder: () => Promise<void>;
    /** Loads the whole-day page after the window (appends events). */
    fetchNewer: () => Promise<void>;
    /** Drops the window and re-seeds from a fresh anchor (used for a manual jump). */
    reset: (anchor: LedgerAnchor) => Promise<void>;
}

// Number of DISTINCT prod_dates in an event list = the number of day-blocks it produces
// (server pre-filters the plant source set, so every distinct day renders exactly one block).
function distinctDayCount(events: ProductionEventRow[]): number {
    const s = new Set<string>();
    for (const e of events) {
        const d = (e.prod_date ?? '').trim();
        if (d) s.add(d);
    }
    return s.size;
}

export function useDailyPivotWindow(
    initial: InitialDailyPivotWindow,
    plant: PlantView,
): DailyPivotWindowState {
    const [events, setEvents] = React.useState<ProductionEventRow[]>(initial.events);
    const [firstItemIndex, setFirstItemIndex] = React.useState(FIRST_ITEM_BASE);
    const [hasOlder, setHasOlder] = React.useState(initial.hasOlder);
    const [hasNewer, setHasNewer] = React.useState(initial.hasNewer);
    const [loadingOlder, setLoadingOlder] = React.useState(false);
    const [loadingNewer, setLoadingNewer] = React.useState(false);
    const [notice, setNotice] = React.useState<string | undefined>(initial.notice);

    // Refs mirror state so the stable callbacks read fresh values without re-binding, and
    // so the concurrent-fetch guard flips synchronously before React re-renders.
    const eventsRef = React.useRef(events);
    eventsRef.current = events;
    const hasOlderRef = React.useRef(hasOlder);
    hasOlderRef.current = hasOlder;
    const hasNewerRef = React.useRef(hasNewer);
    hasNewerRef.current = hasNewer;
    const loadingOlderRef = React.useRef(false);
    const loadingNewerRef = React.useRef(false);
    const plantRef = React.useRef(plant);
    plantRef.current = plant;

    const fetchOlder = React.useCallback(async (): Promise<void> => {
        if (loadingOlderRef.current || !hasOlderRef.current) return;
        const current = eventsRef.current;
        if (current.length === 0) return;
        // Oldest loaded prod_date = the day cursor to page strictly before.
        const cursor = (current[0].prod_date ?? '').trim();
        if (!cursor) return;

        loadingOlderRef.current = true;
        setLoadingOlder(true);
        try {
            const page = await fetchDailyPivotWindow({
                mode: 'cursor',
                cursor,
                direction: 'older',
                plant: plantRef.current,
            });
            if (page.error) {
                errorToast(page.error);
                setHasOlder(false);
                return;
            }
            const existing = new Set(eventsRef.current.map((e) => e.id ?? ''));
            const fresh = page.events.filter((e) => !existing.has(e.id ?? ''));
            if (fresh.length > 0) {
                // Prepend events AND decrement firstItemIndex by the number of prepended
                // DAY-BLOCKS in the SAME batch — keeps the viewport pinned (no jump).
                const newDays = distinctDayCount(fresh);
                setEvents((prev) => [...fresh, ...prev]);
                setFirstItemIndex((prev) => prev - newDays);
            }
            setHasOlder(page.hasOlder);
        } finally {
            loadingOlderRef.current = false;
            setLoadingOlder(false);
        }
    }, []);

    const fetchNewer = React.useCallback(async (): Promise<void> => {
        if (loadingNewerRef.current || !hasNewerRef.current) return;
        const current = eventsRef.current;
        if (current.length === 0) return;
        // Newest loaded prod_date = the day cursor to page strictly after.
        const cursor = (current[current.length - 1].prod_date ?? '').trim();
        if (!cursor) return;

        loadingNewerRef.current = true;
        setLoadingNewer(true);
        try {
            const page = await fetchDailyPivotWindow({
                mode: 'cursor',
                cursor,
                direction: 'newer',
                plant: plantRef.current,
            });
            if (page.error) {
                errorToast(page.error);
                setHasNewer(false);
                return;
            }
            const existing = new Set(eventsRef.current.map((e) => e.id ?? ''));
            const fresh = page.events.filter((e) => !existing.has(e.id ?? ''));
            if (fresh.length > 0) setEvents((prev) => [...prev, ...fresh]);
            setHasNewer(page.hasNewer);
        } finally {
            loadingNewerRef.current = false;
            setLoadingNewer(false);
        }
    }, []);

    const reset = React.useCallback(async (anchor: LedgerAnchor): Promise<void> => {
        loadingOlderRef.current = true;
        loadingNewerRef.current = true;
        setLoadingOlder(true);
        setLoadingNewer(true);
        try {
            const page = await fetchDailyPivotWindow({ mode: 'anchor', anchor, plant: plantRef.current });
            if (page.error) {
                errorToast(page.error);
                return;
            }
            setEvents(page.events);
            setFirstItemIndex(FIRST_ITEM_BASE);
            setHasOlder(page.hasOlder);
            setHasNewer(page.hasNewer);
            setNotice(page.notice);
        } finally {
            loadingOlderRef.current = false;
            loadingNewerRef.current = false;
            setLoadingOlder(false);
            setLoadingNewer(false);
        }
    }, []);

    return {
        events,
        firstItemIndex,
        hasOlder,
        hasNewer,
        loadingOlder,
        loadingNewer,
        notice,
        fetchOlder,
        fetchNewer,
        reset,
    };
}
