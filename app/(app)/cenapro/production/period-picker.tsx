'use client';

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import type { CenaproPeriod } from './actions';

// ─── Cenapro Period Picker ──────────────────────────────────────────────────────
// A LOCAL Year + Batch picker for the production ledger toolbar. Mirrors the ICTC
// production picker, but Cenapro is a single page so it stays URL-driven (no shared
// cross-tab context): changing either select `router.replace`s `?year=&batch=`, which
// re-runs the server page and loads only the chosen period's rows. There is no
// "All periods" option — loading everything was the slow path this picker removes.
//
// `periods` arrives newest-first from the server. `selected` reflects the active
// period (already resolved by the page: an explicit URL param, else the newest).
interface CenaproPeriodPickerProps {
    periods: CenaproPeriod[];
    selected: CenaproPeriod | null;
    /** Disabled while the grid has unsaved edits (switching period would discard them). */
    disabled?: boolean;
    /** Hint shown (and used as the disabled title) when `disabled` blocks a switch. */
    disabledHint?: string;
}

export function CenaproPeriodPicker({ periods, selected, disabled, disabledHint }: CenaproPeriodPickerProps) {
    const router = useRouter();
    const pathname = usePathname();
    // Own the navigation transition so the toolbar can show a pending state while the
    // server re-fetches the new period's rows (the page then remounts the grid).
    const [isPending, startTransition] = React.useTransition();

    // Distinct years (newest-first — periods are already sorted, so first-seen order holds).
    const years = React.useMemo(() => {
        const seen = new Set<number>();
        const out: number[] = [];
        for (const p of periods) {
            if (!seen.has(p.batch_year)) {
                seen.add(p.batch_year);
                out.push(p.batch_year);
            }
        }
        return out;
    }, [periods]);

    // Batch (month) options for the selected year, newest-first (periods are pre-sorted).
    const batchOptions = React.useMemo(() => {
        if (selected == null) return [];
        return periods.filter((p) => p.batch_year === selected.batch_year).map((p) => p.batch);
    }, [periods, selected]);

    // Push a new (year, batch) to the URL → server re-fetch. When the year changes, snap
    // to that year's newest batch (the current batch may not exist in the new year).
    const go = React.useCallback(
        (year: number, batch: string) => {
            const sp = new URLSearchParams();
            sp.set('year', String(year));
            sp.set('batch', batch);
            startTransition(() => {
                router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
            });
        },
        [router, pathname],
    );

    const onYearChange = React.useCallback(
        (val: string) => {
            const nextYear = Number.parseInt(val, 10);
            if (!Number.isInteger(nextYear)) return;
            // Keep the same batch if that year has it; else the year's newest batch.
            const inYear = periods.filter((p) => p.batch_year === nextYear);
            const keep = selected && inYear.some((p) => p.batch === selected.batch)
                ? selected.batch
                : inYear[0]?.batch;
            if (keep) go(nextYear, keep);
        },
        [periods, selected, go],
    );

    const onBatchChange = React.useCallback(
        (val: string) => {
            if (selected) go(selected.batch_year, val);
        },
        [selected, go],
    );

    // No periods at all (empty dataset) — render disabled placeholders so the toolbar
    // layout is stable and the operator sees there's simply nothing to scope.
    const noData = periods.length === 0;
    const locked = Boolean(disabled) || noData || isPending;

    return (
        <div
            className="flex items-center gap-1.5"
            title={disabled ? disabledHint : undefined}
        >
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Period
            </span>
            {/* Year */}
            <Select
                value={selected ? String(selected.batch_year) : undefined}
                onValueChange={onYearChange}
                disabled={locked}
            >
                <SelectTrigger
                    size="sm"
                    className="h-6 w-[78px] gap-1 border-border/60 bg-background px-2 font-mono text-[11px] hover:bg-muted/50"
                >
                    <SelectValue placeholder="Year" />
                </SelectTrigger>
                <SelectContent className="font-mono text-xs">
                    {years.map((y) => (
                        <SelectItem key={y} value={String(y)} className="text-[11px]">
                            {y}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {/* Batch (month) */}
            <Select
                value={selected ? selected.batch : undefined}
                onValueChange={onBatchChange}
                disabled={locked}
            >
                <SelectTrigger
                    size="sm"
                    className="h-6 w-[120px] gap-1 border-border/60 bg-background px-2 font-mono text-[11px] hover:bg-muted/50"
                >
                    <SelectValue placeholder="Batch" />
                </SelectTrigger>
                <SelectContent className="font-mono text-xs">
                    {batchOptions.map((b) => (
                        <SelectItem key={b} value={b} className="text-[11px]">
                            {b}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
    );
}
