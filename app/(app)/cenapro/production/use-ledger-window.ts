'use client';

import * as React from 'react';
import {
    fetchLedgerPage,
    type LedgerAnchor,
    type LedgerCursor,
} from './actions';
import type { ProductionEventRow } from '../types';
import type { LedgerFilters } from './ledger-url';
import { errorToast } from '@/lib/toast';

// ─── useLedgerWindow ─────────────────────────────────────────────────────────────
// A self-contained, bidirectional keyset pager for the endless production sheet — the
// repo does NOT use TanStack Query, and adding a global QueryClientProvider for one
// surface isn't justified, so this hook models the bits of `useInfiniteQuery` we need:
// a flat, oldest-first `rows` window, `fetchOlder()` / `fetchNewer()`, `hasOlder` /
// `hasNewer`, per-direction loading flags, and `reset(anchor)` for a fresh jump.
//
// The window is SEEDED from a server-prefetched initial page (passed as props) so the
// very first paint is already anchored — the dropdown period picker is a jump-to input
// BEFORE the first query, never a "load from the beginning then teleport". Cursors are
// derived from the first/last row of the current window (canonical order recv_date ASC,
// id ASC). Fetches are guarded per-direction against concurrent/exhausted calls.
//
// The hook OWNS react-virtuoso's `firstItemIndex` so that a prepend and its matching
// index decrement land in the SAME synchronous state batch (one render). If the two
// updates split across renders, virtuoso would briefly see prepended rows without the
// index shift → a one-frame scroll jump. Keeping both in `fetchOlder` avoids that.

// A large seed for firstItemIndex — decremented by the prepended count on each backward
// fetch (react-virtuoso's prepend-anchor mechanism; keeps the viewport pinned).
const FIRST_ITEM_BASE = 100_000;

export interface InitialLedgerPage {
    rows: ProductionEventRow[];
    hasOlder: boolean;
    hasNewer: boolean;
    notice?: string;
}

export interface LedgerWindow {
    rows: ProductionEventRow[];
    /** react-virtuoso prepend anchor — pass straight to <TableVirtuoso firstItemIndex>. */
    firstItemIndex: number;
    hasOlder: boolean;
    hasNewer: boolean;
    loadingOlder: boolean;
    loadingNewer: boolean;
    notice?: string;
    /** Loads the page before the window (prepends + decrements firstItemIndex atomically). */
    fetchOlder: () => Promise<void>;
    /** Loads the page after the window (appends). */
    fetchNewer: () => Promise<void>;
    /** Drops the window and re-seeds from a fresh anchor (used for a manual jump). */
    reset: (anchor: LedgerAnchor) => Promise<void>;
    /**
     * Pulls EVERY row newer than the current tail into the window (append-only, looping
     * past the `hasNewer` guard). Used AFTER a Save so freshly-committed rows appear at
     * the bottom of the client-held window without a full reload — `revalidatePath`
     * refreshes only the server tree, not this in-memory pager. No-op-safe; if the
     * window is somehow empty it re-seeds from `latest`.
     */
    refreshNewest: () => Promise<void>;
    /**
     * Re-pulls the CURRENTLY-loaded window fresh from the server, keeping the viewport
     * near the current top. Used AFTER a Save that touched COMMITTED rows (inline edits
     * / deletes) — those can live on ANY loaded page, and a recv_date edit can even
     * relocate a row in canonical order, so an append-only `refreshNewest` isn't enough.
     * Re-seeds from the current top row's period anchor (falls back to `latest`), then
     * re-paginates forward to restore the prior loaded depth. Crash-safe: it's a fresh
     * server read, never an in-memory merge of stale overlays, so a relocated/vanished
     * row simply lands in its new spot (or falls outside the window) without corrupting
     * the pager. Re-seeds from `latest` if the window is empty.
     */
    refreshWindow: () => Promise<void>;
}

function cursorFrom(row: ProductionEventRow): LedgerCursor {
    return { recv_date: row.recv_date ?? '', id: row.id ?? '' };
}

/**
 * @param initial  Server-prefetched first page (already filtered when filters are active).
 * @param filters  The active column filters. They are applied SERVER-SIDE by
 *   `fetchLedgerPage`, so every page this hook pulls — older, newer, reset, refresh — must
 *   carry them or the keyset walk would silently drift back to unfiltered history. Held in
 *   a ref so the stable callbacks below never need to re-bind.
 */
export function useLedgerWindow(initial: InitialLedgerPage, filters?: LedgerFilters): LedgerWindow {
    const [rows, setRows] = React.useState<ProductionEventRow[]>(initial.rows);
    const filtersRef = React.useRef(filters);
    filtersRef.current = filters;
    const [firstItemIndex, setFirstItemIndex] = React.useState(FIRST_ITEM_BASE);
    const [hasOlder, setHasOlder] = React.useState(initial.hasOlder);
    const [hasNewer, setHasNewer] = React.useState(initial.hasNewer);
    const [loadingOlder, setLoadingOlder] = React.useState(false);
    const [loadingNewer, setLoadingNewer] = React.useState(false);
    const [notice, setNotice] = React.useState<string | undefined>(initial.notice);

    // Refs mirror state so the stable callbacks read fresh values without re-binding
    // (and so the concurrent-fetch guard flips synchronously, before React re-renders).
    const rowsRef = React.useRef(rows);
    rowsRef.current = rows;
    const hasOlderRef = React.useRef(hasOlder);
    hasOlderRef.current = hasOlder;
    const hasNewerRef = React.useRef(hasNewer);
    hasNewerRef.current = hasNewer;
    const loadingOlderRef = React.useRef(false);
    const loadingNewerRef = React.useRef(false);

    const fetchOlder = React.useCallback(async (): Promise<void> => {
        // Ignore if already loading this direction, exhausted, or the window is empty.
        if (loadingOlderRef.current || !hasOlderRef.current) return;
        const current = rowsRef.current;
        if (current.length === 0) return;

        loadingOlderRef.current = true;
        setLoadingOlder(true);
        try {
            const page = await fetchLedgerPage({
                mode: 'cursor',
                cursor: cursorFrom(current[0]),
                direction: 'older',
                filters: filtersRef.current,
            });
            if (page.error) {
                errorToast(page.error);
                setHasOlder(false); // stop hammering a failing edge
                return;
            }
            // Strict keyset can't overlap, but de-dup defensively so React keys stay unique.
            const existing = new Set(rowsRef.current.map((r) => r.id ?? ''));
            const fresh = page.rows.filter((r) => !existing.has(r.id ?? ''));
            if (fresh.length > 0) {
                // Prepend AND decrement firstItemIndex in the SAME batch — this is what
                // keeps the viewport pinned (no one-frame jump) as older rows load above.
                setRows((prev) => [...fresh, ...prev]);
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
        const current = rowsRef.current;
        if (current.length === 0) return;

        loadingNewerRef.current = true;
        setLoadingNewer(true);
        try {
            const page = await fetchLedgerPage({
                mode: 'cursor',
                cursor: cursorFrom(current[current.length - 1]),
                direction: 'newer',
                filters: filtersRef.current,
            });
            if (page.error) {
                errorToast(page.error);
                setHasNewer(false);
                return;
            }
            const existing = new Set(rowsRef.current.map((r) => r.id ?? ''));
            const fresh = page.rows.filter((r) => !existing.has(r.id ?? ''));
            if (fresh.length > 0) setRows((prev) => [...prev, ...fresh]);
            setHasNewer(page.hasNewer);
        } finally {
            loadingNewerRef.current = false;
            setLoadingNewer(false);
        }
    }, []);

    const reset = React.useCallback(async (anchor: LedgerAnchor): Promise<void> => {
        // Block both edges while re-seeding.
        loadingOlderRef.current = true;
        loadingNewerRef.current = true;
        setLoadingOlder(true);
        setLoadingNewer(true);
        try {
            const page = await fetchLedgerPage({ mode: 'anchor', anchor, filters: filtersRef.current });
            if (page.error) {
                errorToast(page.error);
                return;
            }
            setRows(page.rows);
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

    const refreshNewest = React.useCallback(async (): Promise<void> => {
        const seed = rowsRef.current;
        // Empty window (e.g. a jumped-to empty period that was then filled) → re-seed.
        if (seed.length === 0) {
            await reset({ kind: 'latest' });
            return;
        }
        if (loadingNewerRef.current) return;

        loadingNewerRef.current = true;
        setLoadingNewer(true);
        try {
            // Walk forward from the current tail with a LOCAL cursor (setRows is batched,
            // so rowsRef won't update mid-loop — advance the cursor off each fetched page
            // instead). De-dup against the live window + everything collected this pass.
            const existing = new Set(seed.map((r) => r.id ?? ''));
            let cursor = cursorFrom(seed[seed.length - 1]);
            const collected: ProductionEventRow[] = [];
            let lastHasNewer = false;

            // Bounded loop — a handful of pages at most for a normal Save. The guard caps
            // a pathological run so a bug can never spin forever.
            for (let guard = 0; guard < 50; guard++) {
                const page = await fetchLedgerPage({
                    mode: 'cursor',
                    cursor,
                    direction: 'newer',
                    filters: filtersRef.current,
                });
                if (page.error) {
                    errorToast(page.error);
                    break;
                }
                for (const r of page.rows) {
                    const id = r.id ?? '';
                    if (!existing.has(id)) {
                        existing.add(id);
                        collected.push(r);
                    }
                }
                lastHasNewer = page.hasNewer;
                if (page.rows.length > 0) cursor = cursorFrom(page.rows[page.rows.length - 1]);
                if (!page.hasNewer) break;
            }

            if (collected.length > 0) setRows((prev) => [...prev, ...collected]);
            setHasNewer(lastHasNewer);
        } finally {
            loadingNewerRef.current = false;
            setLoadingNewer(false);
        }
    }, [reset]);

    const refreshWindow = React.useCallback(async (): Promise<void> => {
        const seed = rowsRef.current;
        if (seed.length === 0) {
            await reset({ kind: 'latest' });
            return;
        }
        // Anchor the fresh read on the current top row's period so the viewport stays
        // near where the operator was editing (rather than teleporting to global latest).
        const top = seed[0];
        const targetCount = seed.length;
        const anchor: LedgerAnchor =
            top.batch && top.batch_year != null
                ? { kind: 'period', batch_year: Number(top.batch_year), batch: top.batch }
                : { kind: 'latest' };

        // Block both edges while re-seeding.
        loadingOlderRef.current = true;
        loadingNewerRef.current = true;
        setLoadingOlder(true);
        setLoadingNewer(true);
        try {
            const firstPage = await fetchLedgerPage({ mode: 'anchor', anchor, filters: filtersRef.current });
            if (firstPage.error) {
                errorToast(firstPage.error);
                return;
            }
            const seen = new Set<string>();
            const all: ProductionEventRow[] = [];
            for (const r of firstPage.rows) {
                const id = r.id ?? '';
                if (!seen.has(id)) {
                    seen.add(id);
                    all.push(r);
                }
            }
            const hasOlderLocal = firstPage.hasOlder;
            let hasNewerLocal = firstPage.hasNewer;

            // Restore the prior loaded depth so scrolling isn't stuck on a single page.
            // Bounded (guard) so a pathological run can never spin forever.
            for (let guard = 0; guard < 50 && all.length < targetCount && hasNewerLocal; guard++) {
                const page = await fetchLedgerPage({
                    mode: 'cursor',
                    cursor: cursorFrom(all[all.length - 1]),
                    direction: 'newer',
                    filters: filtersRef.current,
                });
                if (page.error) {
                    errorToast(page.error);
                    break;
                }
                for (const r of page.rows) {
                    const id = r.id ?? '';
                    if (!seen.has(id)) {
                        seen.add(id);
                        all.push(r);
                    }
                }
                hasNewerLocal = page.hasNewer;
            }

            setRows(all);
            setFirstItemIndex(FIRST_ITEM_BASE);
            setHasOlder(hasOlderLocal);
            setHasNewer(hasNewerLocal);
        } finally {
            loadingOlderRef.current = false;
            loadingNewerRef.current = false;
            setLoadingOlder(false);
            setLoadingNewer(false);
        }
    }, [reset]);

    return {
        rows,
        firstItemIndex,
        hasOlder,
        hasNewer,
        loadingOlder,
        loadingNewer,
        notice,
        fetchOlder,
        fetchNewer,
        reset,
        refreshNewest,
        refreshWindow,
    };
}
