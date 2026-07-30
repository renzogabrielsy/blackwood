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
//   emerald = reported/actual, i.e. settled and frozen

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
    'Production has already been reported for this date. The plan is frozen for everyone, including the sync.',
};

/** Whether a day can be edited in-app at all. `actual` is frozen; the RPC would
 *  refuse the write anyway, so the UI must not pretend otherwise. */
export function isScheduleDayEditable(effectiveOwner: ScheduleOwner): boolean {
  return effectiveOwner !== 'actual';
}
