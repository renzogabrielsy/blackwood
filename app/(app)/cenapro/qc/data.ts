// ─────────────────────────────────────────────────────────────────────────────────
// QC analysis — the server read path for BOTH routes (`/cenapro/qc` and
// `/cenapro/qc/breakdown`).
//
// NOT a server action — no `'use server'`, no mutations. Just async functions the two
// page.tsx server components await. Writes live in `./actions.ts`.
//
// Every total, coverage figure and weighted average on either page is READ from a SQL
// view here; nothing is aggregated in TypeScript (CLAUDE.md). The three read models:
//
//   cenapro_ccc_sample_groups     one row per (date, source, effective warehouse) —
//                                 the entry grain, carrying `sample_row_version`
//   cenapro_ccc_analysis_daily    scope='all' | 'ex_dvo'
//   cenapro_ccc_analysis_monthly  scope='all' | 'ex_dvo'
//
// SCOPE, per route: the LEDGER is the entry surface and must show every receipt an
// operator can type against, so it reads `scope='all'`. The BREAKDOWN is the reading
// surface and headlines the sheet's ex-DVO framing, so it reads `scope='ex_dvo'`.
// Never re-filter DVO client-side — it is a column, not a predicate.
// ─────────────────────────────────────────────────────────────────────────────────

import { createClient } from '@/lib/supabase/server';
import {
    effectiveWhseKey,
    canonToken,
    sampleGroupKey,
    type AnalysisScope,
} from '@/lib/cenapro/ccc-analysis';
import {
    EMPTY_AGGREGATE,
    adjustAggregate,
    aggregateFromView,
    monthBounds,
    monthLabel,
    type MetricValues,
    type QcAggregate,
} from '@/lib/cenapro/ccc-analysis-view';

// ─── Row shapes handed to the clients ────────────────────────────────────────────

/** One production event — a physical draw CCC took. Reference data on the ledger. */
export interface QcDraw {
    id: string;
    recvDate: string;
    prodDate: string | null;
    shift: string | null;
    grade: string | null;
    plant: string | null;
    weightKg: number;
    equip: string | null;
}

/** One sample group — the unit a lab reading, and therefore a save, applies to. */
export interface QcGroup {
    /** `date|SRC|WHSE`. Stable React key AND the natural key of the save RPC. */
    key: string;
    date: string;
    src: string;
    whse: string;
    isDvo: boolean;
    /** Authoritative group weight, from the view. */
    totalKg: number;
    /** The STORED sample. `null` when nothing has been logged yet. */
    sample: MetricValues | null;
    /** Feeds the save RPC verbatim: `null` → insert, an integer → update. */
    rowVersion: number | null;
    draws: QcDraw[];
}

export interface QcLedgerDay {
    date: string;
    groups: QcGroup[];
    /** From `cenapro_ccc_analysis_daily`, `scope='all'`. */
    agg: QcAggregate;
}

export interface QcLedgerData {
    month: string;
    monthKeys: string[];
    days: QcLedgerDay[];
    /** From `cenapro_ccc_analysis_monthly`, `scope='all'`. */
    monthAgg: QcAggregate;
    previousWtd: MetricValues | null;
    previousLabel: string | null;
    error: string | null;
}

export interface QcMonthRow {
    month: string;
    label: string;
    agg: QcAggregate;
}

export interface QcDayRow {
    date: string;
    agg: QcAggregate;
}

export interface QcBreakdownData {
    month: string;
    monthKeys: string[];
    months: QcMonthRow[];
    days: QcDayRow[];
    /** The selected month's `ex_dvo` row, or null when the month has no receipts. */
    monthAgg: QcAggregate | null;
    error: string | null;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────────

const MONTHLY_COLUMNS =
    'month_key, scope, total_kg, sampled_kg, coverage, group_count, sampled_group_count, day_count, wtd_bd, wtd_ash, wtd_grit, wtd_mc, wtd_bd_kg, wtd_ash_kg, wtd_grit_kg, wtd_mc_kg, all_kg, dvo_kg, ex_dvo_kg';

const DAILY_COLUMNS =
    'sample_date, scope, total_kg, sampled_kg, coverage, group_count, sampled_group_count, draw_count, wtd_bd, wtd_ash, wtd_grit, wtd_mc, wtd_bd_kg, wtd_ash_kg, wtd_grit_kg, wtd_mc_kg, all_kg, dvo_kg, ex_dvo_kg';

const GROUP_COLUMNS =
    'sample_date, source_location_code, whse_key, source_group, is_dvo, draw_count, total_kg, bd, ash, grit, mc, is_sampled, is_complete, missing_metric_count, sample_row_version';

const EVENT_COLUMNS =
    'id, recv_date, prod_date, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, partner_equipment_code';

function describe(what: string, message: string): string {
    return `Failed to load ${what}: ${message}`;
}

/** Every `YYYY-MM` that carries partner receipts, ascending. Feeds the month picker. */
export async function loadQcMonthKeys(): Promise<{ monthKeys: string[]; error: string | null }> {
    const supabase = await createClient();
    const { data, error } = await supabase
        .from('cenapro_ccc_analysis_monthly')
        .select('month_key')
        .eq('scope', 'ex_dvo')
        .order('month_key', { ascending: true });

    if (error) return { monthKeys: [], error: describe('the QC month list', error.message) };

    const keys: string[] = [];
    for (const row of data ?? []) if (row.month_key) keys.push(row.month_key);
    return { monthKeys: keys, error: null };
}

async function loadMonthlyRows(scope: AnalysisScope) {
    const supabase = await createClient();
    return supabase
        .from('cenapro_ccc_analysis_monthly')
        .select(MONTHLY_COLUMNS)
        .eq('scope', scope)
        .order('month_key', { ascending: true });
}

// ─── The ledger (`/cenapro/qc`) ──────────────────────────────────────────────────

/**
 * One month of the entry ledger: the draws, their sample groups, each day's rollup
 * and the month's rollup — plus the PRIOR month's weighted averages, which are the
 * KPI tiles' delta baseline and by definition sit outside the visible rows.
 */
export async function loadQcLedgerData(
    month: string,
    monthKeys: string[],
): Promise<QcLedgerData> {
    const empty: QcLedgerData = {
        month,
        monthKeys,
        days: [],
        monthAgg: EMPTY_AGGREGATE,
        previousWtd: null,
        previousLabel: null,
        error: null,
    };

    const supabase = await createClient();
    const { from, toExclusive } = monthBounds(month);

    const [groupsResult, eventsResult, dailyResult, monthlyResult] = await Promise.all([
        supabase
            .from('cenapro_ccc_sample_groups')
            .select(GROUP_COLUMNS)
            .gte('sample_date', from)
            .lt('sample_date', toExclusive)
            .order('sample_date', { ascending: true })
            .order('source_location_code', { ascending: true })
            .order('whse_key', { ascending: true }),
        supabase
            .from('cenapro_production_events')
            .select(EVENT_COLUMNS)
            .not('partner_equipment_code', 'is', null)
            .gte('recv_date', from)
            .lt('recv_date', toExclusive)
            .order('recv_date', { ascending: true })
            .limit(5000),
        supabase
            .from('cenapro_ccc_analysis_daily')
            .select(DAILY_COLUMNS)
            .eq('scope', 'all')
            .gte('sample_date', from)
            .lt('sample_date', toExclusive)
            .order('sample_date', { ascending: true }),
        loadMonthlyRows('all'),
    ]);

    const failure =
        groupsResult.error ?? eventsResult.error ?? dailyResult.error ?? monthlyResult.error;
    if (failure) return { ...empty, error: describe('the QC ledger', failure.message) };

    // ── Groups: the view IS the grain. Build from it, then hang the draws off it. ──
    const groupsByKey = new Map<string, QcGroup>();
    for (const row of groupsResult.data ?? []) {
        if (!row.sample_date || !row.source_location_code || !row.whse_key) continue;
        const key = sampleGroupKey({
            sample_date: row.sample_date,
            source_location_code: row.source_location_code,
            whse_key: row.whse_key,
        });
        groupsByKey.set(key, {
            key,
            date: row.sample_date,
            src: row.source_location_code,
            whse: row.whse_key,
            isDvo: row.is_dvo === true,
            totalKg: row.total_kg ?? 0,
            sample: row.is_sampled
                ? { bd: row.bd ?? null, ash: row.ash ?? null, grit: row.grit ?? null, mc: row.mc ?? null }
                : null,
            rowVersion: row.sample_row_version ?? null,
            draws: [],
        });
    }

    for (const row of eventsResult.data ?? []) {
        if (!row.id || !row.recv_date || !row.source_location_code) continue;
        const key = sampleGroupKey({
            sample_date: row.recv_date,
            source_location_code: canonToken(row.source_location_code),
            whse_key: effectiveWhseKey(row),
        });
        // A draw whose group the view does not carry cannot happen (the view is built
        // FROM these rows) — but if the two ever drift, show the draw rather than
        // silently dropping tonnage the operator can see in the production ledger.
        const group =
            groupsByKey.get(key) ??
            (() => {
                const orphan: QcGroup = {
                    key,
                    date: row.recv_date,
                    src: canonToken(row.source_location_code),
                    whse: effectiveWhseKey(row),
                    isDvo: canonToken(row.source_location_code) === 'DVO',
                    totalKg: 0,
                    sample: null,
                    rowVersion: null,
                    draws: [],
                };
                groupsByKey.set(key, orphan);
                return orphan;
            })();
        group.draws.push({
            id: row.id,
            recvDate: row.recv_date,
            prodDate: row.prod_date,
            shift: row.shift_code,
            grade: row.grade_code,
            plant: row.plant_code,
            weightKg: row.weight_kg ?? 0,
            equip: row.partner_equipment_code,
        });
    }

    // ── Day blocks, in visual (ascending) order ───────────────────────────────────
    const dayAggByDate = new Map<string, QcAggregate>();
    for (const row of dailyResult.data ?? []) {
        if (!row.sample_date) continue;
        dayAggByDate.set(row.sample_date, aggregateFromView(row));
    }

    const groupsByDate = new Map<string, QcGroup[]>();
    for (const group of groupsByKey.values()) {
        group.draws.sort(
            (a, b) => (a.equip ?? '').localeCompare(b.equip ?? '') || a.id.localeCompare(b.id),
        );
        const bucket = groupsByDate.get(group.date);
        if (bucket) bucket.push(group);
        else groupsByDate.set(group.date, [group]);
    }

    const days: QcLedgerDay[] = [...groupsByDate.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, dayGroups]) => {
            dayGroups.sort((a, b) => a.src.localeCompare(b.src) || a.whse.localeCompare(b.whse));
            return {
                date,
                groups: dayGroups,
                // The fallback only fires on the drift case above, and reuses the SAME
                // preview arithmetic the client uses for unsaved edits.
                agg:
                    dayAggByDate.get(date) ??
                    adjustAggregate(
                        EMPTY_AGGREGATE,
                        dayGroups.map((g) => ({ kg: g.totalKg, before: null, after: g.sample })),
                    ),
            };
        });

    const monthlyRows = monthlyResult.data ?? [];
    const thisMonth = monthlyRows.find((row) => row.month_key === month) ?? null;
    const previousKey = monthKeys[monthKeys.indexOf(month) - 1] ?? null;
    const previous = previousKey
        ? (monthlyRows.find((row) => row.month_key === previousKey) ?? null)
        : null;

    return {
        month,
        monthKeys,
        days,
        monthAgg: thisMonth ? aggregateFromView(thisMonth) : EMPTY_AGGREGATE,
        previousWtd: previous ? aggregateFromView(previous).wtd : null,
        previousLabel: previousKey ? monthLabel(previousKey) : null,
        error: null,
    };
}

// ─── The breakdown (`/cenapro/qc/breakdown`) ─────────────────────────────────────

/**
 * The reading surface's two grains, both `scope='ex_dvo'`: the whole-history monthly
 * rollup, and the selected month sliced by day.
 */
export async function loadQcBreakdownData(
    month: string,
    monthKeys: string[],
): Promise<QcBreakdownData> {
    const supabase = await createClient();
    const { from, toExclusive } = monthBounds(month);

    const [monthlyResult, dailyResult] = await Promise.all([
        loadMonthlyRows('ex_dvo'),
        supabase
            .from('cenapro_ccc_analysis_daily')
            .select(DAILY_COLUMNS)
            .eq('scope', 'ex_dvo')
            .gte('sample_date', from)
            .lt('sample_date', toExclusive)
            .order('sample_date', { ascending: true }),
    ]);

    const failure = monthlyResult.error ?? dailyResult.error;
    if (failure) {
        return {
            month,
            monthKeys,
            months: [],
            days: [],
            monthAgg: null,
            error: describe('the QC breakdown', failure.message),
        };
    }

    const months: QcMonthRow[] = [];
    for (const row of monthlyResult.data ?? []) {
        if (!row.month_key) continue;
        months.push({
            month: row.month_key,
            label: monthLabel(row.month_key),
            agg: aggregateFromView(row),
        });
    }

    const days: QcDayRow[] = [];
    for (const row of dailyResult.data ?? []) {
        if (!row.sample_date) continue;
        days.push({ date: row.sample_date, agg: aggregateFromView(row) });
    }

    return {
        month,
        monthKeys,
        months,
        days,
        monthAgg: months.find((m) => m.month === month)?.agg ?? null,
        error: null,
    };
}
