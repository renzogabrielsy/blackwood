// ═════════════════════════════════════════════════════════════════════════════════
// The PLANT OPERATIONS LEDGER — the data-agnostic interface the three drafts consume.
//
// DEV DRAFT. No Supabase, no server action, no tenant module imports this file. It is the
// PORT half of the hexagon (CLAUDE.md → "Architecture: Hexagonal"): the three layouts are
// the application core, this is the contract they declare, and `data.ts` is a static mock
// ADAPTER standing in for the live one. When the real adapter arrives it fills these same
// shapes and not one layout component changes.
//
// The shape is Renzo's `Q3 2026` Excel tab, read literally:
//
//   ONE ROW PER CALENDAR DAY, rest days included and blank, grouped by PRODUCTION BATCH
//   (the campaign clock — "JULY" opens 2026-06-30, exactly as the app already reasons in
//   `/inventory/rc-movement`).
//
// and his `EOQ3 2026` tab is `CampaignRollup` below.
// ═════════════════════════════════════════════════════════════════════════════════

/** The three finished grades the plant runs. Ordered as the sheet orders them. */
export const GRADES = ['3X50', '2X6', '4X8'] as const;
export type Grade = (typeof GRADES)[number];

/**
 * The eight waste streams, in the sheet's own left-to-right order.
 *
 * `key` is the field; `label` is the column head. They are declared together so a layout
 * can build a column per stream without a second list to keep in step.
 */
export const WASTE_STREAMS = [
    { key: 'trml1', label: 'TRML 1' },
    { key: 'trml2', label: 'TRML 2' },
    { key: 'rs1a', label: 'RS1A' },
    { key: 'rs1b', label: 'RS1B' },
    { key: 'rs3', label: 'RS3' },
    { key: 'rs5', label: 'RS5' },
    { key: 'bf', label: 'BF' },
    { key: 'grits', label: 'GRITS' },
] as const;
export type WasteKey = (typeof WASTE_STREAMS)[number]['key'];

/** A block's life stage, mirroring `batch_status` without importing the enum. */
export type BlockState = 'STORED' | 'IN-USE' | 'CLOSED';

/**
 * One line of the day's BLOCKS USED panel — a single block the plant drew from that day.
 *
 * Several per day is the normal case (Renzo's sheet routinely lists 6–10), which is
 * precisely why this cannot be columns on the day row and has to be a child collection.
 */
export interface BlockFeed {
    batchCode: string;
    blockLoc: string;
    dateOpen: string;
    /** `null` while the block is still open. */
    dateClose: string | null;
    state: BlockState;
    /** Kg drawn from THIS block on THIS day. */
    fedKg: number;
    /** Kg that ever arrived into the block (its whole life, not this day). */
    arrivedKg: number;
    /**
     * Weight the block lost sitting in the yard — evaporation and resiko.
     *
     * Only meaningful once the block is CLOSED; it reads 0 while it is open, because
     * charcoal still in the pile is not loss yet (CLAUDE.md → "Resiko / evaporation").
     */
    resikoKg: number;
}

/** One shift's own numbers — the breakdown a day row opens into. */
export interface ShiftDetail {
    shift: 1 | 2;
    /** `06:00–18:00` / `18:00–06:00`. Display only. */
    window: string;
    fedKg: number;
    producedKg: number;
    dtHours: number;
    /** Blank when the shift ran clean. */
    dtReason: string;
    producedByGrade: Record<Grade, number>;
    /** The shift supervisor, so a breakdown has a name on it. */
    supervisor: string;
}

/**
 * ONE CALENDAR DAY. Present for every date in the campaign's span, rest days included:
 * a blank Sunday row is information (the plant did not run), and dropping it would make
 * the month read as if it had 26 days.
 */
export interface LedgerDay {
    /** `yyyy-MM-dd`. */
    date: string;
    /** `Mon` … `Sun`. */
    day: string;
    /** The campaign this day belongs to — the BATCH clock, never the calendar month. */
    campaignId: string;
    /** True on a day the plant did not run. Every figure below is 0 on such a day. */
    restDay: boolean;
    /** Weighted-average ₱ per kg of the charcoal fed that day. `null` on a blank day. */
    fedPhpKg: number | null;
    fedKg: number;
    producedKg: number;
    /** `fedKg − producedKg`. Moisture, volatiles and the eight waste streams together. */
    lossKg: number;
    shifts: number;
    dtHours: number;
    producedByGrade: Record<Grade, number>;
    /**
     * The eight RECORDED waste streams.
     *
     * They do NOT sum to `lossKg` and are not meant to: most of the loss is moisture and
     * volatiles driven off in the retort, which nobody weighs. Only what is physically
     * swept up is here.
     */
    waste: Record<WasteKey, number>;
    blocks: BlockFeed[];
    shiftDetail: ShiftDetail[];
}

/**
 * A PRODUCTION BATCH — "JULY 2026". The grouping unit of the ledger and the thing a
 * group view is built out of.
 */
export interface Campaign {
    id: string;
    /** `JULY 2026`. */
    label: string;
    /** `JULY`. */
    batch: string;
    year: number;
    /** First and last calendar day of the campaign — NOT the calendar month's. */
    startDate: string;
    endDate: string;
}

/**
 * One row of the `EOQ` tab — a campaign's month-end rollup.
 *
 * Every figure is a plain sum or a ratio of the days above it. In the live version these
 * would be SQL, never TypeScript (CLAUDE.md → "Never calculate weighted averages in
 * TypeScript"); the mock computes them once, here, so the drafts only ever read them.
 */
export interface CampaignRollup {
    campaignId: string;
    label: string;
    rcFedKg: number;
    producedKg: number;
    /** A FRACTION (0.8292), not a percent — the convention every yield view uses. */
    yieldPct: number;
    lossKg: number;
    /** Weight the campaign's CLOSED blocks lost in the yard. */
    blockResikoKg: number;
    /** Weighted-average delivered ₱/kg of everything fed. */
    fedPrice: number;
    /** Delivered price re-spread over the kilos that actually reached the plant. */
    actualFedPrice: number;
    /** `fedPrice ÷ yield` — delivered ₱ per kilo of finished product. */
    pcCost: number;
    /** `actualFedPrice ÷ yield` — the same figure carrying the shrinkage. */
    truePcCost: number;
    /** Raw-charcoal stock still in the yard at campaign end. */
    rcInventoryTons: number;
    rcInventoryPhp: number;
    /** What was BOUGHT during the campaign. */
    buyingTons: number;
    buyingPhp: number;
    workingDays: number;
    restDays: number;
    /** Downtime hours over the campaign. A genuine 0 is a claim, not a blank. */
    dtHours: number;
    blocksOpened: number;
    blocksClosed: number;
}

/** What the mock adapter hands the layouts. One object, like `DigestData`. */
export interface OpsLedgerData {
    campaigns: Campaign[];
    /** Every day of every campaign, in date order. */
    days: LedgerDay[];
    rollups: CampaignRollup[];
    /** Grades actually produced across the mock, in `GRADES` order. */
    grades: Grade[];
    /**
     * Whether the viewer may see ₱ — the mock's stand-in for `canViewPrices()`.
     *
     * It rides in the payload rather than being read from a hook on purpose: in the live
     * version the SERVER decides and nulls the ₱ fields before they leave, and a draft
     * that reaches for the flag itself would teach the wrong shape.
     */
    canViewPrices: boolean;
}
