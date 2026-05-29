'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { fetchAvailablePeriods } from '../daily/actions';

// ─── Types ───────────────────────────────────────────────────────────────────
export interface AvailablePeriods {
    years: number[];
    batchesByYear: Record<number, string[]>;
}

interface ProductionPeriodContextType {
    /** Selected year. null = "All Years". */
    year: number | null;
    /** Selected batch (uppercase month name). null = "All Batches". */
    batch: string | null;
    /** Distinct years + per-year batch options, or null until loaded. */
    availablePeriods: AvailablePeriods | null;
    /** True until availablePeriods + the default period have resolved. */
    periodsLoading: boolean;
    /** Update the shared period and sync URL params (?y=&b=). */
    setPeriod: (year: number | null, batch: string | null) => void;
}

const ProductionPeriodContext = createContext<ProductionPeriodContextType | null>(null);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function syncUrl(year: number | null, batch: string | null) {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    params.set('y', year == null ? 'all' : String(year));
    params.set('b', batch == null ? 'all' : batch);
    const qs = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
}

/** Parse a year URL param. Returns undefined if absent, null for "all", a number if valid. */
function parseYearParam(raw: string | null): number | null | undefined {
    if (raw == null) return undefined;
    if (raw === 'all') return null;
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 2010 && n <= 2100) return n;
    return undefined;
}

/** Parse a batch URL param. Returns undefined if absent, null for "all", the trimmed string otherwise. */
function parseBatchParam(raw: string | null): string | null | undefined {
    if (raw == null) return undefined;
    if (raw === 'all') return null;
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
}

// ─── Provider ────────────────────────────────────────────────────────────────
export function ProductionPeriodProvider({ children }: { children: ReactNode }) {
    const now = new Date();

    // Initialize from URL synchronously so the very first render already reflects
    // the requested period (avoids a flash of the default before the effect runs).
    const initial = (() => {
        if (typeof window === 'undefined') {
            return { year: now.getFullYear() as number | null, batch: null as string | null };
        }
        const params = new URLSearchParams(window.location.search);
        const y = parseYearParam(params.get('y'));
        const b = parseBatchParam(params.get('b'));
        return {
            year: y === undefined ? now.getFullYear() : y,
            // batch default is resolved after periods load; only honor an explicit URL value here
            batch: b === undefined ? null : b,
        };
    })();

    const [year, setYear] = useState<number | null>(initial.year);
    const [batch, setBatch] = useState<string | null>(initial.batch);
    const [availablePeriods, setAvailablePeriods] = useState<AvailablePeriods | null>(null);
    const [periodsLoading, setPeriodsLoading] = useState(true);
    const periodsRequestedRef = useRef(false);

    // Fetch available periods once on mount; resolve a sensible default batch
    // (current month's batch for the current year, if present) ONLY when the URL
    // did not already specify one.
    useEffect(() => {
        if (periodsRequestedRef.current) return;
        periodsRequestedRef.current = true;

        // Whether the URL explicitly set y/b — captured before any async work.
        const params = new URLSearchParams(window.location.search);
        const urlHadYear = params.get('y') != null;
        const urlHadBatch = params.get('b') != null;

        fetchAvailablePeriods()
            .then(result => {
                if (result.data) {
                    setAvailablePeriods(result.data);

                    // Resolve default period only when neither param was supplied.
                    if (!urlHadYear && !urlHadBatch) {
                        const currentYear = now.getFullYear();
                        const batches = result.data.batchesByYear[currentYear] ?? [];
                        const currentMonthName = now
                            .toLocaleString('en-US', { month: 'long' })
                            .toUpperCase();
                        const matched =
                            batches.find(b => b === currentMonthName) ??
                            (batches.length > 0 ? batches[batches.length - 1] : null);
                        if (matched) {
                            setBatch(matched);
                            syncUrl(currentYear, matched);
                        }
                    }
                }
            })
            .finally(() => setPeriodsLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const setPeriod = useCallback((nextYear: number | null, nextBatch: string | null) => {
        setYear(nextYear);
        setBatch(nextBatch);
        syncUrl(nextYear, nextBatch);
    }, []);

    return (
        <ProductionPeriodContext.Provider
            value={{ year, batch, availablePeriods, periodsLoading, setPeriod }}
        >
            {children}
        </ProductionPeriodContext.Provider>
    );
}

export function useProductionPeriod() {
    const ctx = useContext(ProductionPeriodContext);
    if (!ctx) {
        throw new Error('useProductionPeriod must be used within ProductionPeriodProvider');
    }
    return ctx;
}
