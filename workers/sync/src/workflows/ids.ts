/**
 * ids.ts — the ONE source of truth for the deterministic DBOS workflow IDs the sync
 * run uses. Keeping them here (not string-literal'd in three places) means the /cancel
 * endpoint, startup recovery, and the stale-run watchdog can never drift from what
 * runSync.ts actually starts.
 *
 * Scheme (set by runSync.ts + the kick server):
 *   parent run          →  run:<runId>
 *   mail clerk child    →  mailclerk:<runId>
 *   per-report child    →  report:<runId>:<reportType>
 *
 * The report types MUST match runSync.ts's PARALLEL_WRITERS + gsheet + the read-only
 * auditor (RunReportType). If a report type is added there, add it here too.
 */

/** Every report child the run starts, in the order runSync launches them. */
export const RUN_REPORT_TYPES = [
  "gsheet",
  "deliveries",
  "rc_out",
  "production",
  "flecon",
  "rc_movement_audit",
] as const;

export function runWorkflowId(runId: string): string {
  return `run:${runId}`;
}

export function mailClerkWorkflowId(runId: string): string {
  return `mailclerk:${runId}`;
}

export function reportWorkflowId(runId: string, reportType: string): string {
  return `report:${runId}:${reportType}`;
}

/**
 * Every child workflow ID a run can have (mail clerk + all report children). Used by
 * /cancel to enumerate + cancel each child explicitly (belt-and-suspenders alongside
 * cancelChildren:true on the parent). Cancelling an ID that never started is a no-op.
 */
export function childWorkflowIds(runId: string): string[] {
  return [
    mailClerkWorkflowId(runId),
    ...RUN_REPORT_TYPES.map((rt) => reportWorkflowId(runId, rt)),
  ];
}
