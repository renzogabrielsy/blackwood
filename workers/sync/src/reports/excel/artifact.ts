/**
 * artifact.ts — the ReportArtifact pointer type, alone in its own module.
 *
 * It lives here rather than in `generate.ts` so `reconcile/rcOutStage.ts` (which owns
 * `ReconciliationChannel`) can reference the shape without importing the generator, and
 * therefore without dragging exceljs + the Supabase Storage client into the reconciliation
 * module graph. Type-only, zero imports, zero runtime cost.
 *
 * MIRRORED app-side by `app/(app)/sync/types.ts::ReportArtifact` — keep the two in lockstep.
 */

/**
 * A pointer to the Excel sync report generated for one run. Written to
 * `sync_runs.result.reconciliation.report_artifact` on EVERY terminal run.
 *
 * NEVER carries a ₱ value. `contains_prices` is a CLAIM ABOUT the workbook (does it hold
 * price data?), which is what makes the download gate decidable — it is not a price.
 */
export interface ReportArtifact {
  ok: boolean;
  /** Storage bucket + object path. Absent exactly when `ok` is false. */
  bucket?: string | null;
  path?: string | null;
  filename?: string | null;
  bytes?: number | null;
  /** Sheet name -> DATA row count (header excluded). */
  sheet_counts?: Record<string, number>;
  finding_count?: number;
  warn_count?: number;
  error_count?: number;
  /**
   * TRUE = the workbook carries ₱ data, so the download is price-gated. The generator
   * writes FALSE only after its cost-key strip ran over every cell it emitted; anything
   * that cannot make that assertion leaves it TRUE and the gate engages (fail-closed —
   * see the `sync_run_reports.contains_prices` column comment).
   */
  contains_prices?: boolean;
  /** Why generation failed, in plain words. Only set when `ok` is false. */
  error?: string | null;
}
