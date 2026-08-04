// ─────────────────────────────────────────────────────────────────────────────────
// CCC/QC analysis — the PRESENTATION layer over the SQL aggregates (Cenapro tenant).
//
// Companion to `ccc-analysis.ts` (the data contract). That module owns metric
// metadata, key normalization and the save-RPC types; this one owns the two things
// the two QC routes additionally need:
//
//   1. A normalized `QcAggregate` shape adapted straight FROM a
//      `cenapro_ccc_analysis_daily` / `_monthly` view row. The four weighted averages,
//      their per-metric denominators, coverage and the DVO split are all read, never
//      recomputed — CLAUDE.md's "aggregate in SQL" rule, honoured.
//   2. Display formatters (kg, metrics, coverage, month/day labels).
//
// ── The ONE piece of arithmetic here, and why it is not a second implementation ──
// `adjustAggregate()` does NOT re-aggregate anything. It takes a SQL aggregate and
// applies per-group DELTAS to the numerator/denominator pair SQL already published
// (`wtd_X` × `wtd_X_kg`), so:
//
//   • with no adjustments it returns the SQL row's numbers UNTOUCHED (identity — the
//     early return means not even a float round-trip);
//   • with adjustments it answers exactly one question the DB cannot answer yet:
//     "what would this total read if the number I am typing right now were saved?"
//
// A save writes through the RPC and the page revalidates, at which point the preview
// is replaced by the DB's own answer. There is no path where a rendered number is a
// TypeScript re-derivation of stored state.
// ─────────────────────────────────────────────────────────────────────────────────

import {
    METRICS,
    METRIC_DECIMALS,
    METRIC_DECIMALS_WEIGHTED,
    type CccAnalysisDailyRow,
    type MetricKey,
} from './ccc-analysis';

// ─── Shapes ──────────────────────────────────────────────────────────────────────

/** The four lab metrics of one sample group. `null` = not measured. */
export type MetricValues = Record<MetricKey, number | null>;

export const EMPTY_METRIC_VALUES: MetricValues = { bd: null, ash: null, grit: null, mc: null };

/** True when at least one metric carries a value — the view's `is_sampled`. */
export function hasAnyMetric(values: MetricValues | null | undefined): boolean {
    if (!values) return false;
    return METRICS.some((metric) => values[metric] != null);
}

/**
 * A period rollup, normalized from either aggregate view. Field-for-field the shape
 * the two pages render; nothing is derived beyond renaming.
 */
export interface QcAggregate {
    /** Every kilogram in the period AT THIS SCOPE, sampled or not. */
    totalKg: number;
    /** Kilograms belonging to a group that carries at least one metric. */
    sampledKg: number;
    /** 0–1. `sampledKg / totalKg`. */
    coverage: number;
    groupCount: number;
    sampledGroupCount: number;
    /** Σ(kg × metric) / Σkg over the groups carrying THAT metric. */
    wtd: MetricValues;
    /** Per-metric denominator in kg — a group missing ASH still weights BD. */
    wtdKg: Record<MetricKey, number>;
    /** Period-wide split. Identical on the `all` and `ex_dvo` rows of a period. */
    allKg: number;
    dvoKg: number;
    exDvoKg: number;
}

export const EMPTY_AGGREGATE: QcAggregate = {
    totalKg: 0,
    sampledKg: 0,
    coverage: 0,
    groupCount: 0,
    sampledGroupCount: 0,
    wtd: { ...EMPTY_METRIC_VALUES },
    wtdKg: { bd: 0, ash: 0, grit: 0, mc: 0 },
    allKg: 0,
    dvoKg: 0,
    exDvoKg: 0,
};

const num = (value: number | null | undefined): number =>
    value == null || !Number.isFinite(value) ? 0 : value;

/**
 * The columns an aggregate is built from. Structural rather than the whole Row so a
 * caller may `.select()` just these — the daily and monthly views declare them
 * identically, so one shape covers both.
 */
export type AggregateViewRow = Pick<
    CccAnalysisDailyRow,
    | 'total_kg'
    | 'sampled_kg'
    | 'coverage'
    | 'group_count'
    | 'sampled_group_count'
    | 'wtd_bd'
    | 'wtd_ash'
    | 'wtd_grit'
    | 'wtd_mc'
    | 'wtd_bd_kg'
    | 'wtd_ash_kg'
    | 'wtd_grit_kg'
    | 'wtd_mc_kg'
    | 'all_kg'
    | 'dvo_kg'
    | 'ex_dvo_kg'
>;

/** Adapt one `cenapro_ccc_analysis_daily` / `_monthly` row. Pure renaming. */
export function aggregateFromView(row: AggregateViewRow): QcAggregate {
    return {
        totalKg: num(row.total_kg),
        sampledKg: num(row.sampled_kg),
        coverage: num(row.coverage),
        groupCount: num(row.group_count),
        sampledGroupCount: num(row.sampled_group_count),
        wtd: {
            bd: row.wtd_bd ?? null,
            ash: row.wtd_ash ?? null,
            grit: row.wtd_grit ?? null,
            mc: row.wtd_mc ?? null,
        },
        wtdKg: {
            bd: num(row.wtd_bd_kg),
            ash: num(row.wtd_ash_kg),
            grit: num(row.wtd_grit_kg),
            mc: num(row.wtd_mc_kg),
        },
        allKg: num(row.all_kg),
        dvoKg: num(row.dvo_kg),
        exDvoKg: num(row.ex_dvo_kg),
    };
}

// ─── Combining SQL aggregates (exact, not a mean of means) ───────────────────────

/**
 * Fold several period aggregates into one — the whole-history line the breakdown's
 * KPI tiles print, for which no single view row exists.
 *
 * This is exact, and deliberately NOT the trap the monthly table's footer warns
 * about: a mean of monthly means is wrong, but summing each month's published
 * NUMERATOR (`wtd_X` × `wtd_X_kg`) and DENOMINATOR (`wtd_X_kg`) and dividing once at
 * the end reproduces the single-pass weighted average to the last digit.
 */
export function combineAggregates(parts: QcAggregate[]): QcAggregate {
    if (parts.length === 0) return EMPTY_AGGREGATE;
    if (parts.length === 1) return parts[0];

    const numerator: Record<MetricKey, number> = { bd: 0, ash: 0, grit: 0, mc: 0 };
    const wtdKg: Record<MetricKey, number> = { bd: 0, ash: 0, grit: 0, mc: 0 };
    let totalKg = 0;
    let sampledKg = 0;
    let groupCount = 0;
    let sampledGroupCount = 0;
    let allKg = 0;
    let dvoKg = 0;
    let exDvoKg = 0;

    for (const part of parts) {
        totalKg += part.totalKg;
        sampledKg += part.sampledKg;
        groupCount += part.groupCount;
        sampledGroupCount += part.sampledGroupCount;
        allKg += part.allKg;
        dvoKg += part.dvoKg;
        exDvoKg += part.exDvoKg;
        for (const metric of METRICS) {
            const value = part.wtd[metric];
            if (value == null) continue;
            numerator[metric] += value * part.wtdKg[metric];
            wtdKg[metric] += part.wtdKg[metric];
        }
    }

    const wtd = {} as MetricValues;
    for (const metric of METRICS) {
        wtd[metric] = wtdKg[metric] > 0 ? numerator[metric] / wtdKg[metric] : null;
    }

    return {
        totalKg,
        sampledKg,
        coverage: totalKg > 0 ? sampledKg / totalKg : 0,
        groupCount,
        sampledGroupCount,
        wtd,
        wtdKg,
        allKg,
        dvoKg,
        exDvoKg,
    };
}

// ─── Unsaved-edit / filter preview ───────────────────────────────────────────────

/**
 * One group's difference from what SQL already counted.
 *
 * `kg` is the tonnage the view aggregated this group AT. `before` is the STORED
 * sample it aggregated (null when the group is unsampled). `after` is what should be
 * counted instead — the value being typed. `dropWeight` additionally removes the
 * group's tonnage from the period, which is what a source filter does.
 *
 * `afterKg` is the group's tonnage AFTER pending WEIGHT edits, and defaults to `kg`.
 * It exists because the QC ledger can now retype a draw's `weight_kg`, and a weight
 * is not a spectator here: it is the thing every average is weighted BY. Moving it
 * moves the day total, the month total, each metric's own denominator, and therefore
 * the weighted averages themselves — the same numerator/denominator arithmetic SQL
 * published, with one group's contribution restated. Metric-only edits leave
 * `afterKg` undefined and behave exactly as before.
 */
export interface AggregateAdjustment {
    kg: number;
    before: MetricValues | null;
    after: MetricValues | null;
    dropWeight?: boolean;
    afterKg?: number;
}

/** Never let float noise print a negative kilogram. */
const atLeastZero = (value: number): number => (value > 0 ? value : 0);

/**
 * The SQL aggregate as it WOULD read with the given per-group changes applied.
 * Returns `base` untouched when there is nothing to apply.
 */
export function adjustAggregate(
    base: QcAggregate,
    adjustments: readonly AggregateAdjustment[],
): QcAggregate {
    if (adjustments.length === 0) return base;

    const numerator: Record<MetricKey, number> = { bd: 0, ash: 0, grit: 0, mc: 0 };
    const wtdKg: Record<MetricKey, number> = { ...base.wtdKg };
    for (const metric of METRICS) {
        numerator[metric] = (base.wtd[metric] ?? 0) * base.wtdKg[metric];
    }

    let totalKg = base.totalKg;
    let sampledKg = base.sampledKg;
    let groupCount = base.groupCount;
    let sampledGroupCount = base.sampledGroupCount;

    for (const adjustment of adjustments) {
        const { kg, before, after, dropWeight } = adjustment;
        // Absent ⇒ the weight did not move, and every line below collapses to the
        // metric-only behaviour this function has always had.
        const afterKg = adjustment.afterKg ?? kg;

        // ── Take the group back OUT at the weight SQL counted it at ──────────────
        if (before) {
            for (const metric of METRICS) {
                const value = before[metric];
                if (value == null || kg <= 0) continue;
                numerator[metric] -= value * kg;
                wtdKg[metric] -= kg;
            }
            if (hasAnyMetric(before)) {
                sampledKg -= kg;
                sampledGroupCount -= 1;
            }
        }

        if (dropWeight) {
            totalKg -= kg;
            groupCount -= 1;
            continue;
        }

        // ── Put it back IN at the weight it would carry once saved ───────────────
        if (after) {
            for (const metric of METRICS) {
                const value = after[metric];
                if (value == null || afterKg <= 0) continue;
                numerator[metric] += value * afterKg;
                wtdKg[metric] += afterKg;
            }
            if (hasAnyMetric(after)) {
                sampledKg += afterKg;
                sampledGroupCount += 1;
            }
        }

        // The period's own tonnage follows the weight edit even when the group
        // carries no sample at all — an unsampled group still has weight.
        totalKg += afterKg - kg;
    }

    const wtd = {} as MetricValues;
    for (const metric of METRICS) {
        wtdKg[metric] = atLeastZero(wtdKg[metric]);
        wtd[metric] = wtdKg[metric] > 0 ? numerator[metric] / wtdKg[metric] : null;
    }

    totalKg = atLeastZero(totalKg);
    sampledKg = atLeastZero(sampledKg);

    return {
        totalKg,
        sampledKg,
        coverage: totalKg > 0 ? sampledKg / totalKg : 0,
        groupCount: Math.max(groupCount, 0),
        sampledGroupCount: Math.max(sampledGroupCount, 0),
        wtd,
        wtdKg,
        allKg: base.allKg,
        dvoKg: base.dvoKg,
        exDvoKg: base.exDvoKg,
    };
}

// ─── Chart series ────────────────────────────────────────────────────────────────

export interface SeriesPoint {
    label: string;
    /** `null` is a HOLE, never a zero — the charts run `connectNulls={false}`. */
    value: number | null;
}

// ─── Month helpers ───────────────────────────────────────────────────────────────

const MONTH_LABELS = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const;

/** `2026-05-04` → `2026-05`. */
export function monthKey(date: string): string {
    return date.slice(0, 7);
}

/** `2026-05` → `MAY`. */
export function monthLabel(month: string): string {
    const index = Number.parseInt(month.slice(5, 7), 10) - 1;
    return MONTH_LABELS[index] ?? month;
}

/** `2026-05` → `MAY 2026`. */
export function formatMonthHeading(month: string): string {
    return `${monthLabel(month)} ${month.slice(0, 4)}`;
}

export function shiftMonth(month: string, delta: number): string {
    const year = Number.parseInt(month.slice(0, 4), 10);
    const index = Number.parseInt(month.slice(5, 7), 10) - 1 + delta;
    const nextYear = year + Math.floor(index / 12);
    const nextIndex = ((index % 12) + 12) % 12;
    return `${nextYear}-${String(nextIndex + 1).padStart(2, '0')}`;
}

/** The half-open `[from, to)` date range of a `YYYY-MM`, for a PostgREST filter. */
export function monthBounds(month: string): { from: string; toExclusive: string } {
    return { from: `${month}-01`, toExclusive: `${shiftMonth(month, 1)}-01` };
}

/** `YYYY-MM`, and a real month number. Guards the URL param without a date parse. */
const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Is this a syntactically valid `?m=` month key? */
export function isValidMonthKey(value: string | undefined): value is string {
    return typeof value === 'string' && MONTH_KEY_RE.test(value);
}

/**
 * Which month a QC page should open on: any VALID `?m=YYYY-MM` from the URL — whether
 * or not it carries receipts — else the newest month that does.
 *
 * BOTH routes resolve identically on purpose. They share one `?m=` axis and
 * cross-link to each other, so defaulting to different months would make the first
 * click between them look like a navigation bug — and the newest month is where the
 * outstanding entry work is, which is the point of the ledger.
 *
 * **An EMPTY month is reachable (2026-08-04).** This used to require the month to be in
 * `monthKeys`, which are the months that already HAVE data — so the first draw of a new
 * month had nowhere to land: you could not open the month you needed to type into. The
 * month only has to be well-formed now; a month with no receipts renders its empty state
 * and its entry rows like any other. The regex is what keeps `?m=banana` (and `?m=2026-13`)
 * from resolving to a month that cannot exist.
 */
export function resolveQcMonth(monthKeys: readonly string[], urlMonth: string | undefined): string {
    if (isValidMonthKey(urlMonth)) return urlMonth;
    return monthKeys[monthKeys.length - 1] ?? new Date().toISOString().slice(0, 7);
}

// NOTE: `monthKeys` stays strictly "months that HAVE receipts" — the picker needs that
// to keep its `· no data` suffix honest. Reaching an empty month is handled inside
// `MonthYearPicker` (all twelve months always selectable, current year always offered),
// not by padding this list.

// ─── Formatters ──────────────────────────────────────────────────────────────────

export function formatKg(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return Math.round(value).toLocaleString('en-US');
}

/** `9.86M kg` / `1,645k kg` — a tile-sized figure. */
export function formatCompactKg(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M kg`;
    if (Math.abs(value) >= 1_000) return `${Math.round(value / 1_000).toLocaleString('en-US')}k kg`;
    return `${Math.round(value)} kg`;
}

/**
 * Per-metric precision. A WEIGHTED bulk density gets a fourth digit — three hide the
 * month-over-month movement entirely.
 */
export function formatMetric(
    value: number | null | undefined,
    metric: MetricKey,
    weighted = false,
): string {
    if (value == null || !Number.isFinite(value)) return '—';
    const decimals = weighted ? METRIC_DECIMALS_WEIGHTED[metric] : METRIC_DECIMALS[metric];
    return value.toFixed(decimals);
}

/** A 0–1 share → `82%`. Never rounds a nonzero sliver away to a bare `0%`. */
export function formatCoverage(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '—';
    const pct = value * 100;
    if (pct > 0 && pct < 1) return '<1%';
    if (pct < 100 && pct > 99) return '>99%';
    return `${Math.round(pct)}%`;
}

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

/** `2026-05-04` → `MAY 04 · MON`. Parsed as UTC so the label never shifts a day. */
export function formatDayHeading(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    return `${MONTH_LABELS[d.getUTCMonth()] ?? ''} ${String(d.getUTCDate()).padStart(2, '0')} · ${DOW[d.getUTCDay()]}`;
}

/** `2026-05-04` → `05-04`. */
export function formatShortDate(date: string): string {
    return date.slice(5);
}

/** `2026-05-04` → `04`. */
export function formatDayOfMonth(date: string): string {
    return date.slice(8, 10);
}

/** `2026-05-04` → `MON`. Parsed as UTC so the label never shifts a day. */
export function formatDow(date: string): string {
    return DOW[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? '';
}
