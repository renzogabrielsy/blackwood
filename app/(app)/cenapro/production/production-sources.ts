// ─── Cenapro production — plant source sets (pure, no React, no client/server tag) ──
// The Daily W6 / W7 pivot views filter production events by the SOURCE of the material
// (`source_location_code`) before pivoting. This tiny map is the single source of truth
// for that filter and is imported by BOTH:
//   • the CLIENT pivot engine (`buildDateGroups` in production-daily-block.tsx, and the
//     endless read-only renderer production-endless-pivots.tsx), and
//   • the SERVER day-window keyset action (`fetchDailyPivotWindow` in actions.ts), which
//     filters server-side so a day-window never ships FLEC/DVO rows and day counting for
//     the virtualized `firstItemIndex` anchor stays exact.
//
// It lives in its own pure module (NOT the 'use client' daily-block component) precisely
// so the server action can import it without dragging a client component across the
// server boundary. FLEC and DVO are EXCLUDED from BOTH variants (inventory withdrawals,
// not factory output).

export type PlantView = 'W6' | 'W7';

export const SOURCE_SETS: Record<PlantView, readonly string[]> = {
    W6: ['TNK 1', 'TNK 2', 'TNK 3', 'TNK 4', 'W6'],
    W7: ['W7'],
};
