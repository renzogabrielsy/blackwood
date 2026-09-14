// ─────────────────────────────────────────────────────────────────────────────
// Daily ledger — derived per-shift metrics (client-safe, no aggregation).
//
// The unified desktop grid computes DT TTL / PROD HRS / PROD LOSS / TTL WASTE
// inline from a GridRow. The mobile card view must show the SAME derived numbers,
// so this pure helper captures that exact formula in ONE place. It operates on the
// grid's own `buildGridRows()` output — the single source of truth — never a second
// data path.
//
// THE SHIFT LENGTH IS ONE CONSTANT NOW (2026-09-14, L-051b). It used to be the
// literal `8` written out in four places — here, the desktop grid's inline compute
// (twice, plus the footer aggregate), the v2 save's `ASSUMED_SHIFT_HRS`, and the
// save action's `?? 8` — while the SYNC stored `12` on every row it wrote. Renzo
// settled it: a normal shift is NINE hours (08:00-17:00 with an hour off), which is
// also what all 158 rows of his own `MASTER ICTC INPUT FILE V1.xlsx` already said.
// Every PROD HRS site now reads `DEFAULT_SHIFT_HRS` from here, and
// `DEFAULT_SHIFT_HRS` in `workers/sync/src/reports/production/shiftHours.ts` — the
// number that gets STORED — must always equal it.
//
// These are trivial per-row derivations (sum + ratio), NOT the SQL-owned
// aggregations the HARD RULE reserves for the DB.
// ─────────────────────────────────────────────────────────────────────────────

import type { GridRow } from "./daily-ledger-grid";

/**
 * A normal shift, in hours (Renzo, 2026-09-14). 12 h is an overtime day, and the sync
 * records which one a stored row is in `production_downtime.shift_hrs_source`. THE ONE
 * definition on the app side — never write the number out again.
 */
export const DEFAULT_SHIFT_HRS = 9;

export interface DailyDerivedMetrics {
  /** Downtime hours field, parsed. */
  dtHrs: number;
  /** Downtime minutes field, parsed. */
  dtMins: number;
  /** DT TTL — total downtime in hours (dtHrs + dtMins/60). */
  dtTtl: number;
  /** PROD HRS — productive hours (`DEFAULT_SHIFT_HRS` − DT TTL). */
  prodHrs: number;
  /** TTL KG for the run, parsed. */
  ttlKg: number;
  /** TTL WASTE — sum of the 8 waste streams (kg). */
  totalWaste: number;
  /** PROD LOSS % — waste / (ttlKg + waste), or null when denominator is 0. */
  prodLossPct: number | null;
}

/** Derive the computed downtime/waste metrics for one ledger row.
 *  Mirrors the desktop grid's inline compute (daily-ledger-grid.tsx). */
export function deriveDailyMetrics(row: GridRow): DailyDerivedMetrics {
  const dtHrs = parseFloat(row.dt_hrs) || 0;
  const dtMins = parseFloat(row.dt_mins) || 0;
  const dtTtl = dtHrs + dtMins / 60;
  const prodHrs = DEFAULT_SHIFT_HRS - dtTtl;

  const totalWaste =
    (parseFloat(row.rs1a) || 0) +
    (parseFloat(row.rs1b) || 0) +
    (parseFloat(row.bf) || 0) +
    (parseFloat(row.rs23) || 0) +
    (parseFloat(row.rs5) || 0) +
    (parseFloat(row.trml1) || 0) +
    (parseFloat(row.trml2) || 0) +
    (parseFloat(row.grit) || 0);

  const ttlKg = parseFloat(row.ttl_kg) || 0;
  const prodLossPct =
    ttlKg + totalWaste > 0 ? (totalWaste / (ttlKg + totalWaste)) * 100 : null;

  return { dtHrs, dtMins, dtTtl, prodHrs, ttlKg, totalWaste, prodLossPct };
}

/** Does this row carry any downtime OR waste data worth a card badge?
 *  Only meaningful on the primary row of a shift. */
export function hasDowntimeOrWaste(m: DailyDerivedMetrics): boolean {
  return m.dtTtl > 0 || m.totalWaste > 0;
}
