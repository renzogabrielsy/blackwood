'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

import { PERIOD_ALL, periodHref } from '@/lib/table';
import type { PeriodMonth, PeriodSelection, PeriodYear } from '@/lib/table';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────────
// PeriodPicker — a Year dropdown and a Month dropdown, writing `?year=` + `?month=`.
// PLATFORM LAYER.
//
// The chrome the module has owed since Stage 1B, where it was listed as deferred
// (`lib/table/CONTEXT.md` → "Not built (chrome, deferred with Stage 1D)"). Every dense
// sheet is read one period at a time, and every module that needed that first built its
// own: a twelve-button footer strip on one screen, two popovers on another. This is the
// one control, and `lib/table/period-param.ts` is the one definition of what its URL
// means.
//
// **It knows nothing about any screen.** No row, no column, no module, no currency, no
// role — it takes the years that exist, the period that is selected, and writes the pair
// back into the query string. `scripts/verify-table-core.ts` scans this directory and
// refuses tenant vocabulary and any import that points at a page.
//
// ── The one behaviour that matters: EVERY OTHER PARAM SURVIVES ──────────────────
// A screen's URL carries its tab, its grid, its search and its per-column filters.
// Changing the period must change the PERIOD and nothing else — an operator who picks
// July and lands back on a different tab, or on the other grid, has been moved somewhere
// they did not ask to be. `withPeriod` copies the query exhaustively and only ever
// touches its own two params; this component never builds a query string by hand.
//
// ── Why a Suspense boundary lives INSIDE the component ──────────────────────────
// `useSearchParams()` opts its whole client subtree out of static prerendering, and a
// page that has not opted out itself fails the production build with "useSearchParams()
// should be wrapped in a suspense boundary". The boundary therefore ships WITH the
// control rather than being a rule each caller has to remember — exactly as
// `GridVersionToggle` does, and for the same reason. The fallback renders the same two
// triggers, inert, so nothing moves when it resolves.
//
// ── It is CONTROLLED, and the server is what controls it ────────────────────────
// The resolved `year` / `month` and the page's own defaults arrive as PROPS. The control
// never re-derives the selection from the URL, because a page that reads the param and a
// control that reads the param are two answers to one question, and the day they disagree
// the picker says July while the sheet shows August. One answer, resolved once, server
// side, passed down.
//
// ── `all` is OFFERED, not assumed (2026-08-21) ──────────────────────────────────
// `allowAllYears` / `allowAllMonths` default to TRUE, so every caller that predates them
// renders byte-identically. A screen passes `false` when its server read is scoped to one
// period and structurally cannot widen — the QC ledger loads ONE `YYYY-MM` — because a
// dropdown entry that resolves back to the period you were already on is a control lying
// about what it can do. They are two props rather than one for the same reason `disabled`
// and `monthsDisabled` are two: a screen can genuinely have one axis and not the other.
// Hiding an option is not refusing the VALUE — `?year=all` still parses, and the page that
// hid it owns what that URL means.
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Month names, index 0 = January. Exported so a caller that wants to LABEL the selected
 * month elsewhere on the page prints the same words the dropdown does.
 */
export const PERIOD_MONTH_LABELS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * The selected period as ONE readable phrase — `August 2026`, `2026 · all months`,
 * `All years`.
 *
 * Exported beside the labels the dropdowns use, so a sheet that names its own period
 * somewhere else on the page (a toolbar count, an empty state, an export filename) prints
 * the same words the control does instead of assembling its own.
 */
export function formatPeriodLabel(year: PeriodYear, month: PeriodMonth): string {
    if (year === PERIOD_ALL) return month === PERIOD_ALL ? 'All years' : `${monthText(month)} · all years`;
    if (month === PERIOD_ALL) return `${year} · all months`;
    return `${monthText(month)} ${year}`;
}

export interface PeriodPickerProps {
    /**
     * The years the data actually spans, in the order they should be listed (newest
     * first reads best). Derived by the caller from its own rows — never a hard-coded
     * range, which is how a picker ends up offering 2010 forever and missing next year.
     */
    years: readonly number[];
    /** The RESOLVED year the page is showing. */
    year: PeriodYear;
    /** The RESOLVED month the page is showing. */
    month: PeriodMonth;
    /**
     * What a paramless URL already means. A param is written only when it says something
     * the page does not already say, so the default period stays the screen's clean URL.
     */
    defaults: PeriodSelection;
    /**
     * Inert and dimmed, for a state where the period does not apply — a search that spans
     * every year, a sheet still loading. The selection is still SHOWN: greying a control
     * is telling the operator it is not in force, not hiding what it says.
     */
    disabled?: boolean;
    /**
     * Inert MONTH only, for a year scope that has no months to pick between (`all`).
     * Separate from `disabled` because "the whole period control is off" and "there is
     * nothing to narrow" are different sentences.
     */
    monthsDisabled?: boolean;
    /**
     * Whether `All years` is OFFERED. Default `true` — every existing caller is
     * byte-identical.
     *
     * Pass `false` on a screen whose server read is scoped to ONE period and cannot
     * widen: the QC ledger's `loadQcLedgerData(month)` takes a single `YYYY-MM`, so
     * `all` there is not a period the sheet can render. An option that silently does
     * nothing is worse than no option, which is the whole reason this is a prop rather
     * than the caller quietly resolving `all` back to a real year.
     *
     * Hiding an option is NOT the same as refusing the value: `PERIOD_ALL` is still a
     * legal parse, so a page that hides it owns what a hand-typed `?year=all` means (on
     * the QC ledger: the page's own default, the same answer any unrecognised value
     * gets).
     */
    allowAllYears?: boolean;
    /**
     * Whether `All months` is OFFERED. Default `true`. Same argument as `allowAllYears`,
     * split per axis for the same reason `monthsDisabled` is split from `disabled` — a
     * screen can genuinely have one and not the other.
     */
    allowAllMonths?: boolean;
    /** Optional caption in front of the two selects (e.g. `"Period"`). */
    label?: string;
    className?: string;
}

const TRIGGER =
    'h-6 gap-1 border-border/60 bg-background px-2 font-mono text-[11px] hover:bg-muted/50';

/** The label a select shows for whatever is selected, `all` included. */
function yearText(year: PeriodYear): string {
    return year === PERIOD_ALL ? 'All years' : String(year);
}

function monthText(month: PeriodMonth): string {
    return month === PERIOD_ALL ? 'All months' : PERIOD_MONTH_LABELS[month - 1] ?? 'All months';
}

export function PeriodPicker(props: PeriodPickerProps) {
    return (
        <React.Suspense fallback={<PickerShell {...props} />}>
            <PeriodPickerInner {...props} />
        </React.Suspense>
    );
}

function PeriodPickerInner({
    years,
    year,
    month,
    defaults,
    disabled = false,
    monthsDisabled = false,
    allowAllYears = true,
    allowAllMonths = true,
    label,
    className,
}: PeriodPickerProps) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const [pending, startTransition] = React.useTransition();

    const go = React.useCallback(
        (next: PeriodSelection) => {
            if (next.year === year && next.month === month) return;
            // `params` is a `ReadonlyURLSearchParams`, which is iterable — `withPeriod`
            // takes the entries and carries every one of them across.
            const href = periodHref(pathname, params.entries(), next, defaults);
            startTransition(() => {
                // `scroll: false` — narrowing the period replaces the rows in place, and
                // a sheet that jumps to the top on every pick is a sheet you cannot
                // compare two months in.
                router.push(href, { scroll: false });
            });
        },
        [defaults, month, params, pathname, router, year],
    );

    // A year the URL names but the data does not contain is still offered, or the select
    // would show an empty trigger for a period the page is genuinely displaying.
    const yearOptions = React.useMemo(() => {
        if (year === PERIOD_ALL || years.includes(year)) return years;
        return [year, ...years].sort((a, b) => b - a);
    }, [year, years]);

    return (
        // Marks the control as chrome the GRID does not own, so if it is ever mounted
        // inside a Blackwood Table toolbar, Enter/Space here works the select instead of
        // opening the selected cell for editing.
        <div
            data-grid-chrome=""
            className={cn('flex items-center gap-1.5', className)}
        >
            {label ? (
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                </span>
            ) : null}

            <Select
                value={String(year)}
                disabled={disabled}
                onValueChange={(v) => {
                    const nextYear: PeriodYear = v === PERIOD_ALL ? PERIOD_ALL : Number(v);
                    // Narrowing to a single year while every month is showing keeps every
                    // month showing; WIDENING to every year drops the month, because one
                    // calendar month spread across nine years is not a period anybody
                    // asked to read. Same rule the live footer has always had.
                    const nextMonth: PeriodMonth = nextYear === PERIOD_ALL ? PERIOD_ALL : month;
                    go({ year: nextYear, month: nextMonth });
                }}
            >
                <SelectTrigger
                    aria-label="Year"
                    data-testid="period-year"
                    className={cn(TRIGGER, 'w-[92px]')}
                >
                    <SelectValue placeholder="Year">{yearText(year)}</SelectValue>
                </SelectTrigger>
                <SelectContent className="font-mono text-xs">
                    {allowAllYears ? (
                        <SelectItem value={PERIOD_ALL} className="text-[11px]">All years</SelectItem>
                    ) : null}
                    {allowAllYears && yearOptions.length > 0 ? <SelectSeparator /> : null}
                    {yearOptions.map((y) => (
                        <SelectItem key={y} value={String(y)} className="text-[11px]">
                            {y}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            <Select
                value={String(month)}
                disabled={disabled || monthsDisabled}
                onValueChange={(v) => {
                    const nextMonth: PeriodMonth = v === PERIOD_ALL ? PERIOD_ALL : Number(v);
                    go({ year, month: nextMonth });
                }}
            >
                <SelectTrigger
                    aria-label="Month"
                    data-testid="period-month"
                    className={cn(TRIGGER, 'w-[116px]')}
                >
                    <SelectValue placeholder="Month">{monthText(month)}</SelectValue>
                </SelectTrigger>
                <SelectContent className="font-mono text-xs">
                    {allowAllMonths ? (
                        <>
                            <SelectItem value={PERIOD_ALL} className="text-[11px]">All months</SelectItem>
                            <SelectSeparator />
                        </>
                    ) : null}
                    {PERIOD_MONTH_LABELS.map((name, i) => (
                        <SelectItem key={name} value={String(i + 1)} className="text-[11px]">
                            {name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {pending ? (
                <Loader2
                    className="size-3 shrink-0 animate-spin text-muted-foreground"
                    aria-hidden="true"
                />
            ) : null}
        </div>
    );
}

/**
 * The Suspense fallback — the control's exact geometry with no state and no handlers, so
 * the strip does not reflow when the real one takes over. It renders the SELECTION, which
 * it can: unlike the grid toggle, this control is told what is selected rather than
 * reading it from the URL, so there is nothing to guess and nothing to get momentarily
 * wrong.
 */
function PickerShell({ year, month, label, className }: PeriodPickerProps) {
    return (
        <div className={cn('flex items-center gap-1.5', className)} aria-hidden="true">
            {label ? (
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {label}
                </span>
            ) : null}
            <span
                className={cn(
                    TRIGGER,
                    'inline-flex w-[92px] items-center rounded-md border opacity-60',
                )}
            >
                {yearText(year)}
            </span>
            <span
                className={cn(
                    TRIGGER,
                    'inline-flex w-[116px] items-center rounded-md border opacity-60',
                )}
            >
                {monthText(month)}
            </span>
        </div>
    );
}
