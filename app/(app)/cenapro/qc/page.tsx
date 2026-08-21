import { redirect } from 'next/navigation';

import { resolveQcMonth } from '@/lib/cenapro/ccc-analysis-view';

import { loadQcDrawOptions, loadQcLedgerData, loadQcMonthKeys } from './data';
import { LoadError } from './load-error';
import { QcLedgerClient } from './qc-ledger-client';
import { QcLedgerGridV2 } from './qc-ledger-grid-v2';
import { GridVersionBar, PeriodPicker } from '@/components/shared/table';
import {
    GRID_V2,
    PERIOD_MONTH_PARAM,
    PERIOD_YEAR_PARAM,
    parsePeriodMonth,
    parsePeriodYear,
    resolveGrid,
} from '@/lib/table';

// ─────────────────────────────────────────────────────────────────────────────────
// QC Ledger (`/cenapro/qc`) — the ENTRY surface for CCC's partner lab results.
//
// The CCC-CI ANALYSIS sheet as a live grid: every partner receipt of the selected
// month, grouped into the (date · source · effective warehouse) samples a lab reading
// actually covers, with the four metric columns editable and every other column
// reference-only.
//
// Server component: fetch, hand off. Every total and weighted average comes from the
// SQL aggregate views (`scope='all'` here — the entry surface shows everything an
// operator can type against, DVO included). See `./data.ts`.
// ─────────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

/** The legacy month param — `?m=YYYY-MM`, written by the Classic `MonthYearPicker`. */
const LEGACY_MONTH_PARAM = 'm';

/** A repeated param arrives as an array — take the first, the way every axis here does. */
function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

function monthKeyOf(year: number, month: number): string {
    return `${year}-${String(month).padStart(2, '0')}`;
}

export default async function QcLedgerPage({
    searchParams,
}: {
    // Typed as the whole bag rather than the four params this file names, because the
    // v1 canonicalisation below has to carry EVERY other param across — a redirect that
    // silently dropped a filter would move the operator somewhere they did not ask to be,
    // which is the same clause `withPeriod` and `withGrid` are built around.
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const { monthKeys, error: monthsError } = await loadQcMonthKeys();

    // ── WHICH GRID (`?grid=`) ────────────────────────────────────────────────────
    //
    // This screen's DEFAULT is v2 (2026-08-21). `?grid=` absent, misspelt, `V2` or `3`
    // all mean the NEW table; the Classic one is `?grid=v1` — a DEFAULT FLIP, not a
    // cutover: nothing is deleted, `QcLedgerClient` stays mounted, fully reachable and
    // fully functional, and it remains where logging a reading happens until the v2
    // editing pass lands.
    //
    // ONE props object is still built and spread into whichever component the flag
    // picks, so the two sides provably read the identical payload.
    const v2 = resolveGrid(first(params.grid), GRID_V2) === GRID_V2;

    // ─── The PERIOD, and the TWO spellings this screen answers to ────────────────
    //
    //   `?m=YYYY-MM`        LEGACY. What `MonthYearPicker` writes, what every existing
    //                       QC link and bookmark carries, and the axis `/cenapro/qc/
    //                       breakdown` still shares. Honoured forever.
    //   `?year=` + `?month=` CANONICAL. The platform period axis
    //                       (`lib/table/period-param.ts`), what `PeriodPicker` writes.
    //
    // **Precedence, stated once: `?year=`/`?month=` win, and `?m=` supplies the base
    // they are read against.** So a legacy link opens on exactly the month it always
    // did, and either dropdown moving one axis is a one-param edit rather than a
    // rewrite of the other spelling.
    //
    // **QC has no `all`.** `loadQcLedgerData` is month-scoped server-side and the
    // Classic screen has never offered every-month; `PERIOD_ALL` is still a legal parse,
    // so a hand-typed `?year=all` resolves to this page's default, the same answer any
    // unrecognised value gets. The dropdowns do not offer it (`allowAll*={false}`).
    const baseMonth = resolveQcMonth(monthKeys, first(params.m));
    const baseYear = Number(baseMonth.slice(0, 4));
    const baseMonthNum = Number(baseMonth.slice(5, 7));

    const yearParam = parsePeriodYear(params[PERIOD_YEAR_PARAM]);
    const monthParam = parsePeriodMonth(params[PERIOD_MONTH_PARAM]);
    const year = typeof yearParam === 'number' ? yearParam : baseYear;
    const monthNum = typeof monthParam === 'number' ? monthParam : baseMonthNum;

    // ── The Classic branch is CANONICALISED to `?m=`, in one hop ─────────────────
    //
    // The two pickers write different params and `MonthYearPicker` is not mine to edit,
    // so without this a period picked in the new table would sit in the URL out-ranking
    // every subsequent pick made in the old one — the Classic picker would look broken
    // the moment you flipped to it.
    //
    // So on the v1 branch the resolved period is written back as the one param that
    // branch's own control maintains, and the canonical pair is dropped. The redirect
    // fires ONLY when those params are present (a flip carrying them, or a hand-typed
    // URL), never on the default path, and its target cannot re-trigger it — so there is
    // no loop. The reverse direction needs no redirect at all: a stale `?m=` left behind
    // on the v2 branch is harmless, because it only ever supplies the base.
    if (!v2 && (params[PERIOD_YEAR_PARAM] !== undefined || params[PERIOD_MONTH_PARAM] !== undefined)) {
        const next = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (key === PERIOD_YEAR_PARAM || key === PERIOD_MONTH_PARAM) continue;
            if (key === LEGACY_MONTH_PARAM) continue;
            if (value === undefined) continue;
            for (const one of Array.isArray(value) ? value : [value]) next.append(key, one);
        }
        next.append(LEGACY_MONTH_PARAM, monthKeyOf(year, monthNum));
        redirect(`/cenapro/qc?${next.toString()}`);
    }

    const month = monthKeyOf(year, monthNum);

    // The ledger read and the ADD form's dimension lists are independent — one round
    // trip, not two in series.
    const [data, drawOptions] = await Promise.all([
        loadQcLedgerData(month, monthKeys),
        loadQcDrawOptions(),
    ]);
    const error = monthsError ?? data.error ?? drawOptions.error;

    const gridProps = {
        month: data.month,
        days: data.days,
        monthAgg: data.monthAgg,
        monthKeys: data.monthKeys,
        previousWtd: data.previousWtd,
        previousLabel: data.previousLabel,
        drawOptions,
    };

    /**
     * The years the dropdown offers — every year `monthKeys` holds, plus the CURRENT
     * year always, newest first.
     *
     * Derived, never hard-coded. The `+ current year` clause is carried over verbatim
     * from `MonthYearPicker`: on 1 January the newest year with receipts is last year's,
     * and without it the operator could not reach the month they need to start typing
     * into. A year the URL names that neither source holds is prepended by the control
     * itself.
     */
    const yearSet = new Set<number>();
    for (const key of monthKeys) {
        const y = Number(key.slice(0, 4));
        if (Number.isFinite(y)) yearSet.add(y);
    }
    yearSet.add(new Date().getFullYear());
    const availableYears = [...yearSet].sort((a, b) => b - a);

    // The period control rides in the grid bar's right-hand slot — ONE strip of chrome
    // above the sheet, not two, because a second bar costs a row of the sheet.
    //
    // **v2 ONLY.** The Classic table keeps its own `MonthYearPicker`; mounting a second
    // period control above it would give that screen two of them, disagreeing.
    //
    // All TWELVE months are offered whether or not they carry receipts — the Classic
    // picker's rule since 2026-08-04, and the reason for it is unchanged: an empty month
    // is where the first draw of a new month has to land, so it must be a place you can
    // go. (What is lost against the Classic control is its `· no data` suffix; the
    // platform picker takes no per-option annotation, and inventing one for a single
    // consumer would put tenant knowledge in the platform layer.)
    const periodPicker = v2 ? (
        <PeriodPicker
            years={availableYears}
            year={year}
            month={monthNum}
            // What a URL with NO `?year=`/`?month=` already means — including the month a
            // legacy `?m=` names. A param is written only when it says something the page
            // does not already say, so a legacy link that is then narrowed one axis keeps
            // the other axis implicit instead of growing a redundant param.
            defaults={{ year: baseYear, month: baseMonthNum }}
            allowAllYears={false}
            allowAllMonths={false}
        />
    ) : null;

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {error ? (
                <div className="p-4">
                    <LoadError message={error} />
                </div>
            ) : null}
            <GridVersionBar
                defaultVersion={GRID_V2}
                currentLabel="Classic"
                newLabel="Table (new)"
                note="Same month, same draws — this switches only which table renders them; logging a reading still happens in the Classic table for now."
                trailing={periodPicker}
            />
            {v2 ? (
                <QcLedgerGridV2 {...gridProps} />
            ) : (
                <QcLedgerClient {...gridProps} />
            )}
        </div>
    );
}
