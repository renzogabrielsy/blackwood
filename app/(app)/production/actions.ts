'use server';

// =====================================================================
// Production facts — the HUMAN-EDIT LATCH, app side.
// =====================================================================
// Every in-app write to `production_shifts` / `production_runs` /
// `production_downtime` / `production_waste` / `electricity_readings` /
// `truck_readings` CLAIMS its row: the DB trigger `fn_stamp_human_edit` sets
// `human_edited_at` from `auth.uid()`, and from then on the sync will NOT
// overwrite that row — MC's/Ivy's differing value surfaces as a run finding
// ("Row you edited — the report disagrees") instead of silently reverting the
// operator. See migration `20260803080000_production_human_edit_guard.sql`.
//
// This module owns the way BACK. Without a release path ownership only
// ratchets one way and the production data slowly freezes — exactly the
// failure the schedule work called out (see 20260730070000 /
// `production/schedule/actions.ts`).
//
// The stamp CANNOT be cleared by an ordinary write: the trigger re-stamps any
// authenticated UPDATE, including one that sends `human_edited_at: null`.
// `fn_release_production_rows` is the only sanctioned clear, and its guard
// (`human_edited_at IS NOT NULL`) lives inside its own UPDATE — so releasing a
// row nobody claimed writes nothing and reports it as skipped rather than
// pretending it worked.
//
// Production carries no ₱/cost data at all, so this module never touches
// `canViewPrices()`.

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Json } from '@/types/supabase';

/** The six tables the latch covers. Mirrors the RPC's own allowlist. */
export type ProductionFactTable =
  | 'production_shifts'
  | 'production_runs'
  | 'production_downtime'
  | 'production_waste'
  | 'electricity_readings'
  | 'truck_readings';

const FACT_TABLES: readonly ProductionFactTable[] = [
  'production_shifts',
  'production_runs',
  'production_downtime',
  'production_waste',
  'electricity_readings',
  'truck_readings',
];

export interface ReleaseResult {
  ok: boolean;
  /** Ids that were released — they follow the report again from the next run. */
  released: string[];
  /** Ids that were already following the report (or no longer exist). Not an error. */
  skipped: string[];
  /** Human-readable failure text, already phrased for an error toast. */
  error?: string;
}

/** One row per production record a human currently owns. Feeds a "release" list. */
export interface HumanEditedProductionRow {
  table_name: string;
  section: string;
  record_id: string;
  transaction_date: string | null;
  production_batch: string | null;
  shift: string | null;
  meter: string | null;
  plate_no: string | null;
  human_edited_at: string | null;
  human_edited_by_name: string | null;
}

/**
 * Every production row a human currently owns, newest claim first. The sync will not
 * update any row in this list; `releaseProductionRows` hands one back.
 */
export async function fetchHumanEditedProductionRows(): Promise<
  { data: HumanEditedProductionRow[] } | { error: string }
> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('view_production_human_edited')
    .select(
      'table_name, section, record_id, transaction_date, production_batch, shift, meter, plate_no, human_edited_at, human_edited_by_name'
    )
    .order('human_edited_at', { ascending: false });

  if (error) {
    return { error: `Failed to load rows you have edited: ${error.message}` };
  }
  return { data: (data ?? []) as HumanEditedProductionRow[] };
}

/**
 * Hand human-edited production rows back to the sync: the report becomes authoritative
 * for them again from the next run.
 *
 * Use this when the report turns out to be right (or the edit was a mistake). It clears
 * ONLY the ownership stamp — the row's values are left exactly as they are, so nothing
 * changes until the sync actually has something different to write.
 */
export async function releaseProductionRows(input: {
  table: ProductionFactTable;
  ids: string[];
}): Promise<ReleaseResult> {
  const { table, ids } = input;

  if (!FACT_TABLES.includes(table)) {
    return { ok: false, released: [], skipped: [], error: `"${table}" is not a production table.` };
  }
  if (!ids?.length) {
    return { ok: true, released: [], skipped: [] };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fn_release_production_rows', {
    p_table: table,
    p_ids: ids,
  });

  if (error) {
    return {
      ok: false,
      released: [],
      skipped: [],
      error: `Could not hand ${ids.length} row(s) back to the sync: ${error.message}`,
    };
  }

  const obj =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, Json | undefined>)
      : null;
  const asIds = (v: Json | undefined): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  const result: ReleaseResult = {
    ok: obj?.ok === true,
    released: asIds(obj?.released),
    skipped: asIds(obj?.skipped),
  };
  if (result.ok) revalidatePath('/production');
  return result;
}
