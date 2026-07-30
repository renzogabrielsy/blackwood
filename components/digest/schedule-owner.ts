// =====================================================================
// Production Schedule — ownership vocabulary + presentation tokens.
// =====================================================================
// Pure module (no imports, no JSX) so BOTH the server component that shapes the
// rows and the client grid that renders them can share one definition of "who
// owns this day". Mirrors the DB CHECK constraint on
// `production_schedule.owner` and `view_production_schedule_state.effective_owner`
// (migration 20260730060000_production_schedule_ownership.sql).
//
// Colour idiom follows components/digest/status-tokens.ts:
//   violet  = the forward-looking PLAN layer (Joseph is the authoritative plan)
//   muted   = the Sheet baseline
//   sky     = a human hand touched it (deliberately NOT amber — amber already
//             means "today / awaiting report" in this table)
//   emerald = reported/actual, i.e. production happened. NOT "frozen" — the
//             sync can never write these days, but the human still can
//             (migration 20260730090000); see the note at the bottom of this file.

export type ScheduleOwner = 'joseph' | 'gsheet' | 'human' | 'actual';

export const SCHEDULE_OWNERS: readonly ScheduleOwner[] = [
  'joseph',
  'gsheet',
  'human',
  'actual',
];

/** Narrow an untrusted DB string into the owner union (defaults to gsheet, the
 *  column's own DEFAULT). */
export function toScheduleOwner(value: string | null | undefined): ScheduleOwner {
  return (SCHEDULE_OWNERS as readonly string[]).includes(value ?? '')
    ? (value as ScheduleOwner)
    : 'gsheet';
}

/** Short chip label. */
export const OWNER_LABEL: Record<ScheduleOwner, string> = {
  joseph: 'Joseph',
  gsheet: 'Sheet',
  human: 'You',
  actual: 'Actual',
};

/** Chip background + text, matching STATE_CHIP's density and idiom. */
export const OWNER_CHIP: Record<ScheduleOwner, string> = {
  joseph: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
  gsheet: 'bg-muted text-muted-foreground',
  human: 'bg-sky-500/12 text-sky-700 dark:text-sky-300',
  actual: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
};

/** The sentence shown on hover — why this row behaves the way it does. */
export const OWNER_HINT: Record<ScheduleOwner, string> = {
  joseph:
    "Following Joseph's emailed schedule. The daily sync keeps this day up to date.",
  gsheet:
    'Following the PROD SCHED sheet baseline. The daily sync keeps this day up to date.',
  human:
    'Edited in the app. The sync will NOT overwrite this day — a differing upstream value is parked for you to arbitrate.',
  actual:
    'Production has been reported for this date. The sync will never write it again — but you can still correct the plan.',
};

// ---------------------------------------------------------------------
// REPORTEDNESS IS NOT A LOCK  (migration 20260730090000)
// ---------------------------------------------------------------------
// `isScheduleDayEditable(effectiveOwner)` used to live here and return false for
// `'actual'`. It is GONE, deliberately, rather than changed to `return true` —
// a predicate that is constant is an invitation to re-introduce the bug it
// caused. Both human RPCs (`fn_save_schedule_day`, `fn_release_schedule_day`)
// dropped their actuals freeze; only `fn_apply_schedule_upstream` (the SYNC,
// which this app never calls) still has one. Before that, 166 of the calendar's
// 273 days were unreachable in-app with no remedy.
//
// **Editability and reportedness are now independent facts. Do not re-conflate
// them.** The UI must keep SHOWING reportedness — it is exactly why an edit here
// is consequential — but must never gate an input on it.

/** Hover sentence for the "production reported" marker on the date cell. */
export const REPORTED_HINT =
  'Production has been reported for this date. The plan stays editable so you can correct it — but you are changing plan-vs-actual history, and the daily sync will never write this day.';

/** Hover sentence for the badge on a day whose plan was corrected AFTER the
 *  fact — the signal `effective_owner` hides, since it collapses to 'actual'
 *  the moment a day is reported. Backed by
 *  `view_production_schedule_state.human_edit_after_report`. */
export const HUMAN_EDIT_AFTER_REPORT_HINT =
  'The plan for this day was corrected in the app after production had already been reported.';
