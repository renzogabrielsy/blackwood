/**
 * refresh.ts — the production-schedule refresh orchestration for the sync worker.
 *
 * Mirrors scripts/sync-prod-schedule.ts::syncProdSchedule end to end, but wired to the
 * worker's own IO (downloadGsheet + GmailClient + DbClient service-role upsert):
 *
 *   1. Get Renzo's workbook bytes (reuse an injected buffer if the caller already has
 *      the gsheet download; else download via the shared downloadGsheet util).
 *   2. parseProdSchedule() the PROD SCHED tab → Renzo base rows.
 *   3. Fetch Joseph's latest schedule email, parseJosephSchedule() + mergeSchedules()
 *      his scheduling over Renzo's tonnages. If Joseph is unavailable / unparseable →
 *      fall back to a Renzo-only refresh (still writes the plan).
 *   4. CONDITIONALLY write `production_schedule` — see below.
 *
 * STEP 4 CHANGED 2026-07-30 (Phase A of the schedule "master plotter"). It used to be an
 * UNCONDITIONAL `upsertProductionSchedule` of EVERY plan_date on EVERY run, which
 * re-applied the same Joseph email over and over — harmless while the plan was sync-owned,
 * a silent-overwrite machine the moment it becomes editable in-app. It is now:
 *
 *      stamp source_rev  →  snapshot view_production_schedule_state
 *                        →  plan PURELY (./plan.ts, the six rules)
 *                        →  fn_apply_schedule_upstream (atomic, guards re-checked in SQL)
 *
 * The load-bearing rule: when the incoming revision already matches what a row carries,
 * the sync writes NOTHING for that day. The steady state of this step is a ZERO-WRITE run.
 * A human-owned day whose upstream value differs is never written — the proposal is parked
 * in `pending_upstream` and returned as a `ScheduleConflict` for the run's findings list.
 *
 * NON-FATAL by contract: refreshProductionSchedule swallows every failure and returns a
 * result flagged `ok:false` + a warning list. The caller (runSync) must never let a
 * schedule failure fail the daily sync — the plan band is decorative, not load-bearing.
 *
 * The pure planning (download-free, DB-free) lives in computeMergedSchedule + ./plan.ts so
 * it can be unit-tested against the saved Joseph fixture + a live/stub gsheet buffer
 * without any DB or Gmail. The parse/merge functions themselves are the verbatim port in
 * ./parse.ts.
 */
import type { DbClient } from "../../lib/db.js";
import { downloadGsheet, GSHEET_EXPORT_URL, type FetchLike } from "../gsheet/download.js";
import {
  parseProdSchedule,
  parseJosephSchedule,
  mergeSchedules,
  type ProdScheduleRow,
  type JosephRev,
} from "./parse.js";
import { fetchLatestJosephSchedule, type JosephSource } from "./josephEmail.js";
import {
  planScheduleUpstream,
  stampSourceRevs,
  toScheduleStateRow,
  type ScheduleConflict,
  type SchedulePlan,
} from "./plan.js";

export interface JosephDiag {
  origin: string;
  sourceTag: string;
  selectedTabs: string[];
  days: number;
  overridden: number;
  warnings: string[];
}

export interface MergedScheduleResult {
  rows: ProdScheduleRow[];
  joseph: JosephDiag | null;
  /** Reason Joseph was skipped (Renzo-only), when applicable. */
  josephSkippedReason?: string;
}

/**
 * PURE planning: parse Renzo's PROD SCHED bytes, optionally overlay Joseph's schedule,
 * and return the merged rows. No IO. `josephSource` is null → Renzo-only. `now` defaults
 * to new Date() only for the quarter/year selection (kept overridable for tests).
 */
export function computeMergedSchedule(
  renzoBuf: Buffer,
  josephSource: JosephSource | null,
  opts: { targetYear?: number; fromQuarter?: number; now?: Date } = {},
): MergedScheduleResult {
  let rows = parseProdSchedule(renzoBuf);
  if (rows.length === 0) {
    throw new Error(
      "Parsed 0 schedule rows — refusing to write (sheet layout may have changed).",
    );
  }

  if (!josephSource) {
    return { rows, joseph: null, josephSkippedReason: "no Joseph workbook available" };
  }

  const now = opts.now ?? new Date();
  const targetYear = opts.targetYear ?? now.getFullYear();
  const fromQuarter = opts.fromQuarter ?? Math.floor(now.getMonth() / 3) + 1;

  const parsed = parseJosephSchedule(josephSource.buffer, { targetYear, fromQuarter });
  const merged = mergeSchedules(rows, parsed.days, josephSource.rev);
  rows = merged.rows;

  const joseph: JosephDiag = {
    origin: josephSource.origin,
    sourceTag: josephSource.rev.sourceTag,
    selectedTabs: parsed.selectedTabs,
    days: parsed.days.length,
    overridden: merged.overriddenDates.length,
    warnings: parsed.warnings,
  };
  return { rows, joseph };
}

export interface RefreshDeps {
  db: DbClient;
  /** Injected fetch for the gsheet export (defaults to platform fetch). */
  fetchImpl?: FetchLike;
  /** Reuse a preloaded Renzo workbook buffer (skips the gsheet download). */
  gsheetBuffer?: Buffer;
  /** Injectable Joseph loader (defaults to the real guarded IMAP fetch). */
  loadJoseph?: () => Promise<JosephSource | null>;
  /** Overridable clock for quarter/year selection (tests). */
  now?: Date;
}

export interface RefreshResult {
  ok: boolean;
  parsed: number;
  /**
   * Rows actually WRITTEN this run (inserted + applied + reclaimed + parked, as confirmed
   * by the RPC's outcomes — not the number we asked for). In the steady state this is 0.
   */
  upserted: number;
  minDate: string | null;
  maxDate: string | null;
  joseph: JosephDiag | null;
  josephSkippedReason?: string;
  /** Per-decision breakdown from the pure planner + the RPC's confirmed outcomes. */
  plan: {
    unchanged: number;
    frozen: number;
    inserted: number;
    applied: number;
    reclaimed: number;
    parked: number;
    /** Ops the RPC refused because the row moved underneath us (never clobbered). */
    versionConflicts: number;
    /** Ops the RPC refused because production has since been reported for the date. */
    frozenAtWrite: number;
  };
  /** Human-owned days whose upstream value was withheld → the run's schedule findings. */
  conflicts: ScheduleConflict[];
  /** Populated when ok:false — a human, copy-pastable failure reason. */
  error?: string;
}

const EMPTY_PLAN = {
  unchanged: 0,
  frozen: 0,
  inserted: 0,
  applied: 0,
  reclaimed: 0,
  parked: 0,
  versionConflicts: 0,
  frozenAtWrite: 0,
};

const EMPTY_FAIL = (error: string): RefreshResult => ({
  ok: false,
  parsed: 0,
  upserted: 0,
  minDate: null,
  maxDate: null,
  joseph: null,
  plan: { ...EMPTY_PLAN },
  conflicts: [],
  error,
});

/**
 * Full refresh: get Renzo's workbook → parse → overlay Joseph (guarded, Renzo-only
 * fallback) → CONDITIONALLY write production_schedule (plan.ts's six rules, applied
 * atomically by fn_apply_schedule_upstream). NON-FATAL: any failure is caught and
 * returned as ok:false; it never throws. Idempotent — and in the steady state, a no-op.
 */
export async function refreshProductionSchedule(deps: RefreshDeps): Promise<RefreshResult> {
  try {
    // 1) Renzo's workbook — reuse the caller's buffer if provided, else download.
    let renzoBuf: Buffer;
    if (deps.gsheetBuffer) {
      renzoBuf = deps.gsheetBuffer;
    } else {
      const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
      renzoBuf = await downloadGsheet(fetchImpl, GSHEET_EXPORT_URL);
    }

    // 2) Joseph's workbook — guarded. Any throw / null → Renzo-only refresh.
    let josephSource: JosephSource | null = null;
    let josephSkippedReason: string | undefined;
    try {
      const loadJoseph = deps.loadJoseph ?? fetchLatestJosephSchedule;
      josephSource = await loadJoseph();
      if (!josephSource) josephSkippedReason = "no matching Joseph schedule email found";
    } catch (err) {
      josephSkippedReason = `Joseph fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      josephSource = null;
    }

    // 3) parse + merge (pure). A 0-row parse throws here and is caught below.
    const merged = computeMergedSchedule(renzoBuf, josephSource, { now: deps.now });
    if (josephSkippedReason && !merged.josephSkippedReason) {
      merged.josephSkippedReason = josephSkippedReason;
    }

    // 4) CONDITIONAL write. Stamp each day's source_rev, snapshot current ownership state,
    //    plan purely, then hand the ops to the atomic RPC. NOTHING here can delete a day,
    //    and a day the plan no longer mentions is simply never named in an op (rule 5).
    const nowIso = (deps.now ?? new Date()).toISOString();
    const stamped = stampSourceRevs(merged.rows, josephSource?.messageTag ?? null);
    const dates = stamped.map((r) => r.plan_date).sort();

    const stateRaw = await deps.db.readScheduleState(dates);
    const state = stateRaw.map((r) => toScheduleStateRow(r as Record<string, unknown>));
    const plan: SchedulePlan = planScheduleUpstream(stamped, state, nowIso);

    // `row` carries source_rev (harmless extra key) — the RPC reads named fields only.
    const outcomes = plan.ops.length
      ? await deps.db.applyScheduleUpstream(
          plan.ops.map((op) => ({
            plan_date: op.plan_date,
            action: op.action,
            expected_row_version: op.expected_row_version,
            expected_owner: op.expected_owner,
            source_rev: op.source_rev,
            new_owner: op.new_owner,
            row: op.row as unknown as Record<string, unknown>,
            pending: op.pending ?? null,
          })),
        )
      : [];

    // Count what the DB actually did, not what we asked for. A row the RPC refused
    // (version_conflict / frozen / missing / exists) was NOT written.
    const tally = { ...EMPTY_PLAN, unchanged: plan.counts.unchanged, frozen: plan.counts.frozen };
    for (const o of outcomes) {
      if (o.outcome === "inserted") tally.inserted++;
      else if (o.outcome === "applied") tally.applied++;
      else if (o.outcome === "reclaimed") tally.reclaimed++;
      else if (o.outcome === "parked") tally.parked++;
      else if (o.outcome === "frozen") tally.frozenAtWrite++;
      else tally.versionConflicts++; // version_conflict | missing | exists
    }
    const written = tally.inserted + tally.applied + tally.reclaimed + tally.parked;

    // Only report a conflict the DB actually parked — one the RPC refused is not a
    // durable pending value and must not be announced as one.
    const parkedDates = new Set(
      outcomes.filter((o) => o.outcome === "parked").map((o) => o.plan_date),
    );
    const conflicts = plan.conflicts.filter((c) => parkedDates.has(c.plan_date));

    return {
      ok: true,
      parsed: merged.rows.length,
      upserted: written,
      minDate: dates[0] ?? null,
      maxDate: dates[dates.length - 1] ?? null,
      joseph: merged.joseph,
      josephSkippedReason: merged.josephSkippedReason,
      plan: tally,
      conflicts,
    };
  } catch (err) {
    return EMPTY_FAIL(err instanceof Error ? err.message : String(err));
  }
}

export type { ProdScheduleRow, JosephRev, ScheduleConflict };
