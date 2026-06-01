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
