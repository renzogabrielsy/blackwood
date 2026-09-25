/**
 * extractionNotes.ts — what the RC DELIVERIES extractor REFUSED to turn into a delivery,
 * and why (2026-09-25, L-054). Pure; no DB, no I/O.
 *
 * THE INCIDENT. MC's `260924 RC DELIVERIES 2026.xlsx`, tab `SEPTEMBER 2026`: the last real
 * truckload is row 68 (Ornales · CCP 1309 · B14 · 10,900 kg), the `Average` row is 76, and
 * rows 82–84 are her own arithmetic typed UNDER the table — only the Weight column is
 * filled: `449325`, `500000`, `-50675` ("500 t target · delivered so far · remaining"). The
 * extractor treated each of them as a WET-RECOVERY SUB-ROW (a row with a weight but no
 * plate, no batch and no block of its own, whose date was forward-filled) and let it
 * INHERIT row 68's supplier, plate, block and batch. Three "deliveries" of 449,325 kg,
 * 500,000 kg and −50,675 kg under `SEPT-26-BLK14` went to the database, and the only thing
 * that stopped them was that `lab_results` happened to be sent as an explicit `null` into a
 * NOT NULL column. A constraint caught it by luck; nothing in the pipeline knew where the
 * table ended.
 *
 * THE RULE THIS MODULE CARRIES: a row becomes a delivery only on a POSITIVE signal from
 * its OWN cells (the L-042 discipline — split by what is there, never by widening a
 * bucket):
 *
 *   - an ordinary truckload names its own SUPPLIER and its own TRUCK PLATE;
 *   - a wet-recovery sub-row (which by definition names neither) must sit DIRECTLY below
 *     the delivery it belongs to — no gap, no Average row in between — AND carry evidence
 *     of its own: a sack count or a remark. Every real one in 64 stored workbooks does
 *     (measured: 6 distinct rows, each 1 row under its mother, each with sacks + an MC
 *     reading + a "net kilos of …" remark); none of the scratch rows does.
 *
 * Anything else that carries a weight is a `stray_row`: reported, never inserted, never
 * held, never blocking the watermark. And a delivery-shaped row whose weight is ≤ 0 or
 * above {@link DELIVERY_WEIGHT_CAP_KG} is a `weight_out_of_range`: refused here, before it
 * can reach the database.
 *
 * NO ₱ ANYWHERE. MC's workbook has no price column (the 16 columns are date, supplier,
 * label, block, plate, weight, sacks, seven lab readings and remarks), and a note only ever
 * echoes the identity/quantity cells plus the remark.
 */

/**
 * Hard ceiling on one truckload, in kg. MEASURED 2026-09-25 over `public.deliveries`
 * (1,790 rows, read-only):
 *   - the heaviest row with a truck plate is 36,069 kg (2024-11-26, Sevilla, NAO3238), and
 *     the heaviest since 2025-01-01 is 35,790 kg (2026-03-26, Ornales, ALA 9425);
 *   - the all-time max is 88,695 kg — but it and all 63 rows above 40,000 kg carry NO truck
 *     plate: they are consolidated opening-balance rows (`2023 BACKLOG`, `SEVILLA 2022
 *     BACKLOG`, `SUNDRY BACKLOG`, sacks 0) seeded by hand, never typed into MC's truck log.
 * 60,000 kg is ~1.7× the heaviest truck ever recorded. It is a last line of defence, not
 * the rule that caught the incident — the positive-signal rule above did.
 */
export const DELIVERY_WEIGHT_CAP_KG = 60_000;

export type ExtractionNoteKind = "stray_row" | "weight_out_of_range";

/** Why a row was set aside — a stable code for tests and the Excel filter. */
export type ExtractionNoteReason =
  /** Has a weight but no supplier and/or no truck plate of its own, and is not a recovery. */
  | "no_own_supplier_or_plate"
  /** Recovery-shaped (no plate/batch/block) but NOT directly below a delivery. */
  | "recovery_not_adjacent"
  /** Recovery-shaped and adjacent, but carries no sacks and no remark of its own. */
  | "recovery_no_evidence"
  /** Something is typed in the Weight column, but it is not a number. */
  | "weight_not_a_number"
  /** A delivery-shaped row whose weight is zero or negative. */
  | "weight_not_positive"
  /** A delivery-shaped row heavier than {@link DELIVERY_WEIGHT_CAP_KG}. */
  | "weight_above_cap";

export interface ExtractionNote {
  kind: ExtractionNoteKind;
  reason_code: ExtractionNoteReason;
  report_type: "deliveries";
  sheet: string;
  source_row: number;
  /**
   * The row's OWN date cell, or — when blank — the nearest date above it (the one the
   * extractor would have forward-filled). CONTEXT ONLY, never a claim that the row is a
   * delivery on that day; `date_is_own` says which.
   */
  context_date: string | null;
  date_is_own: boolean;
  /** The row's non-empty cells among columns 1–8 and 16, keyed by header label. */
  cells: Record<string, string>;
  /** The Weight cell as a number when it parses, else null. */
  weight_kg: number | null;
  supplier: string | null;
  truck_plate: string | null;
  batch_label: string | null;
  block_loc: string | null;
  /** The tab's first Average/Total/Sum row, when one exists above this row. */
  summary_row: number | null;
  below_summary_row: boolean;
  /** For `weight_out_of_range` only: the cap that was applied. */
  cap_kg?: number;
  /** Plain-English "what and why", written once here so every surface says the same thing. */
  detail: string;
}

/** Header labels for the columns a note echoes (MC's fixed column map, specs §2). */
export const NOTE_COLUMN_LABELS: ReadonlyArray<[number, string]> = [
  [1, "Date analyzed"],
  [2, "Date"],
  [3, "Supplier"],
  [4, "Block label"],
  [5, "Block/Loc"],
  [6, "Truck plate"],
  [7, "Weight (kg)"],
  [8, "Sacks"],
  [16, "Remarks"],
];

function fmtKg(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "?";
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 3 })} kg`;
}

function where(n: Pick<ExtractionNote, "sheet" | "source_row">): string {
  return `Row ${n.source_row} of the "${n.sheet}" tab`;
}

function belowPhrase(n: Pick<ExtractionNote, "summary_row" | "below_summary_row" | "source_row">): string {
  if (!n.below_summary_row || n.summary_row === null) return "";
  const gap = n.source_row - n.summary_row;
  return (
    ` It sits ${gap} row${gap === 1 ? "" : "s"} below the tab's Average row (row ` +
    `${n.summary_row}), i.e. outside the table — it looks like a working note or a sum ` +
    `typed underneath.`
  );
}

/** The sentence for a `stray_row`. Built once so the panel and the workbook agree. */
export function strayRowDetail(
  n: Omit<ExtractionNote, "detail" | "kind">,
): string {
  const cellList = Object.entries(n.cells)
    .map(([k, v]) => `${k} = ${v}`)
    .join("; ");
  const what =
    n.reason_code === "weight_not_a_number"
      ? `has something in the Weight column that is not a number`
      : n.weight_kg !== null
        ? `has ${fmtKg(n.weight_kg)} in the Weight column`
        : `has a weight`;
  const missing =
    n.reason_code === "recovery_not_adjacent"
      ? `but no supplier, truck plate or pile of its own, and it is not directly under a ` +
        `delivery it could belong to (a wet-sack split always sits on the very next row)`
      : n.reason_code === "recovery_no_evidence"
        ? `but no supplier, truck plate or pile of its own, and — unlike a real wet-sack ` +
          `split — no sack count and no remark either`
        : n.reason_code === "weight_not_a_number"
          ? `and no supplier or truck plate where they belong — the cells may have been ` +
            `typed one column off`
          : `but ${[
              n.supplier ? null : "no supplier",
              n.truck_plate ? null : "no truck plate",
            ]
              .filter(Boolean)
              .join(" and ")} of its own`;
  return (
    `${where(n)} ${what} ${missing}, so it was NOT treated as a delivery and nothing was ` +
    `saved for it.${belowPhrase(n)} Cells on the row: ${cellList || "(none readable)"}. ` +
    `If it is a real truckload, fill in its supplier and plate on the table's own rows and ` +
    `the next run will pick it up; if it is a note, nothing needs doing.`
  );
}

/** The sentence for a `weight_out_of_range`. */
export function weightOutOfRangeDetail(
  n: Omit<ExtractionNote, "detail" | "kind">,
): string {
  const who = [n.supplier, n.truck_plate, n.batch_label].filter(Boolean).join(" · ");
  const why =
    n.reason_code === "weight_not_positive"
      ? `a weight of ${fmtKg(n.weight_kg)}, which is not a delivery (a truckload weighs ` +
        `more than nothing)`
      : `a weight of ${fmtKg(n.weight_kg)}, above the ${fmtKg(n.cap_kg ?? DELIVERY_WEIGHT_CAP_KG)} ` +
        `ceiling — the heaviest truckload ever recorded is 36,069 kg`;
  return (
    `${where(n)}${who ? ` (${who})` : ""} has ${why}. It was NOT saved. This is almost ` +
    `always a typo in the Weight cell (an extra digit, or a total typed on the wrong row) — ` +
    `correct the cell and the next run will record the delivery.${belowPhrase(n)}`
  );
}
