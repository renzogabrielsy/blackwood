// =====================================================================
// Products — server-only query layer (THE adapter)
// =====================================================================
// Shapes rows from the four `view_product_*` views (plus the `products`
// ingestion watermark and the latest sync run's findings) into the
// `ProductsData` contract in `./types.ts`.
//
// HARD RULE (CLAUDE.md): every balance, running tally, pivot and tonnage is
// computed in SQL. This module renames fields and does exactly ONE piece of
// arithmetic — `flecs x kg_per_flec / 1000` for a per-stage tonnage, which is
// the ONE formula `view_product_onhand` itself publishes (`total_tons`,
// `final_tons`) applied to a balance the DATABASE computed. It is a unit
// conversion of a published number, never a second definition of a balance,
// and `scripts/verify-products-grid.ts` pins it by proving the converted FINAL
// tonnage equals the view's own `final_tons` on every grade.
//
// NO PESO ANYWHERE — see `./types.ts`. Nothing here calls `canViewPrices()`
// and nothing needs nulling before the payload leaves the server.
// =====================================================================

import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { getUserRole } from '@/lib/auth';
import { PRIVILEGED_ROLES } from '@/types/auth';
import { flattenRunFindings } from '@/lib/sync/findings';
import type { SyncRunResult } from '@/app/(app)/sync/types';
import type { Tables } from '@/types/supabase';

import {
    PRODUCT_STAGES,
    type ProductGrade,
    type ProductLedgerRow,
    type ProductPortfolio,
    type ProductStage,
    type ProductStageCell,
    type ProductsData,
    type ProductsFinding,
} from './types';

type OnhandRow = Tables<'view_product_onhand'>;
type LedgerRow = Tables<'view_product_ledger'>;
type StageRow = Tables<'view_product_stage_balance'>;
type PortfolioRow = Tables<'view_product_portfolio'>;

const EMPTY: ProductsData = {
    grades: [],
    selected: null,
    ledger: [],
    portfolio: null,
    syncedAt: null,
    findings: [],
    runId: null,
};

/** `null`/`undefined` stay `null`; anything numeric becomes a number. NULL is never 0. */
function nn(value: number | string | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

/** For counts, where the view already `coalesce`s and 0 is the honest answer. */
function n0(value: number | string | null | undefined): number {
    return nn(value) ?? 0;
}

/** The stage's own key in the pivot — `OLD PROD` is `old_prod_flecs`. */
const STAGE_PIVOT_KEY: Readonly<Record<ProductStage, keyof OnhandRow>> = {
    PROD: 'prod_flecs',
    'OLD PROD': 'old_prod_flecs',
    AYAG: 'ayag_flecs',
    MAGNET: 'magnet_flecs',
    FINAL: 'final_flecs',
    BLENDED: 'blended_flecs',
    SUNDRY: 'sundry_flecs',
    RECLASS: 'reclass_flecs',
};

/** The ledger view's running column for each stage. */
const STAGE_RUNNING_KEY: Readonly<Record<ProductStage, keyof LedgerRow>> = {
    PROD: 'prod_flecs',
    'OLD PROD': 'old_prod_flecs',
    AYAG: 'ayag_flecs',
    MAGNET: 'magnet_flecs',
    FINAL: 'final_flecs',
    BLENDED: 'blended_flecs',
    SUNDRY: 'sundry_flecs',
    RECLASS: 'reclass_flecs',
};

/**
 * Tons for a stage: the DB's own `flecs x kg_per_flec / 1000`, rounded to 3dp exactly as
 * `view_product_onhand.total_tons` rounds. NULL — never 0 — when the grade has no rate.
 */
function tonsOf(flecs: number, kgPerFlec: number | null): number | null {
    if (kgPerFlec === null) return null;
    return Math.round(((flecs * kgPerFlec) / 1000) * 1000) / 1000;
}

/**
 * The grade summary. `stages` carries every stage with a NON-ZERO balance (plus the
 * `OTHER` catch-all when it is non-zero, because a stage with no column here must be
 * surfaced rather than dropped); `ledgerStages` carries every stage the grade has EVER
 * used, which is what the running-tally lanes are — a stage with movements and a zero
 * balance (6X50's SUNDRY, 10 movements) still belongs in the ledger.
 */
function toGrade(row: OnhandRow, stagesUsed: ReadonlySet<string>): ProductGrade {
    const kgPerFlec = nn(row.kg_per_flec);

    const stages: ProductStageCell[] = [];
    for (const stage of PRODUCT_STAGES) {
        const flecs = n0(row[STAGE_PIVOT_KEY[stage]] as number | null);
        if (flecs !== 0) stages.push({ stage, flecs, tons: tonsOf(flecs, kgPerFlec) });
    }
    const otherFlecs = n0(row.other_flecs);
    if (otherFlecs !== 0) {
        stages.push({ stage: 'OTHER', flecs: otherFlecs, tons: tonsOf(otherFlecs, kgPerFlec) });
    }

    return {
        gradeId: row.grade_id ?? '',
        gradeCode: row.grade_code ?? '',
        displayName: row.display_name || row.sheet_name || row.grade_code || '',
        sheetName: row.sheet_name ?? '',
        sortOrder: n0(row.sort_order),
        active: row.active !== false,

        finalFlecs: n0(row.final_flecs),
        totalFlecs: n0(row.total_flecs),
        vansReady: n0(row.vans_ready),

        kgPerFlec,
        kgPerFlecAsOf: row.kg_per_flec_as_of ?? null,
        kgPerFlecDistinctCount: n0(row.kg_per_flec_distinct_count),

        totalKg: nn(row.total_kg),
        totalTons: nn(row.total_tons),
        finalKg: nn(row.final_kg),
        finalTons: nn(row.final_tons),

        stages,
        ledgerStages: PRODUCT_STAGES.filter((s) => stagesUsed.has(s)),
        otherFlecs,

        openingFlecs: n0(row.opening_flecs),
        openingAsOf: row.opening_as_of ?? null,
        firstMovementDate: row.first_movement_date ?? null,
        lastMovementDate: row.last_movement_date ?? null,
        movementCount: n0(row.movement_count),
        movementsMissingKg: n0(row.movements_missing_kg),
        stageCount: n0(row.stage_count),

        thresholds: {
            ashMax: nn(row.ash_max),
            me50Under: nn(row.me50_under),
            vmMax: nn(row.vm_max),
        },
        aliases: Array.isArray(row.aliases) ? row.aliases : [],

        sheetRunningDisagreementCount: n0(row.sheet_running_disagreement_count),
        dateOutOfOrderCount: n0(row.date_out_of_order_count),
    };
}

function toLedgerRow(row: LedgerRow): ProductLedgerRow {
    const running: Partial<Record<ProductStage, number | null>> = {};
    for (const stage of PRODUCT_STAGES) {
        running[stage] = nn(row[STAGE_RUNNING_KEY[stage]] as number | null);
    }
    return {
        id: row.movement_id ?? '',
        transactionDate: row.transaction_date ?? '',
        stage: row.stage ?? '',
        flecDelta: nn(row.flec_delta),
        kgDelta: nn(row.kg_delta),
        remarks: row.remarks ?? null,
        sourceRow: nn(row.source_row),
        running,
        totalFlecs: nn(row.total_flecs),
        runningKg: nn(row.running_kg),
        agreesWithSheet: row.agrees_with_sheet ?? null,
        dateOutOfSheetOrder: row.date_out_of_sheet_order === true,
    };
}

function toPortfolio(row: PortfolioRow): ProductPortfolio {
    return {
        totalFlecs: n0(row.total_flecs),
        totalTons: nn(row.total_tons),
        finalFlecs: n0(row.final_flecs),
        finalTons: nn(row.final_tons),
        vansReady: n0(row.vans_ready),
        gradeCount: n0(row.grade_count),
        activeGradeCount: n0(row.active_grade_count),
        gradesWithoutRate: n0(row.grades_without_rate),
        movementCount: n0(row.movement_count),
        lastMovementDate: row.last_movement_date ?? null,
    };
}

/**
 * Which grade the page is showing.
 *
 * `?grade=` is matched case-insensitively against the CODE first (the canonical identity)
 * and then against the display/sheet name, so both `?grade=KURARAY%203X50` and
 * `?grade=Kuraray%203x50` land. A param naming no grade — a typo, a retired code, a stale
 * bookmark — resolves to the DEFAULT rather than half-selecting anything, exactly as
 * `?grid=` and `?month=` do elsewhere.
 */
export function resolveGrade(
    grades: readonly ProductGrade[],
    param: string | null | undefined,
): ProductGrade | null {
    if (grades.length === 0) return null;
    const wanted = (param ?? '').trim().toUpperCase();
    if (wanted) {
        const byCode = grades.find((g) => g.gradeCode.toUpperCase() === wanted);
        if (byCode) return byCode;
        const byName = grades.find(
            (g) =>
                g.displayName.toUpperCase() === wanted || g.sheetName.toUpperCase() === wanted,
        );
        if (byName) return byName;
    }
    return grades[0];
}

/**
 * `products`-section findings from the LATEST finished sync run.
 *
 * PRIVILEGED ONLY (Owner / Admin / Dev), derived through `getUserRole()` so the
 * dev-impersonation cookie is respected — the chips link into `/sync`, which those roles
 * are the only ones who can act in. FAILS QUIET: every failure path returns no findings,
 * because a missing chip costs a click into the panel while a fabricated one sends
 * somebody looking for work that is not there. This is the same read
 * `app/(app)/sync/needs-you.ts` makes, over the same `flattenRunFindings`, so the chips
 * can never disagree with the panel about what the run said.
 */
async function fetchProductFindings(
    supabase: Awaited<ReturnType<typeof createClient>>,
    userId: string,
): Promise<{ findings: ProductsFinding[]; runId: string | null }> {
    try {
        const role = await getUserRole(userId);
        if (!PRIVILEGED_ROLES.includes(role)) return { findings: [], runId: null };

        const { data, error } = await supabase
            .from('sync_runs')
            .select('id, result')
            .not('result', 'is', null)
            .order('started_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error || !data) return { findings: [], runId: null };

        const findings = flattenRunFindings(data.result as unknown as SyncRunResult)
            .filter((f) => f.section === 'products')
            .map<ProductsFinding>((f) => ({
                key: f.key,
                kind: f.kind,
                kindLabel: f.kindLabel,
                title: f.title,
                severity: f.severity,
            }));
        return { findings, runId: data.id };
    } catch {
        return { findings: [], runId: null };
    }
}

/**
 * THE adapter. One call, four reads in parallel plus two small independent ones.
 *
 * The ledger is read for the SELECTED grade only — 331 rows at the widest today against
 * 808 in total — and through `fetchAllRows`, so a grade that one day outgrows PostgREST's
 * 1000-row cap pages instead of being silently truncated to its OLDEST 1000 rows.
 */
export async function getProductsData(gradeParam?: string | null): Promise<ProductsData> {
    const supabase = await createClient();

    const [onhandRes, stageRes, portfolioRes, watermarkRes, userRes] = await Promise.all([
        supabase.from('view_product_onhand').select('*').order('sort_order', { ascending: true }),
        supabase.from('view_product_stage_balance').select('grade_id, stage, movement_count'),
        supabase.from('view_product_portfolio').select('*').maybeSingle(),
        supabase
            .from('ingestion_watermarks')
            .select('last_run_at')
            .eq('report_type', 'products')
            .maybeSingle(),
        supabase.auth.getUser(),
    ]);

    if (onhandRes.error) {
        return { ...EMPTY, error: `Products could not be loaded: ${onhandRes.error.message}` };
    }

    // Stages a grade has EVER used — a zero-balance stage with movements is still a lane
    // in its running tally, which the `onhand` pivot alone cannot tell us.
    const stagesByGrade = new Map<string, Set<string>>();
    for (const s of (stageRes.data ?? []) as Pick<StageRow, 'grade_id' | 'stage'>[]) {
        if (!s.grade_id || !s.stage) continue;
        const set = stagesByGrade.get(s.grade_id) ?? new Set<string>();
        set.add(s.stage);
        stagesByGrade.set(s.grade_id, set);
    }

    // ACTIVE only. The sync NEVER deactivates a grade — `active = false` can only be set
    // by hand — so this filter is a human decision being honoured, not an auto-retirement.
    const grades = ((onhandRes.data ?? []) as OnhandRow[])
        .filter((r) => r.active !== false)
        .map((r) => toGrade(r, stagesByGrade.get(r.grade_id ?? '') ?? new Set()));

    const selected = resolveGrade(grades, gradeParam);

    let ledger: ProductLedgerRow[] = [];
    let ledgerError: string | undefined;
    if (selected) {
        try {
            const rows = await fetchAllRows<LedgerRow>((from, to) =>
                supabase
                    .from('view_product_ledger')
                    .select('*')
                    .eq('grade_id', selected.gradeId)
                    // Newest first — the sheet's own order, reversed, which is what an
                    // operator checks. `source_row` breaks a same-day tie the way the tab
                    // itself is laid out.
                    .order('transaction_date', { ascending: false })
                    .order('source_row', { ascending: false, nullsFirst: false })
                    .range(from, to),
            );
            ledger = rows.map(toLedgerRow);
        } catch (e) {
            ledgerError = `The running tally could not be loaded: ${
                e instanceof Error ? e.message : String(e)
            }`;
        }
    }

    const userId = userRes.data.user?.id;
    const { findings, runId } = userId
        ? await fetchProductFindings(supabase, userId)
        : { findings: [], runId: null };

    return {
        grades,
        selected,
        ledger,
        portfolio: portfolioRes.data ? toPortfolio(portfolioRes.data as PortfolioRow) : null,
        syncedAt: watermarkRes.data?.last_run_at ?? null,
        findings,
        runId,
        error: ledgerError,
    };
}
