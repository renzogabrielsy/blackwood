/**
 * settlement.ts — the DATE-SETTLEMENT LEDGER pure core (2026-07-12, Renzo's directive).
 *
 * Once a transaction_date's DB feeding total agrees with the RC MOVEMENT sheet's daily
 * total (two independent witnesses), that date is SETTLED and every future sync run
 * skips it entirely — no extract-compare, no classify, no reconcile, no gate, no flags.
 * This kills the endless re-ingestion of already-balanced past months: the PROPOSED
 * workbook permanently carries every day-tab the operator has ever filled in, so
 * without a ledger every run re-walks that entire history through both HARD gates.
 *
 * PURE + deterministic: no DB, no I/O — mirrors the `workflows/creationRaceHolds.ts`
 * split (pure core here, DB/IO wrapping in `runSync.ts::persistSettlements`) so the
 * settle criterion is unit-testable without a fake DbClient.
 *
 * Persisted by `runSync.ts::persistSettlements`; consumed by
 * `reports/rc_out/index.ts::runReport` (chokepoint A) and
 * `runSync.ts::reconcileRcOutShadow` (chokepoint B). NEVER written by `classify.ts`
 * (parity-frozen) or by the read-only `rc_movement_audit` report (which stays "never
 * writes to the DB" — specs/rc_movement_audit.md §1).
 */
import type { RcOutSums } from "../reports/rc_out/reconcile.js";

/** Tolerance for the settle criterion — reuses the existing GATE 1/2 tolerance (50kg). */
export const SETTLEMENT_TOLERANCE_KG = 50;

/** Full-history backfill floor for the DB-sum read. Bounded (not unbounded "all history")
 *  — the DB has no rc_out rows before this date, so fixing it as a floor costs nothing. */
export const SETTLEMENT_BACKFILL_FLOOR = "2025-01-01";

export interface QualifyingSettlement {
  transaction_date: string;
  db_sum_kg: number;
  movement_kg: number;
}

/**
 * Compute the newly-qualifying settlement rows (dates NOT already in `alreadySettled`
 * whose DB sum and movement total agree). STRICT settle criterion (safety-critical —
 * silence is never agreement):
 *
 *   dbSum != null && dbSum > 0                          (DB non-empty for the date)
 *   && movement[date] != null                            (a real second witness exists)
 *   && Math.abs(dbSum - movement[date]) <= toleranceKg   (they agree within tolerance)
 *
 * A date with an empty/zero DB sum, or with no movement entry at all, is NEVER settled
 * — an absent witness is not agreement. Only dates present in `dbSums` are considered
 * candidates (a movement-only date with no DB rows has nothing to settle).
 */
export function computeQualifyingSettlements(
  dbSums: RcOutSums,
  movementByDate: Record<string, number>,
  alreadySettled: ReadonlySet<string>,
  toleranceKg: number = SETTLEMENT_TOLERANCE_KG,
): QualifyingSettlement[] {
  const out: QualifyingSettlement[] = [];
  for (const [date, dbSum] of Object.entries(dbSums)) {
    if (alreadySettled.has(date)) continue;
    if (dbSum == null || dbSum <= 0) continue; // DB empty for this date — never settle
    const hasMovement = Object.prototype.hasOwnProperty.call(movementByDate, date);
    const mv = hasMovement ? movementByDate[date] : null;
    if (mv === null || mv === undefined) continue; // no second witness — silence is not agreement
    if (Math.abs(dbSum - mv) > toleranceKg) continue; // disagreement — never settle
    out.push({ transaction_date: date, db_sum_kg: dbSum, movement_kg: mv });
  }
  return out;
}
