/**
 * progress.ts — durable progress events for the in-app "Run Sync" panel.
 *
 * In the Python engine, progress was streamed as `##SYNC_PROGRESS {...}` lines on
 * stderr (see orchestrator_common.py::progress). In the DBOS worker there is no
 * stderr pipe back to the browser — the browser watches Supabase Realtime instead.
 * So `emitEvent` INSERTs a row into `sync_run_events`; the dashboard subscribes to
 * that table. The SHAPE and the digestible-language rules are carried over verbatim
 * from SYNC_CLI_CONTRACT.md so the frontend's card state is unchanged.
 *
 * ============================================================================
 * DIGESTIBLE-LANGUAGE RULES (carried VERBATIM from SYNC_CLI_CONTRACT.md — HARD)
 * ============================================================================
 * Format — one event per beat:
 *   { stage: fetch|extract|classify|apply|reconcile|finalize,
 *     pct: <0-100 int, MONOTONICALLY NONDECREASING within a run>,
 *     label: "<plain-English current activity>",   // REQUIRED
 *     detail: "<optional specifics, may be omitted>",
 *     level: info|warn }
 *
 * - stage — one of fetch | extract | classify | apply | reconcile | finalize.
 * - pct   — integer 0–100, monotonically nondecreasing within a single run.
 * - label — the current activity in PLAIN ENGLISH. Written the way you'd tell a
 *           plant manager what's happening — NEVER echoed terminal lines, file
 *           paths, SQL, or tracebacks. Required.
 *           Good: "Checking Gmail for new reports…",
 *                 "Found 1 new report: RC DELIVERIES JUL-02",
 *                 "195 already recorded · 5 new · 2 changed",
 *                 "Writing 2 of 5 — JULY-26-BLK2 @ D-13D",
 *                 "Marking the email as processed…",
 *                 "Done — 3 new rows written", "Nothing new today".
 *           Numbers/percentages must be HONEST — derived from real counts / loop
 *           indexes, never faked.
 * - detail — optional extra specifics. May be omitted.
 * - level — info (normal) or warn (a retry, a tripped gate, a finish-with-problems).
 *
 * Volume guidance: aim for FEWER THAN 30 events per run — 4–8 curated calls per
 * phase at the natural beats, not one per row. For long write loops (e.g. 200
 * rows), emit on every ceil(n/10) rows (≤10 ticks) rather than per row.
 *
 * NEVER-THROW contract: a failure to write a progress event must NEVER break the
 * pipeline. emitEvent swallows its own errors (logs to console) — progress is
 * observational, never load-bearing.
 * ============================================================================
 */
import type { DbClient } from "./db.js";

// Narrow structural dependency: progress only needs insertProgressEvent.
type ProgressSink = Pick<DbClient, "insertProgressEvent">;

export type ProgressStage =
  | "fetch"
  | "extract"
  | "classify"
  | "apply"
  | "reconcile"
  | "finalize";
/**
 * `error` was added 2026-08-07. Until then the loudest thing a run could say was
 * `warn`, which is why "Price file unavailable — proceeding without prices" (a beat
 * that was actively wrong AND had un-priced an entire month) looked exactly like a
 * routine retry. `sync_run_events.level` is free text with no CHECK constraint, so no
 * migration is needed; the frontend projection (`lib/sync/reducer.ts::projectEvent`)
 * was widened in the same changeset so an `error` beat still tints the card at least
 * as loudly as a `warn` and is never silently downgraded to `info`.
 */
export type ProgressLevel = "info" | "warn" | "error";

const STAGES: ReadonlySet<string> = new Set<ProgressStage>([
  "fetch",
  "extract",
  "classify",
  "apply",
  "reconcile",
  "finalize",
]);

export interface ProgressEvent {
  stage: ProgressStage;
  pct: number;
  label: string;
  detail?: string;
  level?: ProgressLevel;
}

/**
 * Per-(runId, reportType) monotonic pct guard — mirrors the Python _LAST_PCT, but
 * scoped per report type because report workflows run in parallel and each has its
 * own progress track. Keyed by `${runId}::${reportType}`.
 */
const _lastPct = new Map<string, number>();

function pctKey(runId: string, reportType: string): string {
  return `${runId}::${reportType}`;
}

/** Clamp + monotonic-nondecreasing exactly like orchestrator_common.progress. */
function clampMonotonic(runId: string, reportType: string, pct: number): number {
  const key = pctKey(runId, reportType);
  const last = _lastPct.get(key) ?? 0;
  let p: number;
  if (typeof pct !== "number" || !Number.isFinite(pct)) {
    p = last;
  } else {
    p = Math.round(pct);
  }
  p = Math.max(0, Math.min(100, p));
  if (p < last) p = last;
  _lastPct.set(key, p);
  return p;
}

/**
 * A progress emitter bound to one (runId, reportType). Passed down into the
 * per-report workflow so each report emits its own monotonic track. Mirrors
 * `oc.progress(stage, label, pct, detail, level)`.
 */
export interface ProgressEmitter {
  (
    stage: ProgressStage,
    label: string,
    pct: number,
    detail?: string,
    level?: ProgressLevel
  ): Promise<void>;
}

/**
 * Build an emitter that INSERTs into sync_run_events. NEVER throws into the caller.
 */
export function makeEmitter(
  db: ProgressSink,
  runId: string,
  reportType: string
): ProgressEmitter {
  return async (stage, label, pct, detail, level = "info") => {
    try {
      const st: ProgressStage = STAGES.has(stage) ? stage : "classify";
      const lvl: ProgressLevel =
        level === "error" ? "error" : level === "warn" ? "warn" : "info";
      const p = clampMonotonic(runId, reportType, pct);
      await db.insertProgressEvent({
        run_id: runId,
        report_type: reportType,
        stage: st,
        pct: p,
        label: String(label),
        detail: detail ? String(detail) : null,
        level: lvl,
      });
    } catch (err) {
      // Observational only — swallow. Mirrors the Python best-effort discipline.
      // eslint-disable-next-line no-console
      console.error(
        `[progress] failed to write event (non-fatal) run=${runId} report=${reportType}:`,
        err instanceof Error ? err.message : err
      );
    }
  };
}

/** Reset the monotonic guard for a run (test helper / new-run boundary). */
export function _resetPct(runId?: string, reportType?: string): void {
  if (runId && reportType) {
    _lastPct.delete(pctKey(runId, reportType));
  } else {
    _lastPct.clear();
  }
}
