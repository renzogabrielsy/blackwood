/**
 * selfHeal.ts — the worker's two self-healing behaviors (M5.1):
 *
 *   1. recoverOrphanedRuns() — ONE-SHOT at startup. The root fix for a run stuck on
 *      'queued': its kick was lost while the worker was asleep/dead. On boot we find
 *      every sync_runs row still 'queued' in the last 24h and StartWorkflow it with
 *      its DETERMINISTIC workflowID (run:<id>). Because the ID is deterministic, DBOS
 *      dedups — a run already started (or already recovered by DBOS's own crash
 *      recovery) is NOT double-started. This catches the runs DBOS's built-in recovery
 *      can't: ones where the workflow was NEVER created (the kick never landed).
 *
 *   2. startStaleRunWatchdog() — PERIODIC sweep (every WATCHDOG_INTERVAL_MS). Auto-
 *      expires orphaned runs: a non-terminal run (queued|running) whose progress has
 *      STALLED — newest sync_run_events.at older than STALE_RUN_MINUTES, OR no events
 *      and created_at older than STALE_RUN_MINUTES — that is NOT an actively-running
 *      DBOS workflow. Marked 'failed' with a clear auto-expire message. A run that
 *      emitted an event within the window is NEVER expired (a live run streams events
 *      continuously, so recent activity is proof of life).
 *
 * Both are best-effort and NEVER throw into the boot/interval — a self-heal failure is
 * logged, never fatal.
 */
import { DBOS } from "../dbos.js";
import { runSyncWorkflow } from "../workflows/runSync.js";
import { runWorkflowId } from "../workflows/ids.js";
import { DbClient } from "../lib/db.js";

/** No run may stall (no progress) longer than this before the watchdog expires it. */
export const STALE_RUN_MINUTES = 15;
/** How often the watchdog sweeps. */
export const WATCHDOG_INTERVAL_MS = 3 * 60 * 1000; // 3 min
/** Startup recovery only looks back this far (a run older than this is abandoned). */
export const RECOVERY_LOOKBACK_HOURS = 24;

/** DBOS statuses that mean "this workflow is actively alive" — do NOT expire these. */
const LIVE_DBOS_STATUSES: ReadonlySet<string> = new Set(["PENDING", "ENQUEUED", "DELAYED"]);

/**
 * One-shot startup recovery of orphaned 'queued' runs. Deterministic workflowID makes
 * every re-start idempotent (DBOS dedups), so this is safe to run on every boot.
 */
export async function recoverOrphanedRuns(db: DbClient = DbClient.fromEnv()): Promise<number> {
  let recovered = 0;
  try {
    const queued = await db.listActiveRuns({
      statuses: ["queued"],
      withinHours: RECOVERY_LOOKBACK_HOURS,
    });
    for (const run of queued) {
      try {
        // Deterministic ID → DBOS no-ops if the workflow already exists. dryRun is not
        // recoverable state (a lost kick can't tell us it was a dry run) — recover as a
        // REAL run, which is the safe default (idempotent writes; the user can stop it).
        await DBOS.startWorkflow(runSyncWorkflow, { workflowID: runWorkflowId(run.id) })({
          runId: run.id,
        });
        recovered++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[recover] start run:${run.id} non-fatal:`, err instanceof Error ? err.message : err);
      }
    }
    if (queued.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[recover] found ${queued.length} queued run(s); (re)started ${recovered}.`);
    } else {
      // eslint-disable-next-line no-console
      console.log("[recover] no orphaned queued runs.");
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[recover] sweep failed (non-fatal):", err instanceof Error ? err.message : err);
  }
  return recovered;
}

/** True if the run's newest signal-of-life is older than STALE_RUN_MINUTES. */
function isStale(latestEventAt: string | null, createdAt: string | null): boolean {
  const cutoff = Date.now() - STALE_RUN_MINUTES * 60 * 1000;
  // A run WITH events: stale iff the newest event predates the cutoff.
  if (latestEventAt) return new Date(latestEventAt).getTime() < cutoff;
  // A run with NO events: stale iff it was created before the cutoff (never got going).
  if (createdAt) return new Date(createdAt).getTime() < cutoff;
  // No timestamps at all — don't touch it (can't prove staleness).
  return false;
}

/**
 * Is this run backed by an actively-running DBOS workflow? Cross-check via the parent
 * workflow status. If DBOS says it's PENDING/ENQUEUED/DELAYED, it's alive — never
 * expire it, even if it hasn't emitted an event recently. If DBOS has no record (a
 * truly-orphaned queued run whose workflow was never created) OR reports it terminal,
 * the no-progress signal governs.
 */
async function isLiveDbosWorkflow(runId: string): Promise<boolean> {
  try {
    const st = await DBOS.getWorkflowStatus(runWorkflowId(runId));
    if (!st) return false;
    return LIVE_DBOS_STATUSES.has(st.status);
  } catch (err) {
    // If the status lookup fails, be CONSERVATIVE: treat as live (don't expire) — the
    // stale-event signal is the safety net on the next sweep once DBOS is reachable.
    // eslint-disable-next-line no-console
    console.warn(`[watchdog] getWorkflowStatus(${runId}) failed — treating as live:`, err instanceof Error ? err.message : err);
    return true;
  }
}

/** One watchdog pass. Exported for tests. Returns the ids it expired. */
export async function sweepStaleRuns(db: DbClient = DbClient.fromEnv()): Promise<string[]> {
  const expired: string[] = [];
  const active = await db.listActiveRuns({ statuses: ["queued", "running"] });
  for (const run of active) {
    let latest: string | null = null;
    try {
      latest = await db.latestEventAt(run.id);
    } catch {
      // If we can't read events, skip this run this pass (be conservative).
      continue;
    }
    if (!isStale(latest, run.created_at)) continue; // recent activity → alive
    // Stalled by the progress signal — but confirm DBOS isn't actively running it.
    if (await isLiveDbosWorkflow(run.id)) continue;

    const msg =
      "Auto-expired: no progress for >15 min (worker likely restarted or the run was orphaned).";
    try {
      const didExpire = await db.failSyncRunIfActive(run.id, msg);
      if (didExpire) {
        expired.push(run.id);
        // eslint-disable-next-line no-console
        console.log(`[watchdog] auto-expired run ${run.id} (stalled, no live workflow).`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[watchdog] expire run ${run.id} non-fatal:`, err instanceof Error ? err.message : err);
    }
  }
  return expired;
}

/**
 * Start the periodic stale-run watchdog. Returns a stop() to clear it on shutdown.
 * The interval is unref()'d so it never holds the process open on its own.
 */
export function startStaleRunWatchdog(): { stop: () => void } {
  const timer = setInterval(() => {
    void sweepStaleRuns().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[watchdog] sweep failed (non-fatal):", err instanceof Error ? err.message : err);
    });
  }, WATCHDOG_INTERVAL_MS);
  // Do not keep the event loop alive just for the watchdog.
  if (typeof timer.unref === "function") timer.unref();
  // eslint-disable-next-line no-console
  console.log(`[watchdog] started — sweeping every ${WATCHDOG_INTERVAL_MS / 1000}s, stale threshold ${STALE_RUN_MINUTES} min.`);
  return {
    stop: () => clearInterval(timer),
  };
}
