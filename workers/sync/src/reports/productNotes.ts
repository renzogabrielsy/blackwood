/**
 * productNotes.ts — THE one constructor for every operator-facing note the `products`
 * report raises about the SHAPE of the sheet (as opposed to its numbers).
 *
 * One module, the way `deliveryHumanEdit.ts` is one module, so a grade that was added
 * and a grade that was renamed can never read as two unrelated problems built by two
 * different hands.
 *
 * NOTHING HERE IS HELD. There is no durable case to close by hand: the moment the tab
 * names line up again, every one of these stops firing on its own. Same posture as
 * `sourceTabs.ts` and `reportNotReceived.ts`.
 *
 * NO PESO ANYWHERE — this sheet has no prices in it at all.
 */

export type ProductNoteKind =
  | "product_grade_added"
  | "product_grade_renamed"
  | "product_grade_ambiguous"
  | "product_sheet_missing";

/** Mirrors `app/(app)/sync/types.ts::ProductNote`. */
export interface ProductNote {
  kind: ProductNoteKind;
  /** The tab as currently named (for `product_sheet_missing`, as it was last known). */
  sheet_name: string;
  /** Canonical code. */
  code: string;
  /** rename only — what the product used to be called. */
  previous_sheet_name?: string | null;
  previous_code?: string | null;
  /** rename only — WHICH RUNG decided it. `fingerprint` is certainty; `row_overlap` is
   *  an inference and carries its own percentage so a person can judge it. */
  rename_evidence?: "fingerprint" | "row_overlap" | null;
  /** rename via row overlap only — 0..100, rounded to one decimal. */
  rename_overlap_pct?: number | null;
  /** ambiguous only — every absent grade that matched. Naming them is the whole value:
   *  a person can settle in one glance what the machine correctly refused to guess. */
  candidates?: string[];
  /** Movements the tab carries. */
  movement_count?: number;
  /** What the apply actually wrote for this grade. */
  inserted?: number;
  deleted?: number;
}

export function productGradeAdded(args: {
  sheetName: string;
  code: string;
  movementCount: number;
  inserted: number;
}): ProductNote {
  return {
    kind: "product_grade_added",
    sheet_name: args.sheetName,
    code: args.code,
    movement_count: args.movementCount,
    inserted: args.inserted,
    deleted: 0,
  };
}

export function productGradeRenamed(args: {
  sheetName: string;
  code: string;
  previousSheetName: string;
  previousCode: string;
  evidence: "fingerprint" | "row_overlap";
  /** 0..1 fraction from the classifier; rendered as a percentage here. */
  overlap?: number;
  movementCount: number;
  inserted: number;
  deleted: number;
}): ProductNote {
  return {
    kind: "product_grade_renamed",
    sheet_name: args.sheetName,
    code: args.code,
    previous_sheet_name: args.previousSheetName,
    previous_code: args.previousCode,
    rename_evidence: args.evidence,
    rename_overlap_pct:
      args.overlap == null ? null : Math.round(args.overlap * 1000) / 10,
    movement_count: args.movementCount,
    inserted: args.inserted,
    deleted: args.deleted,
  };
}

export function productGradeAmbiguous(args: {
  sheetName: string;
  code: string;
  candidates: readonly string[];
  movementCount: number;
}): ProductNote {
  return {
    kind: "product_grade_ambiguous",
    sheet_name: args.sheetName,
    code: args.code,
    candidates: args.candidates.map(String),
    movement_count: args.movementCount,
  };
}

export function productSheetMissing(args: {
  sheetName: string;
  code: string;
}): ProductNote {
  return {
    kind: "product_sheet_missing",
    sheet_name: args.sheetName,
    code: args.code,
  };
}
