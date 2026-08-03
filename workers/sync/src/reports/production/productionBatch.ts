/**
 * productionBatch.ts — resolves `production_batch` from the PLANT'S RUNNING STATE,
 * not from the calendar (BUG: MC batch-transition markers, 2026-08-03).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS FIXES
 * ─────────────────────────────────────────────────────────────────────────────
 * `extract_daily_production.py` (and the TS port, until now) derived
 * `production_batch` from the SHEET DATE's calendar month:
 *     production_batch = MONTH_NAME_UPPER[sheet_month]
 * That is wrong on two counts:
 *
 *   1. Batches are NOT calendar months. Verified from `production_shifts`, every
 *      batch routinely starts in the PRIOR month and ends in the NEXT one:
 *          DECEMBER 2025-11-27 -> 2025-12-28   JANUARY 2026-01-02 -> 2026-02-02
 *          FEBRUARY 2026-02-02 -> 2026-02-27   MARCH    2026-02-28 -> 2026-03-30
 *          APRIL    2026-03-30 -> 2026-04-30   MAY      2026-04-30 -> 2026-05-29
 *          JUNE     2026-05-29 -> 2026-06-30   JULY     2026-06-30 -> 2026-07-31
 *      The sequence is strict and unbroken — never skipped, never repeated — but
 *      the month NAME and the calendar month disagree at every boundary. A batch
 *      can also end EARLY inside its own month (Renzo, 2026-08-03), so "the
 *      previous calendar month" is not a safe substitute either.
 *
 *   2. On a CHANGEOVER DAY two batches produce on the SAME date. MC marks this in
 *      the runs block's column H with the words `ENDING` (the final output of the
 *      batch that was already running) and `STARTING` (a brand-new batch opening
 *      that day, after the plant is emptied) — see LEARNING_LEDGER L-007. With the
 *      calendar derivation both land under one `production_batch`, so the two
 *      same-grade rows collapse to ONE `(shift_id, customer, grade)` key and
 *      `apply.ts`'s L-026 combine SUMS them into a single wrong row.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE (Renzo, 2026-08-03)
 * ─────────────────────────────────────────────────────────────────────────────
 *   - `ENDING` row     -> the batch that was already running.
 *   - `STARTING` row   -> a NEW batch = the NEXT NAME IN THE MONTH SEQUENCE after
 *                         the running batch (NOT the sheet's calendar month —
 *                         this must be right when a batch starts on July 30 or on
 *                         August 2).
 *   - unmarked row     -> the currently running batch.
 *   - downtime         -> the currently running batch (the day's pre-transition
 *                         batch; downtime carries no marker of its own).
 *
 * The running batch is seeded from the DB — the most recent
 * `production_shifts.production_batch` at or before the sync's `since` floor,
 * which is strictly before every sheet the run will read — and then FOLDED
 * FORWARD across the run's sheets in date order, so a changeover mid-run is
 * carried into the following days.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURITY
 * ─────────────────────────────────────────────────────────────────────────────
 * Zero I/O, zero DB, zero workbook access. `index.ts` does the one DB read and
 * hands the rows to `resolveRunningBatch`; `extractMc.ts` hands the per-sheet
 * marker scan to `buildBatchPlans`. Both are total functions over their inputs.
 */
import { MONTH_NAMES, monthName } from "../../lib/months.js";

// ── Column-H batch-transition markers (L-007) ───────────────────────────────

/** The two batch-transition words MC writes in the runs block's column H. */
export type BatchMarker = "ENDING" | "STARTING";

/**
 * Recognized marker words, keyed by the TRIMMED-UPPERCASED cell text. Column H is
 * genuinely DUAL-PURPOSE — on an overtime day it carries real shift labels
 * (`DAY SHIFT` / `OVERTIME`), on a changeover day it carries these markers, and
 * most days it is blank. Discrimination is BY VALUE; the column is never
 * "repurposed" as a batch column.
 */
const MARKER_WORDS: Record<string, BatchMarker> = {
  ENDING: "ENDING",
  STARTING: "STARTING",
};

/**
 * The marker a column-H cell carries, or `null` when the text is not a marker
 * (a real shift label, a blank, or an unrecognized word — all of which stay on
 * the pre-existing `resolveRunShift` path).
 */
export function batchMarkerFor(text: string | null | undefined): BatchMarker | null {
  if (text === null || text === undefined) return null;
  return MARKER_WORDS[text.trim().toUpperCase()] ?? null;
}

/**
 * The shift a marker row belongs to. `STARTING`/`ENDING` only ever happen on the
 * MORNING shift (Renzo, 2026-08-03) — this is an EXPLICIT DOMAIN RULE, not the
 * accidental "unrecognized label -> default to Morning" fallback it used to hit.
 * A marker row is therefore NOT `_shift_defaulted`, carries no default-note in
 * `remarks`, and raises no `unrecognized shift` warning.
 */
export const MARKER_SHIFT = "M";

// ── Month-name sequence helpers ─────────────────────────────────────────────

/** Index of `name` in the canonical month sequence, or -1 when it isn't one. */
function monthIndex(name: string | null | undefined): number {
  if (!name) return -1;
  return MONTH_NAMES.indexOf(name.trim().toUpperCase());
}

/**
 * The NEXT batch name after `current` in the strict monthly sequence
 * (DECEMBER wraps to JANUARY). Returns `null` when `current` is not a recognized
 * month name — the caller then falls back to the calendar and says so.
 */
export function nextBatchName(current: string | null | undefined): string | null {
  const i = monthIndex(current);
  if (i < 0) return null;
  return MONTH_NAMES[(i + 1) % 12];
}

/** The PREVIOUS name in the sequence (JANUARY wraps to DECEMBER). Cold-start only. */
function previousBatchName(current: string): string {
  const i = monthIndex(current);
  if (i < 0) return current;
  return MONTH_NAMES[(i + 11) % 12];
}

// ── Seeding the running batch from the DB ───────────────────────────────────

/** The two columns `resolveRunningBatch` reads off a `production_shifts` row. */
export interface ShiftBatchRow {
  transaction_date?: unknown;
  production_batch?: unknown;
}

function isoOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function batchOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/**
 * The `production_batch` already RUNNING as of `cutoffIso` (inclusive), from a
 * list of `production_shifts` rows. `null` = COLD START (the DB knows no batch
 * at or before the cutoff).
 *
 * A changeover day carries TWO batches on the SAME date (e.g. 2026-06-30 holds
 * both JUNE and JULY), so "the latest row" is ambiguous. The batch that is
 * RUNNING is the one that STARTED most recently, so ties on the latest date are
 * broken by each candidate's FIRST-SEEN date (later wins); a further tie falls
 * back to the alphabetically-last name purely so the function stays total and
 * deterministic.
 */
export function resolveRunningBatch(
  rows: readonly ShiftBatchRow[],
  cutoffIso: string,
): string | null {
  const clean: Array<{ iso: string; batch: string }> = [];
  for (const r of rows) {
    const iso = isoOf(r.transaction_date);
    const batch = batchOf(r.production_batch);
    if (iso === null || batch === null) continue;
    if (iso > cutoffIso) continue;
    clean.push({ iso, batch });
  }
  if (clean.length === 0) return null;

  let maxDate = clean[0].iso;
  for (const r of clean) if (r.iso > maxDate) maxDate = r.iso;

  const onMaxDate = [...new Set(clean.filter((r) => r.iso === maxDate).map((r) => r.batch))];
  if (onMaxDate.length === 1) return onMaxDate[0];

  const firstSeen = new Map<string, string>();
  for (const r of clean) {
    const prev = firstSeen.get(r.batch);
    if (prev === undefined || r.iso < prev) firstSeen.set(r.batch, r.iso);
  }
  const ranked = [...onMaxDate].sort((a, b) => {
    const fa = firstSeen.get(a) ?? "";
    const fb = firstSeen.get(b) ?? "";
    if (fa !== fb) return fa < fb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return ranked[ranked.length - 1];
}

// ── Folding the running batch across a run's sheets ─────────────────────────

/** How a `STARTING` row's new batch name was arrived at. */
export type BatchDerivation =
  /** The next name in the sequence after a KNOWN running batch — the normal path. */
  | "sequence"
  /** No prior batch in the DB; the sheet's own calendar month was used. */
  | "calendar_cold_start"
  /** The running batch isn't a recognized month name; the calendar month was used. */
  | "calendar_unknown_running";

/** One sheet's marker scan — the only thing the fold needs from the workbook. */
export interface SheetMarkerScan {
  /** The sheet title exactly as the workbook carries it (the plan's key). */
  name: string;
  /** The sheet's transaction date, YYYY-MM-DD. */
  iso: string;
  /** 1-indexed calendar month of `iso` — used only by the calendar fallbacks. */
  month: number;
  /** True when at least one EMITTABLE run row on the sheet is marked `STARTING`. */
  hasStarting: boolean;
}

/** How one sheet's rows map onto `production_batch` values. */
export interface SheetBatchPlan {
  /** The batch already running when the day started (unmarked + `ENDING` rows, downtime). */
  running: string;
  /** The batch a `STARTING` row opens — `null` when the sheet has no `STARTING`. */
  starting: string | null;
  /** True when `running` had to be guessed from the calendar (cold start). */
  coldStart: boolean;
}

/** A changeover the fold detected — one per sheet carrying a `STARTING` marker. */
export interface BatchTransition {
  transaction_date: string;
  /** The new batch the `STARTING` row opens. */
  new_batch: string;
  /** The batch it follows (the one that was running). */
  previous_batch: string;
  /** How `new_batch` was derived. */
  derivation: BatchDerivation;
  /** Sheet title the marker was read from. */
  source_sheet: string;
}

/** Everything the fold produced — the plans plus the run-visibility diagnostics. */
export interface BatchResolution {
  /** The DB-derived seed (`null` = cold start). */
  seed: string | null;
  /** Per-sheet plan, keyed by SHEET TITLE (`SheetMarkerScan.name`). */
  plans: Map<string, SheetBatchPlan>;
  /** Sheet dates whose batch had to be guessed from the calendar. */
  coldStartDates: string[];
  /** Every changeover detected, in date order. */
  transitions: BatchTransition[];
}

/**
 * Fold the running batch forward across a run's sheets, in DATE order, and emit
 * one `SheetBatchPlan` per sheet.
 *
 * COLD START (`seed === null` — the DB knows no batch before this run): the
 * running batch falls back to the sheet's own CALENDAR MONTH, which reproduces
 * the pre-fix behavior exactly, and the date is recorded in `coldStartDates` so
 * the caller can say so out loud. On a cold-start sheet that ALSO carries a
 * `STARTING`, the fallback is applied to the NEW batch (a batch opening that day
 * is, absent any other information, that day's month) and the closing batch
 * becomes the PRECEDING name — so the two still resolve to DIFFERENT batches and
 * the changeover-day collision cannot reappear. Both are explicit, reported
 * guesses; nothing is guessed silently.
 *
 * PURE: the sort is on a copy, so the caller's sheet order (which is the
 * parity-critical emission order) is never disturbed.
 */
export function buildBatchPlans(
  sheets: readonly SheetMarkerScan[],
  seed: string | null,
): BatchResolution {
  const plans = new Map<string, SheetBatchPlan>();
  const coldStartDates: string[] = [];
  const transitions: BatchTransition[] = [];

  const ordered = [...sheets].sort((a, b) => {
    if (a.iso !== b.iso) return a.iso < b.iso ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  let running: string | null = seed;

  for (const s of ordered) {
    let dayRunning: string;
    let dayStarting: string | null = null;
    let derivation: BatchDerivation = "sequence";
    const coldStart = running === null;

    if (running === null) {
      const calendar = monthName(s.month);
      if (s.hasStarting) {
        dayStarting = calendar;
        dayRunning = previousBatchName(calendar);
      } else {
        dayRunning = calendar;
      }
      derivation = "calendar_cold_start";
      coldStartDates.push(s.iso);
    } else {
      dayRunning = running;
      if (s.hasStarting) {
        const next = nextBatchName(running);
        if (next !== null) {
          dayStarting = next;
          derivation = "sequence";
        } else {
          dayStarting = monthName(s.month);
          derivation = "calendar_unknown_running";
        }
      }
    }

    plans.set(s.name, { running: dayRunning, starting: dayStarting, coldStart });

    if (dayStarting !== null) {
      transitions.push({
        transaction_date: s.iso,
        new_batch: dayStarting,
        previous_batch: dayRunning,
        derivation,
        source_sheet: s.name,
      });
    }

    running = dayStarting ?? dayRunning;
  }

  return { seed, plans, coldStartDates, transitions };
}
