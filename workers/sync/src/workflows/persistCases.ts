/**
 * persistCases.ts — every HELD ROW of a run becomes a DURABLE CASE, written by the run
 * itself (2026-09-07, L-049).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INCIDENT
 * ─────────────────────────────────────────────────────────────────────────────
 * On 2026-09-03 and 09-04 two real feedings — 8,158 kg and 9,637 kg at block D-8A — were
 * held by the rc_out writer: first because a mistyped BLOCK DATE cell derived a batch that
 * does not exist and the auto-create was refused by the database, then, once MC corrected
 * the cell, because the watermark had moved past those days and the sub-watermark guard
 * caught the corrected copies. Four days later `rc_out` was still short by exactly those
 * two amounts, the RC MOVEMENT audit was flagging exactly those two dates, and:
 *
 *   - `sync_held_cases` had NOT ONE row since Sept 4;
 *   - the Excel report's "Awaiting Review" sheet listed ZERO rows;
 *   - the operator's only signal was the sentence "2 drift date(s); max_severity=serious".
 *
 * The held rows were in `sync_runs.result` the whole time. What was missing is that the
 * ONLY thing that ever projected them into `sync_held_cases` was the app's
 * `ensureCasesForRun` server action, reached from the sync modal's finalize hook — which
 * is gated on `SYNC_AI_REVIEW_ENABLED`, deliberately OFF since 2026-07-11 — and from a
 * `/sync/cases?run=<id>` deep link. A scheduled run that nobody sat and watched fanned out
 * nothing at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS ENCODES
 * ─────────────────────────────────────────────────────────────────────────────
 * A HOLD THAT IS NEVER SHOWN IS A SILENT FAILURE. The projection has to happen where the
 * run happens, not where a human happens to click — the same lesson as L-044 (an alarm
 * behind a bare `catch` had never once fired) and L-048 (a source that could not be read
 * was reported as a successful, empty day).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *   - NOT a second fingerprint. `caseFingerprint` comes through `findingsBridge.ts`, the
 *     ONE worker→app crossing, so a case created here and the same case created later by
 *     the app's fan-out are one row, not two.
 *   - NOT a second fold. `collectHeldRows` is the app's own, unchanged.
 *   - NOT a filter. EVERY held row is projected, of every kind — `db_error`-bearing
 *     `batch_location_conflict` holds and `sub_watermark_suspected_dup` holds included,
 *     which are precisely the two the incident produced. Deciding here which kinds
 *     "deserve" a case is how the next kind goes missing.
 *   - NOT allowed to fail a run. Every write is already done by the time this runs; a
 *     failure here is reported (an `error`-level progress beat, which is durable in
 *     `sync_run_events` and lands in the workbook's Run Log) and never thrown. Silence is
 *     the one thing it may not do.
 *
 * Runs BEFORE the Excel report stage, because the workbook's "Awaiting Review" sheet reads
 * `sync_held_cases` filtered on `last_run_id` — a case written after the workbook is a
 * case the workbook cannot list.
 */
import type { DbClient } from "../lib/db.js";
import type { HeldRow as WorkerHeldRow } from "./normalizeReport.js";
import {
  caseFingerprint,
  collectHeldRows,
  type AppSyncRunResult,
} from "../reports/excel/findingsBridge.js";

/** What the step reports back — folded into the run result so the counts are durable. */
export interface PersistCasesOutcome {
  ok: boolean;
  /** Held rows seen across every report. */
  held: number;
  /** Cases written for the first time. */
  created: number;
  /** Existing cases whose `last_run_id` / `last_seen_at` were refreshed. */
  refreshed: number;
  /** Rows that could not be written (each one is also named in `errors`). */
  failed: number;
  /** Operator-readable failures. Never a stack trace as the headline. */
  errors: string[];
}

const EMPTY: PersistCasesOutcome = {
  ok: true,
  held: 0,
  created: 0,
  refreshed: 0,
  failed: 0,
  errors: [],
};

/**
 * Project every held row of `result` into `sync_held_cases`, idempotently.
 *
 * NEVER THROWS. A per-row failure is counted and named and the loop carries on — one
 * unwritable case must not cost the other nine their visibility, which is the same
 * reasoning that made BUG-027's location clash a held row instead of a fatal error.
 */
export async function persistHeldCases(
  db: DbClient,
  runId: string,
  result: unknown,
): Promise<PersistCasesOutcome> {
  // A null/absent result is not an error — it is a run with no per-report envelope at all
  // (a pre-R2 run, an M0/M1 manifest). Nothing to project, nothing to report.
  if (!result || typeof result !== "object") return { ...EMPTY };

  let collected: ReturnType<typeof collectHeldRows>;
  try {
    collected = collectHeldRows(result as AppSyncRunResult);
  } catch (exc) {
    return { ...EMPTY, ok: false, failed: 0, errors: [`could not read the run's held rows: ${errMsg(exc)}`] };
  }
  if (!collected.length) return { ...EMPTY };

  let created = 0;
  let refreshed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const { reportType, held } of collected) {
    const row = held as WorkerHeldRow;
    try {
      const fingerprint = caseFingerprint(reportType, held);
      const outcome = await db.upsertHeldCase({
        runId,
        fingerprint,
        reportType,
        kind: row.kind ?? "other",
        naturalKey: row.natural_key,
        reason: row.reason ?? null,
        detail: row.detail ?? null,
        row: (row.row ?? null) as Record<string, unknown> | null,
      });
      if (outcome === "created") created += 1;
      else refreshed += 1;
    } catch (exc) {
      failed += 1;
      errors.push(
        `${reportType} — "${row.natural_key || row.reason || "a held row"}" could not be ` +
          `recorded for review: ${errMsg(exc)}`,
      );
    }
  }

  return { ok: failed === 0, held: collected.length, created, refreshed, failed, errors };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
