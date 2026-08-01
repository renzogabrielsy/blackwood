import { METRICS, type MetricKey } from '@/lib/cenapro/ccc-analysis';
import {
    combineAggregates,
    formatDayOfMonth,
    resolveQcMonth,
    type SeriesPoint,
} from '@/lib/cenapro/ccc-analysis-view';

import { loadQcBreakdownData, loadQcMonthKeys } from '../data';
import { LoadError } from '../load-error';
import { QcBreakdownClient } from './qc-breakdown-client';

// ─────────────────────────────────────────────────────────────────────────────────
// QC Breakdown (`/cenapro/qc/breakdown`) — the READING surface that pairs with the QC
// Ledger's entry grid over one shared `?m=YYYY-MM` axis.
//
// Read-only, two grains: the whole-history monthly rollup and the selected month
// sliced by day. Both read `scope='ex_dvo'` — the sheet's headline framing, and a
// COLUMN in the view rather than a filter here, so the daily table's Σ footer equals
// the monthly row to the kilogram by construction.
// ─────────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

export default async function QcBreakdownPage({
    searchParams,
}: {
    searchParams: Promise<{ m?: string }>;
}) {
    const params = await searchParams;
    const { monthKeys, error: monthsError } = await loadQcMonthKeys();
    const month = resolveQcMonth(monthKeys, params.m);
    const data = await loadQcBreakdownData(month, monthKeys);
    const error = monthsError ?? data.error;

    // The whole-history line. No view row exists for "all months", so the months are
    // folded via their published numerator/denominator pairs — exact, and specifically
    // NOT the mean-of-means the monthly table's own footer refuses to print.
    const overall = combineAggregates(data.months.map((row) => row.agg));

    // Months with no samples at all would flatten every panel to a null tail, so the
    // MONTHLY trend panels chart only the months that produced a number. The DAILY
    // series keeps its nulls — an unsampled day is a hole, and July 2026 is all holes.
    const metricSeries = {} as Record<MetricKey, SeriesPoint[]>;
    const dailyMetricSeries = {} as Record<MetricKey, SeriesPoint[]>;
    for (const metric of METRICS) {
        metricSeries[metric] = data.months
            .filter((row) => row.agg.wtd[metric] != null)
            .map((row) => ({ label: row.label, value: row.agg.wtd[metric] }));
        dailyMetricSeries[metric] = data.days.map((row) => ({
            label: formatDayOfMonth(row.date),
            value: row.agg.wtd[metric],
        }));
    }

    const uncovered = [...data.months].reverse().find((row) => row.agg.sampledGroupCount === 0);

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {error ? (
                <div className="p-4">
                    <LoadError message={error} />
                </div>
            ) : null}
            <QcBreakdownClient
                month={data.month}
                monthKeys={data.monthKeys}
                months={data.months}
                days={data.days}
                monthAgg={data.monthAgg}
                overall={overall}
                metricSeries={metricSeries}
                dailyMetricSeries={dailyMetricSeries}
                uncoveredMonthLabel={uncovered?.label ?? null}
            />
        </div>
    );
}
