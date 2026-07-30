// `/production/setups` — the SETUP LIBRARY.
//
// The reference data behind the schedule's Setup dropdown: one row per named
// per-shift grade mix (`SOLID 3X50` = 25 t of 3X50 per shift). Sits OUTSIDE the
// `app/(app)/production/(tabs)/` route group for the same reason
// `/production/schedule` does — it is not a Daily · Electricity · Trucks tab and
// must not inherit their shell (BUG-003).
//
// Server component: fetches, shapes, hands off. `SetupsManager` ('use client')
// owns every interaction and calls the server actions in `./actions.ts`; the
// client never touches Supabase.
//
// ACTIVE **and** RETIRED rows are loaded here — that is the point of the screen.
// A retired setup vanishes from the day-grid dropdown but stays visible (and
// restorable) here, because `production_schedule.setup` is free text with no FK
// and every historical plan row keeps its label forever.
//
// No title header — the navbar owns it (`getBreadcrumb` → `/production/setups`).
import { createClient } from '@/lib/supabase/server';
import { parseGradeMix } from '@/lib/production/setup-projection';
import {
  SetupsManager,
  type SetupLibraryRow,
} from './setups-manager';

export default async function ProductionSetupsPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('production_setups')
    .select('id, code, label, grade_mix, active, sort_order, notes, updated_at')
    // Active first so the pickable library reads as one block, then the
    // operator's own order within each group.
    .order('active', { ascending: false })
    .order('sort_order', { ascending: true })
    .order('code', { ascending: true });

  const setups: SetupLibraryRow[] = (data ?? []).map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    gradeMix: parseGradeMix(r.grade_mix),
    active: r.active,
    sortOrder: r.sort_order,
    notes: r.notes,
    updatedAt: r.updated_at,
  }));

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 py-4 sm:gap-6 sm:px-6 sm:py-5">
      <SetupsManager setups={setups} loadError={error?.message ?? null} />
    </div>
  );
}
