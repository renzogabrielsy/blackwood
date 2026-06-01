'use server';

import { createClient } from '@/lib/supabase/server';
import type { ProductionEventRow } from '../types';

// Minimal structural type for the cast — exposes only the `.schema().from().select().order()`
// path we use, typed to return the row shape this module declares.
type SchemaSelectClient = {
    schema: (s: string) => {
        from: (t: string) => {
            select: (cols: string) => {
                order: (
                    col: string,
                    opts: { ascending: boolean },
                ) => Promise<{ data: ProductionEventRow[] | null; error: { message: string } | null }>;
            };
        };
    };
};

// ─── Fetch all production events ─────────────────────────────────────────────────
// Read-only. Returns the full cenapro.production_event spine (~752 rows) ordered
// newest-first by recv_date. Filtering/sorting beyond this is done client-side
// (the dataset is small enough that fetching once + filtering in the browser is
// snappier than round-tripping per filter change).
//
// STOPGAP: the cenapro schema is not yet exposed to PostgREST and is absent from
// generated types, so we reach it via `.schema('cenapro')` on a client cast to a
// minimal structural type. Until exposure is enabled this call returns an error in
// the browser — that is expected, and the page renders a graceful empty/error
// state. Replace the cast with the generated `Database['cenapro']` types after
// regeneration.
export async function fetchProductionEvents(): Promise<{
    data?: ProductionEventRow[];
    error?: string;
}> {
    const supabase = await createClient();

    const { data, error } = await (supabase as unknown as SchemaSelectClient)
        .schema('cenapro')
        .from('production_event')
        .select(
            'id, recv_date, prod_date, batch, batch_year, shift_code, grade_code, plant_code, ' +
            'warehouse_code, source_location_code, weight_kg, disposition_kind, ' +
            'partner_equipment_code, flec_count, whse_side',
        )
        .order('recv_date', { ascending: false });

    if (error) {
        return { error: `Failed to load Cenapro production events: ${error.message}` };
    }

    return { data: data ?? [] };
}
