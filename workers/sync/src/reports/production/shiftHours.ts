/**
 * shiftHours.ts — how long the shift the downtime sits inside actually was.
 *
 * L-051, 2026-09-14. `production_downtime.shift_hrs` was the literal constant `12` in the
 * extractor, written on every row the sync has ever filed. It is the denominator of the
 * app's PROD HRS figure (`shift − downtime`), so a wrong shift length makes every
 * productive-hours number wrong in the same direction on every day at once.
 *
 * **NO CELL IN MC'S WORKBOOK STATES THE SHIFT LENGTH.** Both surviving workbooks were
 * scanned for one (`HRS`, `HOUR`, `SHIFT`): the only shift words are the runs block's
 * `DAY SHIFT` / `OVERTIME` labels, the CHARCOAL FED block's `1ST SHIFT` / `OVERTIME`
 * rows, and the MAGNET block's `DAY SHIFT (1ST SHIFT)` / `NIGHT SHIFT (2ND SHIFT)`
 * headers — none of which carries a number of hours. So the length is DERIVED from
 * whether the day ran overtime, and the basis is RECORDED alongside it
 * (`production_downtime.shift_hrs_source`) so a reader can see which rule fired instead
 * of having to trust a bare number.
 *
 * THE RULE
 *   - The day carried an OVERTIME signal → **12 h**.
 *   - Otherwise                          → **8 h**, the app's own convention
 *                                          (`app/(app)/production/daily/ledger-derive.ts`
 *                                          computes PROD HRS as `8 − DT TTL`).
 *
 * TWO INDEPENDENT SIGNALS, either of which is enough, because MC fills them in different
 * places and has stopped filling each of them at different times:
 *   1. A runs row labelled `OVERTIME` in column H that actually produced kilos. (Live on
 *      2026-07-01…07-11 and 07-22…07-25; absent from 07-13 onward and all of Aug/Sep.)
 *   2. The CHARCOAL FED block's `OVERTIME` row carrying sacks. (Same days: 375 sacks on
 *      2026-07-23, `0` on every day since.)
 * A label with no kilos and an `OVERTIME` row reading 0 are both "we printed the row,
 * nobody worked it" — they are NOT a signal, which is why each clause tests the NUMBER
 * and not the label's presence.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not read `ENDING` / `STARTING` as a shift
 * label — those are batch-changeover markers (L-007) and say nothing about hours — and it
 * does not infer a longer shift from a late downtime range. A stoppage that ends at
 * 5:00 PM is evidence about the stoppage, not about whether anyone was paid overtime.
 *
 * ⚠️ OPEN FOR RENZO. Three different numbers are in play across the system: the sync
 * wrote 12, the app derives 8, and the 158 rows backfilled from `MASTER ICTC INPUT FILE
 * V1.xlsx` (2025-11-27 … 2026-05-23) all carry **9**. The 8 here matches the app, which
 * is the number a person actually sees; if the plant's real day shift is 9 h, change
 * `DEFAULT_SHIFT_HRS` and the app's ledger together — they must never disagree again.
 */
import type { LoadedSheet, CellValue } from "../../lib/xlsx.js";

/** Shift length, in hours, for an ordinary day with no overtime signal. */
export const DEFAULT_SHIFT_HRS = 8;
/** Shift length, in hours, for a day that carried an overtime signal. */
export const OVERTIME_SHIFT_HRS = 12;

/**
 * Why a downtime row carries the `shift_hrs` it carries. Persisted verbatim into
 * `production_downtime.shift_hrs_source` (CHECKed to exactly these three).
 *
 *   `overtime_signal` — the day ran overtime, so 12 h.
 *   `duration_only`   — no overtime, 8 h, AND this row's minutes came from the hand-written
 *                       DURATION cell because no time range could be read. Recorded
 *                       distinctly because it tells a reader the figure is the operator's
 *                       own summary rather than the list of stoppages.
 *   `default_8h`      — no overtime, 8 h, minutes read from the time ranges.
 */
export type ShiftHrsSource = "overtime_signal" | "duration_only" | "default_8h";

export interface OvertimeScan {
  /** True when either signal fired. */
  hasOvertime: boolean;
  /** Kilos filed under an `OVERTIME` runs label. */
  overtimeRunKg: number;
  /** Sacks on the CHARCOAL FED `OVERTIME` row, or null when the block was not found. */
  overtimeFedSacks: number | null;
}

// ── CHARCOAL FED block ──────────────────────────────────────────────────────
const FED_ANCHOR_MIN = 16;
const FED_ANCHOR_MAX = 34;
/** The block spans columns J..N; its row labels sit in J. */
const COL_FED_LABEL = 10; // J
const COL_FED_VALUE = 11; // K
const FED_LABEL_SEARCH_DEPTH = 8;

function upper(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return "";
  return String(value).trim().toUpperCase();
}

function num(value: CellValue): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value instanceof Date) return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned) return null;
  const f = Number(cleaned);
  return Number.isFinite(f) ? f : null;
}

/**
 * Sacks on the CHARCOAL FED block's `OVERTIME` row, or null when the block is absent
 * (a stripped synthetic sheet). Anchors on the block title rather than a fixed row — the
 * 3Q layout moved every section below the runs block down by one, the same reason the
 * downtime/electricity/truck locators anchor.
 */
export function charcoalFedOvertimeSacks(ws: LoadedSheet): number | null {
  let anchor: number | null = null;
  for (let r = FED_ANCHOR_MIN; r <= FED_ANCHOR_MAX && anchor === null; r++) {
    for (let c = COL_FED_LABEL; c <= COL_FED_LABEL + 4; c++) {
      if (upper(ws.cell(r, c)) === "CHARCOAL FED") {
        anchor = r;
        break;
      }
    }
  }
  if (anchor === null) return null;
  for (let r = anchor + 1; r <= anchor + FED_LABEL_SEARCH_DEPTH; r++) {
    if (upper(ws.cell(r, COL_FED_LABEL)) === "OVERTIME") {
      return num(ws.cell(r, COL_FED_VALUE));
    }
  }
  return null;
}

/** True when a runs-block column-H label names the overtime shift. */
export function isOvertimeLabel(label: string | null | undefined): boolean {
  if (label == null) return false;
  const s = String(label).trim().toUpperCase();
  return s === "OVERTIME" || s === "OVER TIME" || s === "OT" || s === "OVERTIME SHIFT";
}

/**
 * Decide the day's shift length from the two overtime signals.
 *
 * `runLabels` is one `{ label, kg }` per EMITTABLE runs row (the same grade gate the
 * extractor applies), so an `OVERTIME` marker parked on a dropped grade cannot fire it —
 * the same discipline `sheetHasStartingMarker` uses for batch markers.
 */
export function scanOvertime(
  runLabels: Array<{ label: string | null; kg: number | null }>,
  fedOvertimeSacks: number | null,
): OvertimeScan {
  let overtimeRunKg = 0;
  for (const r of runLabels) {
    if (!isOvertimeLabel(r.label)) continue;
    if (typeof r.kg === "number" && Number.isFinite(r.kg) && r.kg > 0) overtimeRunKg += r.kg;
  }
  const hasOvertime = overtimeRunKg > 0 || (fedOvertimeSacks !== null && fedOvertimeSacks > 0);
  return { hasOvertime, overtimeRunKg, overtimeFedSacks: fedOvertimeSacks };
}

/** `shift_hrs` + the basis to record beside it. */
export function resolveShiftHours(
  scan: OvertimeScan,
  minutesSource: "ranges" | "duration" | "none",
): { shiftHrs: number; source: ShiftHrsSource } {
  if (scan.hasOvertime) return { shiftHrs: OVERTIME_SHIFT_HRS, source: "overtime_signal" };
  if (minutesSource === "duration") {
    return { shiftHrs: DEFAULT_SHIFT_HRS, source: "duration_only" };
  }
  return { shiftHrs: DEFAULT_SHIFT_HRS, source: "default_8h" };
}
