// ─────────────────────────────────────────────────────────────────────────────
// Daily ledger — derived per-shift metrics (client-safe, no aggregation).
//
// The unified desktop grid computes DT TTL / PROD HRS / PROD LOSS / TTL WASTE
// inline from a GridRow (shift default = 8h). The mobile card view must show the
// SAME derived numbers, so this pure helper captures that exact formula in ONE
// place. It operates on the grid's own `buildGridRows()` output — the single
// source of truth — never a second data path.
//
// These are trivial per-row derivations (sum + ratio), NOT the SQL-owned
// aggregations the HARD RULE reserves for the DB.
// ─────────────────────────────────────────────────────────────────────────────

import type { GridRow } from "./daily-ledger-grid";

export interface DailyDerivedMetrics {
  /** Downtime hours field, parsed. */
  dtHrs: number;
  /** Downtime minutes field, parsed. */
  dtMins: number;
  /** DT TTL — total downtime in hours (dtHrs + dtMins/60). */
  dtTtl: number;
  /** PROD HRS — productive hours (8h shift default − DT TTL). */
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
  const prodHrs = 8 - dtTtl;

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
