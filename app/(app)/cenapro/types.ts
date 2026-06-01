// Cenapro module row types — derived from the GENERATED Supabase types.
//
// The cenapro data is reached through read-only accessors that live in the
// already-served `public` schema (so the normal client reaches them — no
// `.schema('cenapro')`):
//   • view  `public.cenapro_production_events`   — the 16 production-event columns
//   • rpc   `public.cenapro_flec_balance(...)`    — closing count per (grade, side)
//   • rpc   `public.cenapro_flec_ledger(...)`     — the show-your-math movement detail
//
// We derive the row shapes straight from `types/supabase.ts` so they stay in
// lockstep with the DB after every `supabase gen types`. NOTE: PostgREST types
// VIEW columns as nullable (it can't prove non-null), so `ProductionEventRow`
// fields are `T | null` — consumers guard accordingly. The two SRF Returns are
// non-null but widen narrow unions to `string` (e.g. `disposition_kind`, `side`).

import type { Database } from '@/types/supabase';

// ─── public.cenapro_production_events (VIEW) ─────────────────────────────────────
// 16 UI columns: id, recv_date, prod_date, batch, batch_year, shift_code,
// grade_code, plant_code, warehouse_code, source_location_code, weight_kg,
// disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag.
export type ProductionEventRow = Database['public']['Views']['cenapro_production_events']['Row'];

// ─── public.cenapro_flec_ledger(p_warehouse_code text, p_start_date date) ────────
// One element of the RETURNS TABLE. The show-your-math movement detail.
export type FlecLedgerRow = Database['public']['Functions']['cenapro_flec_ledger']['Returns'][number];

// ─── public.cenapro_flec_balance(p_warehouse_code text, p_start_date date) ───────
// One element of the RETURNS TABLE. Closing count per (grade, side).
// NOTE: a (grade, side) with an opening balance but no events >= p_start_date will
// NOT appear here (see CENAPRO_SCHEMA.md §6.2 empty-period caveat).
export type FlecBalanceRow = Database['public']['Functions']['cenapro_flec_balance']['Returns'][number];

// ─── public.cenapro_opening_balances(p_warehouse_code text, p_as_of_date date) ───
// CURRENT effective opening per (grade, side) for the warehouse as of the date —
// `greatest period_start_date ≤ as_of`, tie-broken by greatest `created_at`. This
// is what seeds the editable STARTING block (matches the ledger seed rule). Unlike
// `cenapro_flec_balance`, this returns a (grade, side) even with no events forward.
export type OpeningBalanceRow = Database['public']['Functions']['cenapro_opening_balances']['Returns'][number];

// ─── public.cenapro_opening_balance_history(p_warehouse_code text) ───────────────
// ALL append-only opening entries (newest-first per grade×side) — the backtracking
// data. Each row: warehouse_code, grade_code, side, period_start_date,
// opening_flec_count, created_at (+ id).
export type OpeningBalanceHistoryRow =
    Database['public']['Functions']['cenapro_opening_balance_history']['Returns'][number];

// ─── A changed STARTING cell, queued for the append-only write ───────────────────
// The grid sends only the cells the operator actually edited. `effectiveDate` is the
// page's START date — every save inserts a NEW opening row dated that day (append-only,
// never an overwrite). See `saveOpeningBalances` in inventory/actions.ts.
export interface OpeningBalanceCellChange {
    warehouse: string;
    grade: GradeCode;
    side: WhseSide;
    effectiveDate: string;
    count: number;
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

// ─── Editable-ledger lookup constants (FK-safe dropdown options) ─────────────────
// The categorical production-event columns are FK-constrained to the seeded
// `cenapro` lookup tables. Those lookups are NOT exposed over PostgREST, so the
// canonical option lists are hardcoded here. Each string MUST match a seeded `code`
// value EXACTLY — a mismatch makes the FK insert fail. Keep this block in lockstep
// with the cenapro seed migration.
//
// Nullable columns (plant_code, warehouse_code) also offer a "— None" choice in the
// UI (rendered as a blank/unplaced value, stored as NULL). Leaving warehouse_code
// null marks a row "unplaced"; setting it is how an operator places a bagging row.

export const SHIFT_CODES = ['M', 'E', 'N'] as const;
export type ShiftCode = (typeof SHIFT_CODES)[number];

export const GRADE_CODES = ['3X50', '2X6', '3.5', '4X8'] as const;
export type GradeCode = (typeof GRADE_CODES)[number];

// plant_code is nullable — null = unspecified plant.
export const PLANT_CODES = ['W6', 'W7', 'W6/W7', 'DVO'] as const;
export type PlantCode = (typeof PLANT_CODES)[number];

// warehouse_code is nullable — null = an "unplaced" row (the 181 bagging rows Renzo
// fixes by assigning a warehouse). WHSE 3 is intentionally absent (kg/DVO, deferred).
export const WAREHOUSE_CODES = ['WHSE 1', 'WHSE 2', 'WHSE 3', 'WHSE 5', 'WHSE 7'] as const;
export type WarehouseCode = (typeof WAREHOUSE_CODES)[number];

export const SOURCE_LOCATION_CODES = [
  'TNK 1',
  'TNK 2',
  'TNK 3',
  'TNK 4',
  'W6',
  'W7',
  'FLEC',
  'DVO',
] as const;
export type SourceLocationCode = (typeof SOURCE_LOCATION_CODES)[number];

export const DISPOSITION_KINDS = ['flec_bagging', 'partner_crusher', 'partner_kiln'] as const;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

// Human labels for the disposition dropdown + the column filter menu.
export const DISPOSITION_LABELS: Record<string, string> = {
  flec_bagging: 'Bag',
  partner_crusher: 'Crusher',
  partner_kiln: 'Kiln',
};

// Partner equipment is disposition-dependent:
//   • flec_bagging   → NO equipment (must be null)
//   • partner_crusher → one of the crushers C1–C4
//   • partner_kiln    → one of the kilns RK1–RK4
export const CRUSHER_CODES = ['C1', 'C2', 'C3', 'C4'] as const;
export const KILN_CODES = ['RK1', 'RK2', 'RK3', 'RK4'] as const;

// whse_side — left/right side of the warehouse, or blank.
export const WHSE_SIDES = ['LS', 'RS'] as const;
export type WhseSide = (typeof WHSE_SIDES)[number];

/**
 * Valid `partner_equipment_code` options for a given disposition. Returns [] for
 * flec_bagging (no equipment) and for any unknown/empty disposition. The DB enforces
 * a presence CHECK (equipment required when disposition ≠ flec_bagging), so the grid
 * uses this both to populate the dropdown and to validate before save.
 */
export function partnerEquipmentOptions(disposition: string | null): readonly string[] {
  if (disposition === 'partner_crusher') return CRUSHER_CODES;
  if (disposition === 'partner_kiln') return KILN_CODES;
  return [];
}

/** True when this disposition requires a partner_equipment_code (≠ flec_bagging). */
export function dispositionRequiresEquipment(disposition: string | null): boolean {
  return disposition === 'partner_crusher' || disposition === 'partner_kiln';
}

// ─── Disposition rendering ──────────────────────────────────────────────────────
// Maps the partner_equipment_code → a short human label for the equipment kind.
// flec_bagging → "Bag"; partner_crusher → "Crusher C1"; partner_kiln → "Kiln RK3".
//
// `disposition` is typed `string | null` to consume the generated row types
// directly (the VIEW column is nullable; the ledger SRF widens it to `string`).
// At runtime it is always one of the three known kinds; unknown/empty values fall
// through and render as-is.
export function formatDisposition(
  disposition: string | null,
  equipment: string | null,
): string {
  if (disposition === 'flec_bagging') return 'Bag';
  if (disposition === 'partner_crusher') return equipment ? `Crusher ${equipment}` : 'Crusher';
  if (disposition === 'partner_kiln') return equipment ? `Kiln ${equipment}` : 'Kiln';
  return disposition ?? '';
}
