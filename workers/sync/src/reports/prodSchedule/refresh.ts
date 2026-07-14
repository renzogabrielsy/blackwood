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
 *   4. Upsert `production_schedule` by plan_date (replace-by-date, idempotent).
 *
 * NON-FATAL by contract: refreshProductionSchedule swallows every failure and returns a
 * result flagged `ok:false` + a warning list. The caller (runSync) must never let a
 * schedule failure fail the daily sync — the plan band is decorative, not load-bearing.
 *
 * The pure planning (download-free, DB-free) lives in computeMergedSchedule so it can be
 * unit-tested against the saved Joseph fixture + a live/stub gsheet buffer without any
 * DB or Gmail. The parse/merge functions themselves are the verbatim port in ./parse.ts.
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
  upserted: number;
  minDate: string | null;
  maxDate: string | null;
  joseph: JosephDiag | null;
  josephSkippedReason?: string;
  /** Populated when ok:false — a human, copy-pastable failure reason. */
  error?: string;
}

const EMPTY_FAIL = (error: string): RefreshResult => ({
  ok: false,
  parsed: 0,
  upserted: 0,
  minDate: null,
  maxDate: null,
  joseph: null,
  error,
});

/**
 * Full refresh: get Renzo's workbook → parse → overlay Joseph (guarded, Renzo-only
 * fallback) → upsert production_schedule by plan_date. NON-FATAL: any failure is caught
 * and returned as ok:false; it never throws. Idempotent (replace-by-date).
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

    // 4) upsert by plan_date (replace-by-date). updated_at refreshes each run.
    const nowIso = new Date().toISOString();
    const payload = merged.rows.map((r) => ({ ...r, updated_at: nowIso }));
    await deps.db.upsertProductionSchedule(payload);

    const dates = merged.rows.map((r) => r.plan_date).sort();
    return {
      ok: true,
      parsed: merged.rows.length,
      upserted: payload.length,
      minDate: dates[0] ?? null,
      maxDate: dates[dates.length - 1] ?? null,
      joseph: merged.joseph,
      josephSkippedReason: merged.josephSkippedReason,
    };
  } catch (err) {
    return EMPTY_FAIL(err instanceof Error ? err.message : String(err));
  }
}

export type { ProdScheduleRow, JosephRev };
