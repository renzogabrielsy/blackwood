/**
 * wasteGap.ts — THE NO-SILENT-SKIP AUDIT for Ivy's cumulative waste workbook (L-052,
 * 2026-09-17).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WENT WRONG
 * ─────────────────────────────────────────────────────────────────────────────
 * `runReport` computed ONE `since` — MC's `production_runs` frontier — and handed it to
 * BOTH extractors. `extractIvy`'s per-row filter is `txnIso <= since -> continue`:
 * exclusive and SILENT. Ivy's WASTE PRODUCTION REPORT is CUMULATIVE and always lands
 * later than MC's daily report, so the moment MC's frontier crossed a day Ivy had not yet
 * filed, that day's waste was skipped with no finding, no hold and no log line — and the
 * frontier only moves forward, so no later run could ever retry it.
 *
 * Measured (2026-09-17, replaying Ivy's live workbook through the real extractor): FIVE
 * waste days lost — 2026-07-24 (5,746.5 kg), 2026-07-30 (4,318.5), 2026-07-31 (1,199.5),
 * JULY's 2026-08-01 carryover (590.5) and 2026-08-04 (4,185.5) — every one of them on a
 * shift that already carried MC's production runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS AN AUDIT AND NOT A WIDER WINDOW
 * ─────────────────────────────────────────────────────────────────────────────
 * The obvious fix — classify EVERY row of the cumulative workbook and let the existing
 * `DUPLICATE_NOOP` path absorb the ones already present — was MEASURED before it was
 * rejected. Over her live 2026 workbook (226 rows, JANUARY … SEPTEMBER):
 *
 *     NEW 5  ·  VALUE_CHANGED 141  ·  DUPLICATE_NOOP 80  ·  MALFORMED 0
 *
 * 140 of those 141 differ ONLY in `remarks` (a buyer note the early-2026 rows were
 * written without), and the VALUE_CHANGED write path has been LIVE since 2026-08-04 — so
 * a full-history pass would silently rewrite 141 historical rows on the first run after
 * deploy. The 141st is worse: the 2026-08-01 AUGUST shift, whose stored row is JULY's
 * carryover, would be overwritten in place with no human ever seeing it. A frontier fix
 * must not smuggle a mass edit of history in beside it.
 *
 * So the window stays bounded (see `index.ts`) and THIS runs beside it: every row the
 * window excluded is checked against what the database actually holds, and anything
 * genuinely wrong is NAMED. Nothing here writes. The repair is
 * `scripts/backfill-waste-frontier-gap.ts`, run by a human — one mechanism, not two.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO ARMS, AND WHY EXACTLY TWO
 * ─────────────────────────────────────────────────────────────────────────────
 *   A. `waste_row_missing`  — Ivy's file has a row for a shift that EXISTS in the
 *      database and has NO `production_waste` child. That is the dropped row, exactly.
 *      Measured today: 5, all five the victims above.
 *
 *   B. `waste_row_disagrees` — the shift exists, it HAS a waste row, and at least one of
 *      the eight STREAM figures differs beyond the classifier's own 0.01 tolerance.
 *      `remarks` alone is deliberately NOT enough: that is the 140-row historical
 *      cosmetic difference, and an alarm that fires 140 times is an alarm nobody reads.
 *      Measured today: 1 — the 2026-08-01 AUGUST shift holding JULY's 590.5 kg carryover
 *      against the AUGUST tab's own 993.5 kg row.
 *
 * BOTH arms are floored at the SYNC ERA (2026-05-25). Below it the database's waste came
 * from Renzo's own `MASTER ICTC INPUT FILE V1.xlsx` — 158 rows seeded in one write on
 * 2026-05-27 covering 2025-11-27 … 2026-05-23, measured, the identical era the L-051
 * downtime backfill floored out of. Those rows are a HUMAN'S curated figures, not a
 * dropped sync write, so a disagreement there is not this bug and an alarm pointing at it
 * would be an alarm with no action behind it (the backfill refuses them by the same
 * floor). There are two: the 2026-02-02 JANUARY→FEBRUARY changeover, where the workbook
 * and the seeded rows disagree about which batch the day's 2,380.5 kg belongs to. They are
 * COUNTED on every note (`pre_sync_era_rows`) rather than pretended away.
 *
 * A row whose (date, batch, shift) triplet resolves to NO shift at all is neither: there
 * is nothing to compare it to and nothing to repair against. It is still counted and its
 * dates still ride in the note's data (`unmatched_dates`) rather than disappearing —
 * measured 0 of 226 today, and stated so it can never become invisible if that changes.
 *
 * The tolerance and the field list are IMPORTED FROM THE CLASSIFIER, never restated: a
 * second definition of "these two waste rows disagree" is how the two screens start
 * saying different things.
 */
import type { WasteRow } from "./extractIvy.js";
import type { ShiftDbRow, WasteDbRow } from "./classify.js";
import { WASTE_STREAM_FIELDS, wasteStreamsEqual } from "./classify.js";
import { roundHalfToEven } from "../../lib/norm.js";

/**
 * ONE waste row Ivy's workbook states that the database does not agree with, found
 * BELOW the sync window — i.e. a row no future run would have looked at.
 *
 * Run-visibility only: nothing is written, nothing is held, and it is NEVER a `HeldKind`
 * (that enum is frontend-locked). Ivy's workbook is CUMULATIVE, so the note re-fires
 * every run until the row is repaired — the same self-restating property the human-edit
 * findings rely on, and the reason nothing needs to be parked in the database.
 *
 * Production carries no ₱/cost column anywhere, so no field here can be a price.
 * Shape mirrors `app/(app)/sync/types.ts::WasteGapNote` exactly.
 */
export interface WasteGapNote {
  /** `waste_row_missing` | `waste_row_disagrees`. A field, not a literal, so a third
   *  flavour needs no parallel channel. */
  kind: string;
  transaction_date: string;
  production_batch: string;
  shift: string;
  /** The shift the triplet resolved to. Never null on an emitted note. */
  shift_id: string;
  /** Does that shift already carry MC's production runs? (A day the plant reported.) */
  shift_has_runs: boolean;
  /** The sheet + row the figures came from, so the operator can open it. */
  source_sheet: string;
  source_row: number;
  /** The eight streams as Ivy's workbook states them, plus their sum and her buyer note. */
  sheet_streams: Record<string, number>;
  sheet_total_kg: number;
  sheet_remarks: string | null;
  /** The stored row — present ONLY on `waste_row_disagrees`. */
  db_waste_id: string | null;
  db_streams: Record<string, number | null> | null;
  db_total_kg: number | null;
  db_remarks: string | null;
  /** Which of the eight streams differ (`waste_row_disagrees` only). */
  differing_streams: string[];
  /** Is the stored row claimed by a human? (The backfill will refuse to touch it.) */
  db_human_edited: boolean;
  /** The `since` this run used for waste — the floor that excluded the row. */
  waste_since: string | null;
  /** Dates of below-window rows whose triplet matched NO shift at all. Measured 0 today;
   *  carried so a future one is visible rather than silent. Same on every note of a run. */
  unmatched_dates: string[];
  /** Below-window rows older than the sync era, which this audit deliberately does not
   *  judge (the database holds Renzo's own master-file figures there). Same on every
   *  note of a run. */
  pre_sync_era_rows: number;
}

/**
 * The first `transaction_date` the SYNC itself wrote a production fact for. Everything
 * before it was seeded by hand on 2026-05-27 from `MASTER ICTC INPUT FILE V1.xlsx`
 * (measured: 158 waste rows, 2025-11-27 … 2026-05-23 — the identical era
 * `scripts/backfill-downtime-ranges.ts` floors at, for the identical reason).
 *
 * ONE definition: `scripts/backfill-waste-frontier-gap.ts` imports it rather than
 * restating it, and a test pins the downtime backfill's own literal to this value.
 */
export const SYNC_ERA_START = "2026-05-25";

/** trim + UPPERCASE — the classifier's own `normKeyPart`, mirrored for the triplet key. */
function keyPart(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t ? t.toUpperCase() : null;
}

function tripletKey(date: unknown, batch: unknown, shift: unknown): string {
  return `${date ?? "null"}|${keyPart(batch) ?? "null"}|${keyPart(shift) ?? "null"}`;
}

function streamsOf(row: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of WASTE_STREAM_FIELDS) out[f] = Number(row[f] ?? 0);
  return out;
}

function dbStreamsOf(row: WasteDbRow): Record<string, number | null> {
  const src = row as unknown as Record<string, unknown>;
  const out: Record<string, number | null> = {};
  for (const f of WASTE_STREAM_FIELDS) {
    const v = src[f];
    out[f] = v === null || v === undefined ? null : Number(v);
  }
  return out;
}

function sum(vals: Record<string, number | null>): number {
  let t = 0;
  for (const v of Object.values(vals)) t += Number(v ?? 0);
  // `roundHalfToEven(…, 4)` — the extractor's OWN grain for `_summed_kg`, reached through
  // the one rounding helper rather than a local `Math.round` (the porting rule), so a
  // note's total and the row's own total can never round differently.
  return roundHalfToEven(t, 4);
}

export interface AuditWasteGapInput {
  /** Rows the `since` floor excluded from classify (`IvyExtract.belowSince`). */
  belowSince: WasteRow[];
  /** Shifts covering those rows' dates. */
  shifts: ShiftDbRow[];
  /** Every `production_waste` row (UNFILTERED by the classify window — a below-window
   *  shift's child would not be in the windowed set, which is the whole point). */
  wasteRows: WasteDbRow[];
  /** `shift_id`s that carry at least one `production_runs` child. */
  shiftIdsWithRuns: Set<string>;
  /** The `since` this run used for waste — recorded on every note. */
  wasteSince: string | null;
  /** Rows older than this are not judged (default `SYNC_ERA_START`). */
  floor?: string;
}

/**
 * Compare every excluded row against the database. Returns one note per genuinely wrong
 * row, oldest first. An empty array is the passing state and the ordinary case.
 */
export function auditWasteGap(input: AuditWasteGapInput): WasteGapNote[] {
  const { belowSince, shifts, wasteRows, shiftIdsWithRuns, wasteSince } = input;
  const floor = input.floor ?? SYNC_ERA_START;
  if (belowSince.length === 0) return [];

  const shiftByTriplet = new Map<string, ShiftDbRow>();
  for (const s of shifts) {
    if (!s.id) continue;
    shiftByTriplet.set(
      tripletKey(String(s.transaction_date ?? "").slice(0, 10), s.production_batch, s.shift),
      s,
    );
  }
  const wasteByShift = new Map<string, WasteDbRow>();
  for (const w of wasteRows) if (w.shift_id) wasteByShift.set(String(w.shift_id), w);

  const unmatched: string[] = [];
  let preEra = 0;
  const found: Array<Omit<WasteGapNote, "unmatched_dates" | "pre_sync_era_rows">> = [];

  for (const row of belowSince) {
    if (row.transaction_date < floor) {
      preEra++;
      continue;
    }
    const shift = shiftByTriplet.get(
      tripletKey(row.transaction_date, row.production_batch, row.shift),
    );
    if (!shift || !shift.id) {
      // No shift to hang it on. Nothing to repair against and nothing to compare to —
      // but it is COUNTED, never dropped on the floor.
      if (!unmatched.includes(row.transaction_date)) unmatched.push(row.transaction_date);
      continue;
    }
    const shiftId = String(shift.id);
    const sheetStreams = streamsOf(row as unknown as Record<string, unknown>);
    const base = {
      transaction_date: row.transaction_date,
      production_batch: row.production_batch,
      shift: row.shift,
      shift_id: shiftId,
      shift_has_runs: shiftIdsWithRuns.has(shiftId),
      source_sheet: row._source_sheet,
      source_row: row._source_row,
      sheet_streams: sheetStreams,
      sheet_total_kg: sum(sheetStreams),
      sheet_remarks: row.remarks ?? null,
      waste_since: wasteSince,
    };

    const dbRow = wasteByShift.get(shiftId);
    if (dbRow === undefined) {
      found.push({
        ...base,
        kind: "waste_row_missing",
        db_waste_id: null,
        db_streams: null,
        db_total_kg: null,
        db_remarks: null,
        differing_streams: [],
        db_human_edited: false,
      });
      continue;
    }

    // ARM B. Streams only — `remarks` alone is the 140-row historical cosmetic diff and
    // must not raise an alarm. The comparison is the CLASSIFIER'S, imported not restated.
    const differing = WASTE_STREAM_FIELDS.filter(
      (f) =>
        !wasteStreamsEqual(
          (row as unknown as Record<string, unknown>)[f],
          (dbRow as unknown as Record<string, unknown>)[f],
        ),
    );
    if (differing.length === 0) continue;

    const dbStreams = dbStreamsOf(dbRow);
    found.push({
      ...base,
      kind: "waste_row_disagrees",
      db_waste_id: dbRow.id ? String(dbRow.id) : null,
      db_streams: dbStreams,
      db_total_kg: sum(dbStreams),
      db_remarks: dbRow.remarks ?? null,
      differing_streams: [...differing],
      db_human_edited:
        (dbRow as unknown as Record<string, unknown>).human_edited_at != null,
    });
  }

  unmatched.sort();
  return found
    .sort((a, b) =>
      a.transaction_date === b.transaction_date
        ? a.production_batch.localeCompare(b.production_batch)
        : a.transaction_date.localeCompare(b.transaction_date),
    )
    .map((n) => ({ ...n, unmatched_dates: unmatched, pre_sync_era_rows: preEra }));
}
