'use server';

import { createClient } from '@/lib/supabase/server';
import type { ProductionEventRow } from '../types';

// ─── Fetch all production events ─────────────────────────────────────────────────
// Read-only. Returns the full cenapro production-event spine (~752 rows) ordered
// newest-first by recv_date. Filtering/sorting beyond this is done client-side
// (the dataset is small enough that fetching once + filtering in the browser is
// snappier than round-tripping per filter change).
//
// Data path: the `public.cenapro_production_events` VIEW — a read-only accessor in
// the already-served `public` schema, granted to authenticated + anon. The normal
// Supabase client reaches it directly (no `.schema('cenapro')`, no cast).
export async function fetchProductionEvents(): Promise<{
    data?: ProductionEventRow[];
    error?: string;
}> {
    const supabase = await createClient();

    // The column list MUST be a single string literal (not `+`-concatenated): the
    // typed PostgREST client parses it at the type level to infer the row shape,
    // and a concatenated string defeats that inference (falls back to an error type).
    const { data, error } = await supabase
        .from('cenapro_production_events')
        .select(
            'id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, warehouse_code, source_location_code, weight_kg, disposition_kind, partner_equipment_code, flec_count, whse_side, unique_tag',
        )
        .order('recv_date', { ascending: false });

    if (error) {
        return { error: `Failed to load Cenapro production events: ${error.message}` };
    }

    return { data: data ?? [] };
}
