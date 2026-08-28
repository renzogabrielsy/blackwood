// =====================================================================
// Production Schedule — the row contract shared by the server component that
// shapes the month and the client grid that edits it.
// =====================================================================
// Pure types + tiny pure helpers (no imports beyond other pure modules) so the
// async Server Component (`schedule-month-view.tsx`) and the `'use client'`
// grid (`schedule-month-grid.tsx`) agree on ONE shape. Everything here comes
// from `view_production_schedule_state` /
// `view_production_schedule_conflicts` — no aggregation happens in TypeScript.

import type { ScheduleRowState } from '@/lib/digest/day-status';
import type { GradeTon } from '@/components/digest/format';
import type { ScheduleOwner } from '@/components/digest/schedule-owner';
import type { GradeMix } from '@/lib/production/setup-projection';

/** One side of a parked conflict — the shape of both
 *  `pending_upstream.proposed` and the view's `current_values`. */
export interface ScheduleConflictSide {
  shifts: number | null;
  setup: string | null;
  projected_tons: number | null;
  grades: Record<string, number> | null;
  remarks: string | null;
  source: string | null;
}

/** An unarbitrated upstream proposal parked on a human-owned day. */
export interface ScheduleConflict {
  /** Exactly which fields differ, straight from the view. */
  changedFields: string[];
  proposed: ScheduleConflictSide | null;
  current: ScheduleConflictSide | null;
  pendingSourceRev: string | null;
  /** ISO timestamp the sync observed the proposal. */
  observedAt: string | null;
}

/** One day of the month grid. */
export interface ScheduleGridRow {
  /** yyyy-MM-dd */
  date: string;
  /** weekday name, e.g. "Tuesday" */
  dow: string;
  shifts: number;
  setup: string | null;
  /** per-grade projected tonnage, heaviest first. DISPLAY shape. */
  gradeTons: GradeTon[];
  /** The SAME grades as a keyed mix — what `isOnTemplate` compares against.
   *  `gradeTons` is sorted-for-display and lossy about ordering; this is the
   *  value. Never hand-typed: written only by the setup projection. */
  grades: GradeMix | null;
  projectedTons: number | null;
  actualTons: number | null;
  actualHrs: number | null;
  /** actual − projected (only when actual present) */
  variance: number | null;
  remarks: string | null;
  state: ScheduleRowState;
  isToday: boolean;
  isRest: boolean;

  // --- ownership (Phase A) ---
  /** The STORED owner. */
  owner: ScheduleOwner;
  /** `actual` when production has been reported for the date, else `owner`.
   *  NOTE it MASKS a human owner on a reported day — see `humanEditAfterReport`. */
  effectiveOwner: ScheduleOwner;
  /** True when a `production_shifts` row exists. Freezes the SYNC, **not** the
   *  human (migration 20260730090000) — informational for the editor, and never
   *  a reason to disable an input. */
  isReported: boolean;
  /** `owner = 'human' AND is_reported` — the plan was corrected after the fact.
   *  The signal `effectiveOwner` hides. */
  humanEditAfterReport: boolean;
  /** Optimistic-concurrency token; every write must echo the value read here. */
  rowVersion: number;
  humanEditedAt: string | null;
  /** Non-null when the sync withheld an upstream value for this day. */
  conflict: ScheduleConflict | null;
}

/** The four fields the in-app editor may patch. `grades` is intentionally
 *  absent — it is JSONB and there is no JSON editor yet. */
export type ScheduleEditableField =
  | 'setup'
  | 'shifts'
  | 'projected_tons'
  | 'remarks';

/** Visual column index → editable field (null = read-only / skipped by nav).
 *  MUST stay in lockstep with the <th>/<td> order in schedule-month-grid.tsx.
 *
 *  `setup` (col 2) is in the map so arrow/Tab navigation REACHES it, but it is
 *  edited by a dropdown, not an inline text editor — the grid's own resolver
 *  overrides `isEditable` for it and routes F2/Enter to opening the menu. Same
 *  shape as the Cenapro ledger's dropdown columns. */
export const SCHEDULE_COLUMN_MAP: readonly (ScheduleEditableField | null)[] = [
  null, // 0  Date
  null, // 1  Day
  'setup', // 2  Setup (dropdown — see above)
  null, // 3  Grades (read-only JSONB)
  'shifts', // 4  Shifts
  'projected_tons', // 5  Proj t
  null, // 6  Act t
  null, // 7  Act hrs
  null, // 8  Var
  null, // 9  Status
  null, // 10 Owner
  'remarks', // 11 Remarks
  null, // 12 Actions
];

/** The stored value of an editable field, as the string the editor shows. */
export function scheduleFieldToString(
  row: ScheduleGridRow,
  field: ScheduleEditableField
): string {
  switch (field) {
    case 'setup':
      return row.setup ?? '';
    case 'shifts':
      return String(row.shifts ?? 0);
    case 'projected_tons':
      return row.projectedTons == null ? '' : String(row.projectedTons);
    case 'remarks':
      return row.remarks ?? '';
  }
}
