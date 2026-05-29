// ─── batch → month mapping ──────────────────────────────────────────────────
// Production batches are named after months (e.g., "MAY", "JUNE", "SEPT").
// The Daily tab filters production_shifts by production_batch directly, but
// Electricity and Trucks store calendar dates — so they need to translate the
// shared period's batch into a 0-indexed month to filter reading_date ranges.
//
// The DB's batch_code conventions are INCONSISTENT (verified empirically): some
// months use 3-letter abbreviations, others full names, and a few use a middle
// form (e.g., SEPT). This map handles ALL observed forms case-insensitively.
//
// Returns null when:
//   - batch is null (caller treats as "all months" → whole year / all data)
//   - the batch name doesn't map to a recognized month (e.g., a non-month batch
//     code) → caller falls back to "all months" rather than guessing.

const MONTH_BY_NAME: Record<string, number> = {
    // January
    JAN: 0,
    JANUARY: 0,
    // February
    FEB: 1,
    FEBRUARY: 1,
    // March
    MAR: 2,
    MARCH: 2,
    // April
    APR: 3,
    APRIL: 3,
    // May
    MAY: 4,
    // June
    JUN: 5,
    JUNE: 5,
    // July
    JUL: 6,
    JULY: 6,
    // August
    AUG: 7,
    AUGUST: 7,
    // September
    SEP: 8,
    SEPT: 8,
    SEPTEMBER: 8,
    // October
    OCT: 9,
    OCTOBER: 9,
    // November
    NOV: 10,
    NOVEMBER: 10,
    // December
    DEC: 11,
    DECEMBER: 11,
};

/**
 * Maps a month-name batch (any observed abbreviation or full form) to a
 * 0-indexed month (0 = January … 11 = December).
 *
 * @returns the month index, or null if `batch` is null/unrecognized.
 */
export function batchToMonth(batch: string | null): number | null {
    if (!batch) return null;
    const key = batch.trim().toUpperCase();
    if (!key) return null;
    const month = MONTH_BY_NAME[key];
    return month === undefined ? null : month;
}
