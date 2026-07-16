'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { Tables } from '@/types/supabase';
import { fetchAllRows } from '@/lib/supabase/paginate';

// A single FLECON bag movement row, flattened with its bag-type label/code from
// the joined flecon_bag_types row. Rows are returned ASCENDING (oldest → newest)
// so the client renders them chronologically top→bottom in the Excel-style matrix
// (Forwarded Balance on top, Current Balance in the frozen footer) without any
// re-sort. READ-ONLY from the UI — the daily FLECON BAGGED sync (a Python
// employee) is the sole writer.
export interface FleconBagMovementRow {
    id: string;
    transaction_date: string;
    particular: string;
    bag_type_id: string;
    qty_delta: number;
    source_row: number | null;
    remarks: string | null;
    bag_code: string;
    bag_label: string;
}

// Shape of the flecon_bag_movements + flecon_bag_types join as PostgREST returns
// it. The embedded relation may arrive as an object OR a single-element array
// depending on the relationship cardinality inference — handled below.
interface RawMovementRow {
    id: string;
    transaction_date: string;
    particular: string;
    bag_type_id: string;
    qty_delta: number;
    source_row: number | null;
    remarks: string | null;
    created_at: string;
    flecon_bag_types:
        | { code: string | null; label: string | null; sort_order: number | null }
        | { code: string | null; label: string | null; sort_order: number | null }[]
        | null;
}

export async function fetchFleconBagData(): Promise<{
    balances: Tables<'view_flecon_bag_balance'>[];
    movements: FleconBagMovementRow[];
    error?: string;
}> {
    const supabase = await createClient();

    // Balances view — SQL-computed balance, sort_order-driven ordering. Never
    // recompute the balance in TS.
    const balancesRes = await supabase
        .from('view_flecon_bag_balance')
        .select('*')
        .order('sort_order', { ascending: true });

    if (balancesRes.error) {
        return { balances: [], movements: [], error: balancesRes.error.message };
    }

    // Paginated fetch to bypass PostgREST's 1000-row response cap — the shared
    // fetchAllRows helper. It THROWS on a page error; we keep this module's
    // surfaced-error contract by catching and returning { error } like before.
    // The single localized `any` on the builder param is accepted because the
    // PostgREST builder type is awkward to express.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function fetchAll<T>(buildQuery: (from: number, to: number) => any): Promise<{ rows: T[]; error: string | null }> {
        try {
            const rows = await fetchAllRows<T>((from, to) => buildQuery(from, to));
            return { rows, error: null };
        } catch (e) {
            return { rows: [], error: e instanceof Error ? e.message : 'Unknown error' };
        }
    }

    const currentYear = new Date().getFullYear();

    const { rows: rawMovements, error: movementsError } = await fetchAll<RawMovementRow>((from, to) =>
        supabase
            .from('flecon_bag_movements')
            .select(
                `
                id,
                transaction_date,
                particular,
                bag_type_id,
                qty_delta,
                source_row,
                remarks,
                created_at,
                flecon_bag_types (
                    code,
                    label,
                    sort_order
                )
            `,
            )
            .gte('transaction_date', `${currentYear}-01-01`)
            // ASC (oldest → newest) — the matrix view renders chronologically top→bottom
            // with a Forwarded Balance row on top and Current Balance at the bottom, so
            // the server orders it once here; the client never re-sorts. source_row is
            // the intra-day tiebreak (sheet row order) so same-date movements keep the
            // operator's original sequence; created_at is the final fallback.
            .order('transaction_date', { ascending: true })
            .order('source_row', { ascending: true, nullsFirst: true })
            .order('created_at', { ascending: true })
            .range(from, to),
    );

    if (movementsError) {
        return { balances: [], movements: [], error: movementsError };
    }

    // Flatten the joined flecon_bag_types (object OR array — handle both, exactly
    // like RC OUT flattens `batches`). Fall back to bag_code for the label and
    // '' for the code when the join is missing.
    const movements: FleconBagMovementRow[] = rawMovements.map((d) => {
        const arr = Array.isArray(d.flecon_bag_types)
            ? d.flecon_bag_types
            : d.flecon_bag_types
              ? [d.flecon_bag_types]
              : [];
        const joined = arr[0];
        const bag_code = joined?.code ?? '';
        const bag_label = joined?.label ?? bag_code;

        return {
            id: d.id,
            transaction_date: d.transaction_date,
            particular: d.particular,
            bag_type_id: d.bag_type_id,
            qty_delta: d.qty_delta,
            source_row: d.source_row,
            remarks: d.remarks,
            bag_code,
            bag_label,
        };
    });

    return { balances: balancesRes.data ?? [], movements };
}

// Update a bag type's display nickname. The ONLY write path in this otherwise
// read-only module — it touches the `flecon_bag_types` DIMENSION (a column
// nickname), never the `flecon_bag_movements` fact table (still sync-owned).
// Trims the input; an empty string clears the nickname (writes NULL) so the
// header falls back to the internal label. Revalidates so the matrix header
// reflects the change on the next render.
export async function updateFleconBagNickname(
    bagTypeId: string,
    nickname: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!bagTypeId) {
        return { ok: false, error: 'Missing bag type id.' };
    }

    const trimmed = nickname.trim();
    const supabase = await createClient();

    const { error } = await supabase
        .from('flecon_bag_types')
        .update({ nickname: trimmed || null })
        .eq('id', bagTypeId);

    if (error) {
        return { ok: false, error: error.message };
    }

    revalidatePath('/inventory/flecon-bags');
    return { ok: true };
}
