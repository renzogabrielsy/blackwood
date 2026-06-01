// STOPGAP — replace with generated cenapro types after PostgREST exposure.
//
// The `cenapro` Postgres schema is built and loaded, but it is NOT yet exposed
// via PostgREST, so `types/supabase.ts` does NOT include a `Database['cenapro']`
// namespace. These hand-written interfaces mirror the verified column shapes of
// the few cenapro objects this module consumes (confirmed via Supabase
// `execute_sql` against the live DB, 2026-06-01).
//
// Once Renzo flips the "Exposed schemas" toggle and `types/supabase.ts` is
// regenerated, delete this file and import the generated rows instead, e.g.
//   import type { Database } from '@/types/supabase'
//   type ProductionEventRow = Database['cenapro']['Tables']['production_event']['Row']
//   type FlecLedgerRow = Database['cenapro']['Functions']['flec_ledger']['Returns'][number]

// ─── cenapro.production_event ───────────────────────────────────────────────────
// Verified columns (information_schema.columns, 2026-06-01). Only the fields the
// Production view consumes are typed; the spine has more (notes/source_row/etc.).
export interface ProductionEventRow {
  id: string;
  recv_date: string;                       // date — 'yyyy-MM-dd'
  prod_date: string | null;                // nullable (partner takeback rows omit)
  batch: string;                           // month label ('MAY'), NOT derived from prod_date
  batch_year: number;                      // disambiguates same-month batches across years
  shift_code: string | null;               // M / E / N (only 'M' present in data)
  grade_code: string;                      // 3X50 / 2X6 / 3.5 / 4X8
  plant_code: string | null;               // W6 / W7 — null when source is FLEC
  warehouse_code: string | null;           // WHSE 1/2/5/7 — null on tank/plant-direct draws ("unplaced")
  source_location_code: string;            // TNK 1-4 / W6 / W7 / FLEC
  weight_kg: number;                        // numeric — comes back as number via supabase-js
  disposition_kind: 'flec_bagging' | 'partner_crusher' | 'partner_kiln';
  partner_equipment_code: string | null;   // C1-C4 / RK1-RK4 — set when disposition != flec_bagging
  flec_count: number | null;               // bag count
  whse_side: 'LS' | 'RS' | null;           // only for WHSE 1/2/5/7 rows
}

// ─── cenapro.flec_ledger(p_warehouse_code text, p_start_date date) ───────────────
// Verified RETURNS TABLE signature (pg_get_function_result, 2026-06-01).
export interface FlecLedgerRow {
  id: string;
  warehouse_code: string;
  grade_code: string;
  side: 'LS' | 'RS';
  recv_date: string;                       // date
  prod_date: string | null;
  source_location_code: string;
  disposition_kind: 'flec_bagging' | 'partner_crusher' | 'partner_kiln';
  partner_equipment_code: string | null;
  kg_moved: number;                        // per-row kg (NOT summed forward)
  flec_in: number | null;                  // populated on IN rows only
  flec_out: number | null;                 // populated on OUT rows only
  opening_seed: number;                    // baseline as of p_start_date, per (grade, side)
  flec_in_to_date: number;                 // cumulative ins from p_start_date forward
  flec_out_to_date: number;                // cumulative outs from p_start_date forward
  running_balance: number;                 // opening_seed + cumulative (in - out)
}

// ─── cenapro.flec_balance(p_warehouse_code text, p_start_date date) ──────────────
// Verified RETURNS TABLE signature (pg_get_function_result, 2026-06-01).
// NOTE: a (grade, side) with an opening balance but no events >= p_start_date will
// NOT appear here (see CENAPRO_SCHEMA.md §6.2 empty-period caveat).
export interface FlecBalanceRow {
  warehouse_code: string;
  grade_code: string;
  side: 'LS' | 'RS';
  current_flec: number;                    // last running_balance for the (grade, side)
  opening_seed: number;                    // the period's baseline (as of p_start_date)
  as_of: string;                           // recv_date of the latest counted row
}

// ─── cenapro.view_production_daily ──────────────────────────────────────────────
// Verified columns (information_schema.columns, 2026-06-01). Not surfaced as a
// screen in this task — typed here so a future cross-check view can consume it.
export interface ProductionDailyRow {
  plant_code: string | null;
  prod_date: string | null;
  batch: string;
  batch_year: number;
  tnk_or_source: string;
  shift_code: string | null;
  grade_code: string;
  c1_kg: number | null;
  c2_kg: number | null;
  c3_kg: number | null;
  c4_kg: number | null;
  rk1_kg: number | null;
  rk2_kg: number | null;
  rk3_kg: number | null;
  rk4_kg: number | null;
  flec_kg: number | null;
  total_kg: number | null;
}

// ─── Warehouse picker options (flec-count warehouses only) ──────────────────────
// WHSE 1/2/5/7 are flec-count (the v1 flec ledger). WHSE 3 is kg/DVO — DEFERRED,
// never surfaced as a flec warehouse.
export const FLEC_WAREHOUSES = ['WHSE 1', 'WHSE 2', 'WHSE 5', 'WHSE 7'] as const;
export type FlecWarehouse = (typeof FLEC_WAREHOUSES)[number];

// Default the Flec Inventory page here — WHSE 7 @ 2026-03-10 is where the seeded
// opening balances live (3X50 RS=53, 2X6 LS=26), so the page opens on real data.
export const DEFAULT_FLEC_WAREHOUSE: FlecWarehouse = 'WHSE 7';
export const DEFAULT_FLEC_START_DATE = '2026-03-10';

// ─── Disposition rendering ──────────────────────────────────────────────────────
// Maps the partner_equipment_code → a short human label for the equipment kind.
// flec_bagging → "Bag"; partner_crusher → "Crusher C1"; partner_kiln → "Kiln RK3".
export function formatDisposition(
  disposition: ProductionEventRow['disposition_kind'],
  equipment: string | null,
): string {
  if (disposition === 'flec_bagging') return 'Bag';
  if (disposition === 'partner_crusher') return equipment ? `Crusher ${equipment}` : 'Crusher';
  if (disposition === 'partner_kiln') return equipment ? `Kiln ${equipment}` : 'Kiln';
  return disposition;
}
