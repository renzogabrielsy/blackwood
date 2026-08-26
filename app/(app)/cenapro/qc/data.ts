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
    CRUSHER_CODES,
    FLEC_WAREHOUSES,
    GRADE_CODES,
    KILN_CODES,
    SHIFT_CODES,
    SOURCE_LOCATION_CODES,
    WHSE_SIDES,
} from '../types';
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
    /**
     * The PRODUCTION label the database resolved for this receipt — `FEBRUARY`, `JULY`, …
     *
     * Read-only here in every sense: `cenapro_add_partner_draw` derives it SERVER-SIDE from
     * `recv_date` (*"whichever label was actually running"*), and no QC RPC accepts one, so
     * nothing on this side may type or write it. It is selected purely so the v2 sheet's
     * BATCH lane can show what the Production ledger shows for the same row — until
     * 2026-08-26 that column rendered a dash forever because the read simply never asked
     * for the column.
     */
    batch: string | null;
    /** The batch's year, painted beside it exactly as the Production ledger paints it. */
    batchYear: number | null;
    equip: string | null;
    /** FLEC draws only — bags taken out of the warehouse. NULL on every other source. */
    flecCount: number | null;
    /** FLEC draws only, and optional there — `LS` / `RS`. */
    side: string | null;
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

// `batch` / `batch_year` are SELECTED, never written: the v2 sheet's BATCH lane renders
// them (2026-08-26) and every QC write path resolves the label server-side from the
// receipt date. Their absence here is why that column rendered a dash forever.
const EVENT_COLUMNS =
    'id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, partner_equipment_code, flec_count, whse_side';

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
            batch: row.batch,
            batchYear: row.batch_year,
            shift: row.shift_code,
            grade: row.grade_code,
            plant: row.plant_code,
            weightKg: row.weight_kg ?? 0,
            equip: row.partner_equipment_code,
            flecCount: row.flec_count ?? null,
            side: row.whse_side ?? null,
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

// ─── Dimension options for the ADD form ──────────────────────────────────────────
//
// Every code the "Add draw" composer offers is checked against its dimension table by
// `cenapro_add_partner_draw`, so an option this loader gets wrong can only ever produce
// an `invalid_key` sentence — never a bad row. What it must not do is HIDE a machine
// the partner's slip actually names, which is why the list is read from the database
// rather than typed out here.
//
// WHERE IT READS FROM, AND WHY IT IS MOSTLY NOT THE DIMENSION TABLES.
// `cenapro.source_location` / `partner_equipment` / `shift` / `warehouse` are the real
// lists, but the `cenapro` schema is NOT exposed to PostgREST (`Only the following
// schemas are exposed: public, graphql_public`) and no `public` accessor for those four
// exists — so the app, server-side included, cannot reach them. The reachable evidence
// is the fact table: `public.cenapro_production_events` carries the five code columns,
// FK-constrained, so every distinct value in it is by definition a live dimension row.
//
// That read alone is INCOMPLETE — a seeded code no event has used yet is invisible to
// it (today: C3, C4, WHSE 2). So the observed values are merged over the module's
// canonical code constants in `../types.ts`, which that file already documents as an
// exact mirror of the seed. Canonical order first (TNK 1…4 · W6 · W7 · FLEC reads the
// way the slip does), then anything the data knows that the constants do not — so a
// code added to the seed later surfaces on its first row instead of silently missing.
//
// GRADE IS THE EXCEPTION, AND IT IS READ PROPERLY (2026-08-26). `public.cenapro_grades`
// is a real `security_invoker` accessor over `cenapro.grade`, built the day grades
// became addable in-app from `/cenapro/inventory` (`public.cenapro_add_grade`). Merging
// only the constant and the observed events would leave a freshly added grade invisible
// until its first event — and that is not merely a short dropdown here. THIS LIST IS THE
// QC v2 SHEET'S CELL VALIDATOR: `parseQcField('grade', …)` checks typed text against
// `options.grades`, so a grade the database just accepted would be REFUSED BY NAME when
// an operator types it, with a persistent error toast. The accessor's own order
// (`sort_order, code`) is the canonical one and is never re-sorted here; the constant is
// merged in UNDER it purely as a floor, so a failed or partial read can only ever leave
// the list as complete as it was before this change.
//
// Replace the OTHER four the day a `public.cenapro_dimensions` accessor lands; the shape
// below is what the UI consumes and would not change.

/** The picker lists the composer renders. Every list is already RPC-legal. */
export interface QcDrawOptions {
    /** Draw sources. DVO is never offered — the RPC answers `unsupported_source`. */
    sources: string[];
    /** Partner crushers — a draw into one is a `partner_crusher`. */
    crushers: string[];
    /** Partner rotary kilns — a draw into one is a `partner_kiln`. */
    kilns: string[];
    grades: string[];
    shifts: string[];
    /** FLEC-source draws only, and flec-count warehouses only (never WHSE 3 / DVO). */
    warehouses: string[];
    sides: string[];
    /** Non-fatal: the form still renders on the canonical lists. */
    error: string | null;
}

/** Canonical order first, then anything live data knows that the constants do not. */
function mergeCodes(
    canonical: readonly string[],
    observed: Iterable<string>,
    exclude: readonly string[] = [],
): string[] {
    const blocked = new Set(exclude);
    const out = canonical.filter((code) => !blocked.has(code));
    const known = new Set(out);
    const extras: string[] = [];
    for (const code of observed) {
        const trimmed = code.trim();
        if (!trimmed || blocked.has(trimmed) || known.has(trimmed)) continue;
        known.add(trimmed);
        extras.push(trimmed);
    }
    return [...out, ...extras.sort()];
}

const OPTION_COLUMNS =
    'source_location_code, partner_equipment_code, grade_code, shift_code, warehouse_code';

/**
 * The dimension lists the "Add draw" composer renders. One read, five short columns —
 * the whole event history, because a code used once in 2025 is still a code the partner
 * can name today. Cheap next to the reads the page already makes, and the accessor
 * above would replace it with a ~30-row lookup.
 */
export async function loadQcDrawOptions(): Promise<QcDrawOptions> {
    const supabase = await createClient();

    // Two independent reads — the fact table for the four unexposed dimensions, and the
    // real grade accessor. Either can fail without taking the other down.
    const [{ data, error }, gradeDimension] = await Promise.all([
        supabase.from('cenapro_production_events').select(OPTION_COLUMNS).limit(20000),
        supabase.from('cenapro_grades').select('code, sort_order'),
    ]);

    const sources = new Set<string>();
    const machines = new Set<string>();
    const grades = new Set<string>();
    const shifts = new Set<string>();
    const warehouses = new Set<string>();

    for (const row of data ?? []) {
        if (row.source_location_code) sources.add(row.source_location_code);
        if (row.partner_equipment_code) machines.add(row.partner_equipment_code);
        if (row.grade_code) grades.add(row.grade_code);
        if (row.shift_code) shifts.add(row.shift_code);
        if (row.warehouse_code) warehouses.add(row.warehouse_code);
    }

    // A machine the constants do not know cannot be sorted into crushers vs kilns by
    // anything this layer can see (`partner_equipment.kind` is behind the same closed
    // schema), so it is listed under the kind its code SHAPE matches and otherwise with
    // the crushers — visible either way, and the RPC decides what it really is.
    const kilnLike = [...machines].filter(
        (code) => !CRUSHER_CODES.includes(code as (typeof CRUSHER_CODES)[number]) && /^RK/i.test(code),
    );
    const crusherLike = [...machines].filter(
        (code) => !kilnLike.includes(code) && !KILN_CODES.includes(code as (typeof KILN_CODES)[number]),
    );

    // The grade dimension, in the accessor's own `sort_order, code` order (the rows come
    // back ordered — nothing here re-sorts them). Blank/null codes are dropped: every
    // column on the view is nullable, and an empty option is one nobody can type.
    const dimensionGrades: string[] = [];
    for (const row of gradeDimension.data ?? []) {
        const code = (row.code ?? '').trim();
        if (code) dimensionGrades.push(code);
    }
    // The seeded constant is merged in UNDERNEATH rather than replaced. On a healthy
    // read it adds nothing (all four seeded grades are in the dimension); on a failed or
    // truncated one it is the floor that keeps this list at least as complete as it was
    // before the accessor existed — which matters because the QC sheet REFUSES a typed
    // grade that is missing from it.
    const canonicalGrades =
        dimensionGrades.length > 0 ? mergeCodes(dimensionGrades, GRADE_CODES) : [...GRADE_CODES];

    return {
        // DVO is a container van into WHSE 3 under its own batch code — a different
        // document, deferred, and refused by name.
        sources: mergeCodes(SOURCE_LOCATION_CODES, sources, ['DVO']),
        crushers: mergeCodes(CRUSHER_CODES, crusherLike),
        kilns: mergeCodes(KILN_CODES, kilnLike),
        grades: mergeCodes(canonicalGrades, grades),
        shifts: mergeCodes(SHIFT_CODES, shifts),
        // WHSE 3 is the kg/DVO warehouse; the RPC requires a flec-count one.
        warehouses: mergeCodes(FLEC_WAREHOUSES, warehouses, ['WHSE 3']),
        sides: [...WHSE_SIDES],
        // Non-fatal, and the fact-table failure is named first: it costs four dimensions
        // while the grade accessor costs one that still has a seeded floor beneath it.
        error: error
            ? describe('the draw entry options', error.message)
            : gradeDimension.error
              ? describe('the grade list', gradeDimension.error.message)
              : null,
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
