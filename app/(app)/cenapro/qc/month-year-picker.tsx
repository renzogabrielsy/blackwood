'use client';

// ─────────────────────────────────────────────────────────────────────────────────
// MonthYearPicker — the shared `?m=YYYY-MM` control for both QC routes.
//
// Chosen over a ‹ › month stepper: stepping four months back to reach March is four
// round trips, and a stepper never shows you which months exist. Two dropdowns say it
// in one glance.
//
// CONTRACT: the URL param is exactly `?m=YYYY-MM`, shared by the QC Ledger and the QC
// Breakdown, so the cross-links between them carry the selected month across and any
// already-open tab keeps resolving to the same month.
//
// Year options come from the data. Month options are ALWAYS all twelve, with the empty
// ones `disabled`: a month that is simply absent is information (nothing was received),
// and hiding it would make the control's shape change under you as you switch years.
// ─────────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

const MONTH_NAMES = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
] as const;

export interface MonthYearPickerProps {
    /** The active month, `YYYY-MM`. */
    month: string;
    /** Every `YYYY-MM` present in the data, ascending. */
    availableMonths: readonly string[];
    /** Small caption to the left of the selects, e.g. `"Month"` / `"Daily focus"`. */
    label?: string;
}

export function MonthYearPicker({ month, availableMonths, label = 'Month' }: MonthYearPickerProps) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [isPending, startTransition] = React.useTransition();

    const year = month.slice(0, 4);
    const monthNum = month.slice(5, 7);

    /** Distinct years present in the data, NEWEST first (matches the period picker). */
    const years = React.useMemo(() => {
        const set = new Set<string>();
        for (const m of availableMonths) set.add(m.slice(0, 4));
        // The active year may be a `?m=` the data no longer covers — keep it selectable
        // so the trigger never renders an empty value.
        set.add(year);
        // The CURRENT year, always. On 1 January the newest year with receipts is last
        // year's, and without this the operator could not reach the month they need to
        // start typing into (2026-08-04).
        set.add(new Date().getFullYear().toString());
        return [...set].sort().reverse();
    }, [availableMonths, year]);

    /** `MM` values that actually carry data inside the selected year. */
    const monthsInYear = React.useMemo(() => {
        const set = new Set<string>();
        for (const m of availableMonths) {
            if (m.slice(0, 4) === year) set.add(m.slice(5, 7));
        }
        return set;
    }, [availableMonths, year]);

    /** Write `?m=`, preserving every other param the route may carry. */
    const go = React.useCallback(
        (next: string) => {
            if (next === month) return;
            const sp = new URLSearchParams(searchParams.toString());
            sp.set('m', next);
            startTransition(() => {
                router.push(`${pathname}?${sp.toString()}`, { scroll: false });
            });
        },
        [router, pathname, searchParams, month],
    );

    const onYearChange = React.useCallback(
        (nextYear: string) => {
            const inYear = availableMonths.filter((m) => m.slice(0, 4) === nextYear);
            // Prefer the same calendar month in the new year; else that year's newest;
            // else the same month anyway — an empty month is now a place you can go
            // (2026-08-04), so a year with no receipts is no longer a dead end.
            const sameMonth = inYear.find((m) => m.slice(5, 7) === monthNum);
            go(sameMonth ?? inYear[inYear.length - 1] ?? `${nextYear}-${monthNum}`);
        },
        [availableMonths, monthNum, go],
    );

    const onMonthChange = React.useCallback(
        (nextMonthNum: string) => go(`${year}-${nextMonthNum}`),
        [year, go],
    );

    return (
        <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {label}
            </span>

            <Select value={monthNum} onValueChange={onMonthChange} disabled={isPending}>
                <SelectTrigger
                    size="sm"
                    aria-label="Month"
                    className="h-7 w-[112px] gap-1 border-border/60 bg-background px-2 text-[11px] hover:bg-muted/50"
                >
                    <SelectValue placeholder="Month" />
                </SelectTrigger>
                <SelectContent>
                    {/* Every month is SELECTABLE (2026-08-04). An empty one used to be
                        `disabled`, which meant the first draw of a new month had nowhere
                        to land — you could not open the month you needed to type into.
                        The `· no data` suffix still says which months are empty, because
                        an absent month is information; it is just no longer a wall. */}
                    {MONTH_NAMES.map((name, index) => {
                        const mm = String(index + 1).padStart(2, '0');
                        const has = monthsInYear.has(mm);
                        return (
                            <SelectItem
                                key={mm}
                                value={mm}
                                className="text-[11px]"
                                title={
                                    has
                                        ? undefined
                                        : `No receipts in ${name} ${year} yet — open it to add the first`
                                }
                            >
                                {name}
                                {has ? '' : ' · no data'}
                            </SelectItem>
                        );
                    })}
                </SelectContent>
            </Select>

            <Select value={year} onValueChange={onYearChange} disabled={isPending}>
                <SelectTrigger
                    size="sm"
                    aria-label="Year"
                    className="h-7 w-[80px] gap-1 border-border/60 bg-background px-2 font-mono text-[11px] hover:bg-muted/50"
                >
                    <SelectValue placeholder="Year" />
                </SelectTrigger>
                <SelectContent className="font-mono">
                    {years.map((y) => (
                        <SelectItem key={y} value={y} className="text-[11px]">
                            {y}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {isPending ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /> : null}
        </div>
    );
}
