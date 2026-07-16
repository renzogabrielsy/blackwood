/**
 * allowlist.ts — the STATIC allow-lists that fence every investigator DB query.
 *
 * The investigator's `query_table` / `check_duplicates` tools accept a `table` and
 * `columns`/`group_by` chosen by the MODEL. The model is untrusted input, so nothing
 * it names may reach PostgREST unvalidated. This module is the single source of truth
 * for:
 *   - WHICH tables/views are queryable (TABLE_ALLOWLIST keys),
 *   - WHICH columns of each are selectable (the string[] values), and
 *   - the PRICE-COLUMN pattern that is stripped UNCONDITIONALLY, even when the caller
 *     can view prices (this read-only investigative surface never needs ₱ — held-row
 *     adjudication is a WRITE decision, not a cost view; see adjudication.ts's identical
 *     stance and CLAUDE.md "Price gating").
 *
 * The column lists were derived from types/supabase.ts and then had every ₱/cost
 * column removed at authoring time (cost_basis, avg_cost, php_per_kg, php_total,
 * avg_php_kg). PRICE_COL_RE is the belt-and-suspenders second layer: any key matching
 * it is scrubbed from returned rows even if a list drifts.
 */

/**
 * Price/cost column pattern. Matches cost_basis, avg_cost, avg_php_kg, php_per_kg,
 * php_total, rc_out_avg_price, rc_out_avg_wtd_value, and anything else containing
 * price / cost / php / wtd_value. Applied as (a) a rejection check on requested
 * columns and (b) a scrub over returned row keys. Mirrors the FORBIDDEN idea in
 * app/(app)/sync/adjudication.ts.
 */
export const PRICE_COL_RE = /price|cost|php|wtd_value/i

/** True iff a column name is a ₱/cost column that must never be selected or returned. */
export function isPriceColumn(col: string): boolean {
  return PRICE_COL_RE.test(col)
}

/**
 * Per-table selectable columns. PRICE COLUMNS ARE ALREADY EXCLUDED here (they were
 * removed at authoring time), and PRICE_COL_RE re-guards at query time. These are the
 * ONLY columns the investigator may name in `columns` / `group_by` / `order_by` /
 * `filters[].column`. Anything else → rejected.
 *
 * Views included: view_rc_movement, view_blocking_grid, view_flecon_bag_balance
 * (php_per_kg / php_total / avg_php_kg dropped from the first two).
 */
export const TABLE_ALLOWLIST: Record<string, readonly string[]> = {
  // ── base tables ──────────────────────────────────────────────────────────
  rc_out: [
    'id',
    'transaction_date',
    'batch_id',
    'production_batch',
    'destination',
    'weight_kg',
    'block_loc',
    'remarks',
    'created_at',
  ],
  deliveries: [
    'id',
    'transaction_date',
    'supplier',
    'batch_code',
    'block_loc',
    'truck_plate',
    'sacks',
    'weight_kg',
    'true_weight_kg',
    'deduction_note',
    'lab_results',
    'remarks',
    'created_at',
    // cost_basis EXCLUDED (price)
  ],
  batches: [
    'id',
    'batch_code',
    'location_ref',
    'status',
    'current_weight',
    'quality_stats',
    'notes',
    'created_at',
    'updated_at',
    // avg_cost EXCLUDED (price)
  ],
  production_shifts: ['id', 'transaction_date', 'production_batch', 'shift', 'created_at'],
  production_runs: [
    'id',
    'shift_id',
    'customer',
    'grade',
    'ttl_kg',
    'sacks_bags',
    'remarks',
    'created_at',
  ],
  production_downtime: [
    'id',
    'shift_id',
    'dt_hrs',
    'dt_mins',
    'dt_reason',
    'shift_hrs',
    'created_at',
  ],
  production_waste: [
    'id',
    'shift_id',
    'bf_kg',
    'grit_kg',
    'rs1a_kg',
    'rs1b_kg',
    'rs23_kg',
    'rs5_kg',
    'trml1_kg',
    'trml2_kg',
    'remarks',
    'created_at',
  ],
  electricity_readings: [
    'id',
    'reading_date',
    'meter',
    'start_kwh',
    'end_kwh',
    'diff_kwh',
    'consumption_kwh',
    'meter_multiplier',
    'remarks',
    'created_at',
  ],
  truck_readings: [
    'id',
    'reading_date',
    'plate_no',
    'start_km',
    'end_km',
    'ttl_km',
    'fuel_liters',
    'remarks',
    'created_at',
  ],
  flecon_bag_movements: [
    'id',
    'transaction_date',
    'bag_type_id',
    'particular',
    'qty_delta',
    'remarks',
    'source_row',
    'created_at',
  ],
  flecon_bag_types: [
    'id',
    'code',
    'label',
    'nickname',
    'material',
    'capacity_kls',
    'color',
    'sort_order',
    'active',
    'source_column',
    'source_label',
    'notes',
  ],
  // ── reporting views ──────────────────────────────────────────────────────
  view_rc_movement: [
    'date',
    'batch_id',
    'batch_code',
    'block_loc',
    'supplier',
    'status',
    'fed_today',
    'cum_fed',
    'start_balance',
    'balance_after',
    'deliveries_total',
    'feed_day_n',
    'pct_loss',
    'closed_today',
    // php_per_kg / php_total EXCLUDED (price)
  ],
  view_blocking_grid: [
    'block_loc',
    'batch_id',
    'batch_code',
    'status',
    'total_in',
    'balance',
    'avg_mc',
    'avg_ash',
    'avg_bd_astm',
    'avg_bd_jis',
    'avg_grit',
    'avg_vm',
    'avg_fc',
    // avg_php_kg EXCLUDED (price)
  ],
  view_flecon_bag_balance: [
    'bag_type_id',
    'code',
    'label',
    'nickname',
    'sort_order',
    'opening',
    'total_in',
    'total_out',
    'balance',
    'last_movement_date',
  ],
}

/** The allow-listed table/view names (the enum a tool's `table` arg is validated against). */
export const ALLOWED_TABLES = Object.keys(TABLE_ALLOWLIST)

/** The set of filter/comparison operators `query_table` accepts (validated literals). */
export const ALLOWED_OPS = ['eq', 'neq', 'gte', 'lte', 'like', 'in'] as const
export type FilterOp = (typeof ALLOWED_OPS)[number]

/**
 * Validate that `table` is allow-listed and every column in `cols` is selectable AND
 * not a price column. Returns { ok, columns } on success (columns defaulting to the
 * full allow-list when none requested), or { ok:false, error } describing the first
 * rejection — a plain string the tool returns as JSON to the model.
 */
export function resolveColumns(
  table: string,
  cols: string[] | undefined,
): { ok: true; columns: readonly string[] } | { ok: false; error: string } {
  const allow = TABLE_ALLOWLIST[table]
  if (!allow) {
    return {
      ok: false,
      error: `Unknown table "${table}". Allowed: ${ALLOWED_TABLES.join(', ')}.`,
    }
  }
  if (!cols || cols.length === 0) {
    return { ok: true, columns: allow }
  }
  const allowSet = new Set(allow)
  for (const c of cols) {
    if (isPriceColumn(c)) {
      return { ok: false, error: `Column "${c}" is a price/cost column and is never available.` }
    }
    if (!allowSet.has(c)) {
      return {
        ok: false,
        error: `Column "${c}" is not allowed on "${table}". Allowed columns: ${allow.join(', ')}.`,
      }
    }
  }
  return { ok: true, columns: cols }
}

/** Validate a single column is selectable on the table (used for order_by / filter columns). */
export function isAllowedColumn(table: string, col: string): boolean {
  const allow = TABLE_ALLOWLIST[table]
  if (!allow) return false
  if (isPriceColumn(col)) return false
  return allow.includes(col)
}

/**
 * Second-line defense: strip any price-pattern key from a returned row object. Runs on
 * EVERY row every tool returns — even when the requested columns were clean — so a
 * JSONB blob or a view column that slipped a ₱ value never reaches the model.
 */
export function scrubPriceKeys<T extends Record<string, unknown>>(row: T): T {
  let dirty = false
  for (const k of Object.keys(row)) {
    if (isPriceColumn(k)) {
      dirty = true
      break
    }
  }
  if (!dirty) return row
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (!isPriceColumn(k)) out[k] = v
  }
  return out as T
}
