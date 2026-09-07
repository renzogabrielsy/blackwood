// =====================================================================
// Products — the data-agnostic contract the `/inventory/products` page
// consumes. The PORT; `./queries.ts` is the only adapter that fills it.
// =====================================================================
//
// NO PESO ANYWHERE IN THIS MODULE. There is no cost, price or value column on any
// products table, view or function, and none is derivable from them — so unlike RC IN,
// Blocking, RC Movement and most of `/analytics`, nothing here is gated by
// `canViewPrices()`, nothing needs nulling before a payload leaves the server, and every
// field below is safe for EVERY role including Production. If a price is ever added to
// the schema, that changes and this note goes with it.
//
// EVERY NUMBER IS THE DATABASE'S. `view_product_stage_balance` owns the definition of a
// balance (`opening_flecs + SUM(flec_delta)`), `view_product_ledger` owns the running
// tally (conditional window sums in SQL), `view_product_onhand` owns the pivot and the
// tonnage, and `view_product_portfolio` owns the whole position. Nothing in this module
// or its consumers recomputes any of them.

/** The eight stages the sheet has ever used, in the order the plant moves through them. */
export const PRODUCT_STAGES = [
    'PROD',
    'OLD PROD',
    'AYAG',
    'MAGNET',
    'FINAL',
    'BLENDED',
    'SUNDRY',
    'RECLASS',
] as const;

export type ProductStage = (typeof PRODUCT_STAGES)[number];

/**
 * A stage a grade actually holds, with the flecs and the tons the DB computed.
 *
 * `tons` is NULL — never 0 — when the grade has no `kg_per_flec` yet. "We do not know the
 * fill" and "it weighs nothing" are different answers (CONTEXT.md → Six things #1).
 */
export interface ProductStageCell {
    /** `'OTHER'` is `other_flecs`, the catch-all for a stage no column here knows about. */
    stage: ProductStage | 'OTHER';
    flecs: number;
    tons: number | null;
}

export interface ProductThresholds {
    ashMax: number | null;
    me50Under: number | null;
    vmMax: number | null;
}

/** One row of `view_product_onhand`, renamed and nothing else. */
export interface ProductGrade {
    gradeId: string;
    /** The canonical identity (`upper`, trimmed). What `?grade=` carries. */
    gradeCode: string;
    /** What a human calls it — the tab as currently typed. */
    displayName: string;
    sheetName: string;
    sortOrder: number;
    active: boolean;

    /** FINAL — the shippable half, and the page's headline. */
    finalFlecs: number;
    totalFlecs: number;
    /** FINAL ÷ 44, deliberately fractional — the sheet's own formula. */
    vansReady: number;

    /** Per grade and it MOVES; NULL when no movement states both numbers. */
    kgPerFlec: number | null;
    kgPerFlecAsOf: string | null;
    /** `> 1` ⇒ the grade has used more than one rate. A quiet footnote, never an alarm. */
    kgPerFlecDistinctCount: number;

    totalKg: number | null;
    totalTons: number | null;
    finalKg: number | null;
    finalTons: number | null;

    /** Every stage with a NON-ZERO balance, in `PRODUCT_STAGES` order, `OTHER` last. */
    stages: ProductStageCell[];
    /** Stages the grade has EVER used (balance zero or not) — the ledger's running lanes. */
    ledgerStages: ProductStage[];
    /** Non-zero ⇒ a stage exists that has no column here. Surface it, never drop it. */
    otherFlecs: number;

    openingFlecs: number;
    openingAsOf: string | null;
    firstMovementDate: string | null;
    lastMovementDate: string | null;
    movementCount: number;
    /** Movements with no `kg_delta`. Coverage for the "kg must not render as 0" rule. */
    movementsMissingKg: number;
    stageCount: number;

    thresholds: ProductThresholds;
    aliases: string[];

    /**
     * Rows where the SHEET's own printed running cell disagrees with the balance computed
     * from the sheet's own deltas. A fact about the SHEET, not about this grade's balance —
     * say it ONCE per grade, never as a red mark on every row.
     */
    sheetRunningDisagreementCount: number;
    /** Rows dated earlier than the row above them — a likely operator year typo. */
    dateOutOfOrderCount: number;
}

/** `view_product_portfolio` — ONE row, the whole position across active grades. */
export interface ProductPortfolio {
    totalFlecs: number;
    totalTons: number | null;
    finalFlecs: number;
    finalTons: number | null;
    vansReady: number;
    gradeCount: number;
    activeGradeCount: number;
    /** Grades with no `kg_per_flec` — so no tonnage. Explains a blank, never a zero. */
    gradesWithoutRate: number;
    movementCount: number;
    lastMovementDate: string | null;
}

/** One row of `view_product_ledger`. The running balances are SQL's; never recompute. */
export interface ProductLedgerRow {
    id: string;
    transactionDate: string;
    stage: string;
    /** Signed. NULL is possible in principle; it renders blank, never 0. */
    flecDelta: number | null;
    /** Signed, and NULL on one real row today — must not render as 0. */
    kgDelta: number | null;
    remarks: string | null;
    sourceRow: number | null;
    /** The SQL running balance of every stage as of this row, keyed by stage. */
    running: Partial<Record<ProductStage, number | null>>;
    totalFlecs: number | null;
    runningKg: number | null;
    /**
     * FALSE means the SHEET's printed cell disagrees with the sheet's own arithmetic.
     * It is a `~` marker and a once-per-grade note — NEVER a red row.
     */
    agreesWithSheet: boolean | null;
    dateOutOfSheetOrder: boolean;
}

/** A `products`-section finding from the latest sync run, flattened for a chip. */
export interface ProductsFinding {
    key: string;
    kind: string;
    kindLabel: string;
    title: string;
    severity: 'info' | 'attention' | 'high';
}

export interface ProductsData {
    /** ACTIVE grades only, ordered by `sort_order`. The tab rail reads this. */
    grades: ProductGrade[];
    /** The grade `?grade=` resolved to — the first active grade when it named none. */
    selected: ProductGrade | null;
    /** Every movement of the SELECTED grade, newest first. */
    ledger: ProductLedgerRow[];
    portfolio: ProductPortfolio | null;
    /** `ingestion_watermarks.products.last_run_at` — when the sheet was last read. */
    syncedAt: string | null;
    /** `products`-section findings from the latest finished run. Empty when unprivileged. */
    findings: ProductsFinding[];
    /** The run those findings came from, for the `/sync/cases?run=…` deep link. */
    runId: string | null;
    /** Surfaced, never thrown — the page renders whatever arrived. */
    error?: string;
}
