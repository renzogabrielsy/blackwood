import { Suspense } from 'react';
import { createClient } from '@/lib/supabase/server';
import type { DeliveryHistoryRow } from '@/types/rc-in';
import { format } from 'date-fns';
import { InventoryView } from './components/inventory-view';
import { InventoryViewV2 } from './components/inventory-view-v2';
import { LogsShell } from './components/logs-shell';
import { getTableSettings } from '@/lib/actions/table-settings';
import { canViewPrices } from '@/lib/auth';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { GridVersionBar, PeriodPicker } from '@/components/shared/table';
import {
    GRID_V2,
    PERIOD_ALL,
    resolveGrid,
    resolvePeriodMonth,
    resolvePeriodYear,
} from '@/lib/table';
import type { PeriodMonth, PeriodYear } from '@/lib/table';

export default async function InventoryPage({
    searchParams
}: {
    // `grid` is the universal-table side-by-side axis (`lib/table/grid-param.ts`) — an
    // axis of the CLIENT, never of the data. It picks which component renders the rows
    // below; it reaches no query, no action and no role gate, and every fetch on this page
    // runs identically either way.
    //
    // `year` + `month` are the PERIOD axis (`lib/table/period-param.ts`). `year` is the
    // SERVER's scope and always has been — it bounds the query below. `month` is not: the
    // year's rows are already in hand, so narrowing to one of its months is a cut of a
    // payload that was fetched either way, exactly as the live table's footer strip has
    // always done it. Adding a month bound to the query would refetch on every pick and
    // make flipping between two months a round trip.
    searchParams: Promise<{ year?: string; month?: string; search?: string; grid?: string }>;
}) {
    const supabase = await createClient();
    const { year: rawYear, month: rawMonth, search, grid } = await searchParams;
    const now = new Date();
    const currentYear = now.getFullYear();

    // ONE reading of `?year=`, shared by the fetch below and by the control above it. A
    // page that parsed the param and a picker that parsed the param are two answers to
    // one question, and the day they disagree the dropdown says 2026 while the sheet
    // shows 2025.
    const selectedYear: PeriodYear = resolvePeriodYear(rawYear, currentYear);
    const year = selectedYear === PERIOD_ALL ? currentYear : selectedYear;

    // Fetch active batches for the input form
    const { data: batches } = await supabase
        .from('batches')
        .select('id, batch_code, location_ref')
        .neq('status', 'CLOSED')
        .order('created_at', { ascending: false });

    // Build deliveries query for a given page window (filters/ordering reapplied
    // per page). Passed to the shared fetchAllRows pagination helper.
    const buildDeliveriesQuery = (from: number, to: number) => {
        let q = supabase
            .from('deliveries')
            .select('*, batches(location_ref, status)')
            .order('transaction_date', { ascending: false })
            .order('created_at', { ascending: false });

        if (search) {
            const term = `%${search}%`;
            q = q.or(`supplier.ilike.${term},batch_code.ilike.${term},truck_plate.ilike.${term},block_loc.ilike.${term}`);
        } else if (selectedYear !== PERIOD_ALL) {
            const startDate = new Date(year, 0, 1);
            const endDate = new Date(year, 11, 31);
            q = q.gte('transaction_date', format(startDate, 'yyyy-MM-dd'))
                 .lte('transaction_date', format(endDate, 'yyyy-MM-dd'));
        }
        return q.range(from, to);
    };

    // Paginated fetch — bypasses PostgREST max_rows (default 1000).
    type DeliveryRaw = NonNullable<Awaited<ReturnType<typeof buildDeliveriesQuery>>['data']>[number];
    const deliveriesRaw = await fetchAllRows<DeliveryRaw>((from, to) => buildDeliveriesQuery(from, to));

    // Fetch ALL distinct suppliers and locations (not scoped by year) for header bar
    // filters, plus the two DATE BOUNDS the year dropdown is built from.
    //
    // ── Why the bounds and not a DISTINCT over the dates ────────────────────────
    // The year list has to describe every year the ledger holds, and `deliveriesRaw`
    // above is scoped to ONE of them — so it cannot be the source. A
    // `select('transaction_date')` over the whole table could be, except PostgREST caps
    // an unpaginated select at 1,000 rows (the two selects above already live with that,
    // because a distinct set of suppliers survives truncation and a set of YEARS would
    // not — it would silently stop at whatever year row 1,000 lands in). Two `limit(1)`
    // reads answer it exactly and cost nothing.
    //
    // This replaces the live footer's list, which is HARD-CODED `currentYear + 1` down to
    // `2010` — sixteen years the ledger has never held, and a floor that will one day be
    // above the oldest delivery in it.
    const [{ data: supRows }, { data: locRows }, { data: firstDated }, { data: lastDated }] = await Promise.all([
        supabase.from('deliveries').select('supplier').not('supplier', 'is', null),
        supabase.from('deliveries').select('block_loc').not('block_loc', 'is', null),
        supabase.from('deliveries').select('transaction_date')
            .not('transaction_date', 'is', null)
            .order('transaction_date', { ascending: true }).limit(1),
        supabase.from('deliveries').select('transaction_date')
            .not('transaction_date', 'is', null)
            .order('transaction_date', { ascending: false }).limit(1),
    ]);
    const allSuppliers = [...new Set((supRows || []).map(r => r.supplier).filter(Boolean))].sort() as string[];
    const allLocations = [...new Set((locRows || []).map(r => r.block_loc).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    ) as string[];

    // CANONICAL price gate — derives the EFFECTIVE role via lib/auth.getUserRole(),
    // so the dev-impersonation cookie is respected (an Owner "viewing as Production"
    // is correctly denied). Replaces the previous inline profiles lookup, which
    // ignored the cookie and leaked cost_basis to impersonating admins.
    const showPrices = await canViewPrices();

    const deliveries: DeliveryHistoryRow[] = (deliveriesRaw || []).map((d) => ({
        ...d,
        state: (d.batches as Record<string, unknown> | null)?.status as string || 'STORED',
        lab_results: typeof d.lab_results === 'string' ? JSON.parse(d.lab_results) : (d.lab_results || {}),
        cost_basis: showPrices ? d.cost_basis : undefined,
    }));

    const activeBatches = (batches || []).map(b => ({
        id: b.id,
        batch_code: b.batch_code,
        location_ref: b.location_ref,
    }));

    const initialSettings = await getTableSettings('rc_in');

    // ─── The PERIOD axis — one Year + Month pair, shared by BOTH tabs ────────────
    //
    // Renzo: *"both deliveries and usage need to be filtered using the dropdowns of year
    // and month"*. ONE pair for both, for the same reason there is one grid toggle for
    // both: Deliveries and Usage are two views of one shell, and two period controls
    // would let the screen sit showing August on one tab and March on the other.

    /**
     * The years the ledger actually spans, newest first — from the two date bounds above,
     * extended to the current year so "this year" is always pickable even before its
     * first delivery lands.
     */
    const firstYear = Number((firstDated?.[0]?.transaction_date ?? '').slice(0, 4));
    const lastYear = Number((lastDated?.[0]?.transaction_date ?? '').slice(0, 4));
    const yearFloor = Number.isFinite(firstYear) && firstYear > 1900 ? firstYear : currentYear;
    // Bounded by the DATA and by today — deliberately NOT stretched to reach whatever
    // `?year=` says. `?year=9999` is a legal parse, and folding it in here would build a
    // dropdown eight thousand items long. A year the URL names but this list does not
    // hold is prepended by the control itself, which is one entry rather than a range.
    const yearCeil = Math.max(
        Number.isFinite(lastYear) && lastYear > 1900 ? lastYear : currentYear,
        currentYear,
    );
    const availableYears: number[] = [];
    for (let y = yearCeil; y >= Math.min(yearFloor, yearCeil); y--) availableYears.push(y);

    /**
     * The month a paramless URL means.
     *
     * The live table opens on `new Date().getMonth()` — the current calendar month, full
     * stop, even when it is empty, which on the 1st of a month is a blank sheet. So this
     * keeps the live default and adds the one clause it is missing: **the current month
     * when the selected year has anything in it, else that year's LATEST month with
     * data.** Opening on the newest month worth reading is what the control is for.
     *
     * Under a SEARCH the default is every month, because a search is a cut of history
     * that deliberately spans every year (see the query above) and narrowing it to one
     * month would hide most of what was found. Same under `?year=all`, where one calendar
     * month spread across every year is not a period anybody asked to read.
     */
    const monthsWithData = new Set<number>();
    for (const d of deliveries) {
        const t = d.transaction_date ?? '';
        if (t.slice(0, 4) !== String(year)) continue;
        const m = Number(t.slice(5, 7));
        if (m >= 1 && m <= 12) monthsWithData.add(m);
    }
    const currentMonth = now.getMonth() + 1;
    const periodOff = Boolean(search) || selectedYear === PERIOD_ALL;
    const defaultMonth: PeriodMonth = periodOff
        ? PERIOD_ALL
        : monthsWithData.has(currentMonth)
            ? currentMonth
            : monthsWithData.size > 0
                ? Math.max(...monthsWithData)
                : currentMonth;

    const selectedMonth: PeriodMonth = periodOff
        ? PERIOD_ALL
        : resolvePeriodMonth(rawMonth, defaultMonth);

    /**
     * The year the screen is actually SHOWING, which under a search is not the year in
     * the URL.
     *
     * A search deliberately drops the date bound from the query above and spans every
     * year. So the period in force during a search is `all` / `all` — and it has to READ
     * that way in the picker, in each sheet's own label and in the cut both grids make,
     * or the sheet would show a 2024 hit while the control claimed 2026 and the filter
     * would then throw that hit away. The `?year=` in the URL is left untouched and comes
     * back the moment the search is cleared.
     */
    const shownYear: PeriodYear = search ? PERIOD_ALL : selectedYear;

    // ONE toggle for BOTH tabs. Deliveries and Usage are two views of the same shell, so
    // two switches would let the screen sit in a half-migrated state nobody asked for.
    //
    // ── This screen's DEFAULT is v2 (2026-08-21) ────────────────────────────────
    // Renzo authorised the flip for RC IN and RC OUT specifically ("I'm satisfied with
    // ICTC Deliveries and Usage table so we can start to make grid v2 as our current
    // table now for those 2"). So `?grid=` absent, misspelt, `V2` or `3` all mean the NEW
    // tables here, and the classic ones are `?grid=v1` — a DEFAULT FLIP, not a cutover:
    // nothing is deleted, the old tables stay fully reachable and fully functional, and
    // they remain where Add/Edit lives until the v2 editing pass lands.
    //
    // Every other screen still on the toggle passes no default and is unchanged.
    const v2 = resolveGrid(grid, GRID_V2) === GRID_V2;

    // The period control rides in the grid bar's right-hand slot — ONE strip of chrome
    // above the sheet, not two, because a second bar costs a row of the sheet.
    //
    // **v2 ONLY.** The Classic table keeps its own footer strip and popovers, which this
    // pass does not touch; mounting a second period control above it would give that
    // screen two of them, disagreeing.
    const periodPicker = v2 ? (
        <PeriodPicker
            years={availableYears}
            year={shownYear}
            month={selectedMonth}
            defaults={{ year: currentYear, month: defaultMonth }}
            disabled={Boolean(search)}
            monthsDisabled={shownYear === PERIOD_ALL}
        />
    ) : null;

    const gridBar = (
        <GridVersionBar
            defaultVersion={GRID_V2}
            currentLabel="Classic"
            newLabel="Table (new)"
            note="Same rows, same filters — this switches only which table renders them. Adding and editing rows still happens in the Classic table for now."
            trailing={periodPicker}
        />
    );

    return (
        // useSearchParams (inside LogsShell's tab provider) needs a Suspense boundary.
        <Suspense fallback={<div className="h-full w-full" />}>
            <LogsShell>
                {gridBar}
                {v2 ? (
                    <InventoryViewV2
                        deliveries={deliveries}
                        batches={activeBatches}
                        search={search}
                        allSuppliers={allSuppliers}
                        allLocations={allLocations}
                        // The gate is resolved ONCE, server-side, above — the same call
                        // that already stripped `cost_basis` from `deliveries`. Threaded
                        // down rather than re-derived on the client.
                        canViewPrices={showPrices}
                        // The RESOLVED period, not the raw params — the picker and both
                        // grids read the same two values, so the dropdown can never name
                        // a month the sheet is not showing.
                        periodYear={shownYear}
                        periodMonth={selectedMonth}
                    />
                ) : (
                    <InventoryView
                        deliveries={deliveries}
                        batches={activeBatches}
                        search={search}
                        allSuppliers={allSuppliers}
                        allLocations={allLocations}
                        initialSettings={initialSettings}
                    />
                )}
            </LogsShell>
        </Suspense>
    );
}
